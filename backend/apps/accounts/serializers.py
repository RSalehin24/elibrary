from base64 import b32encode
from io import BytesIO
from urllib.parse import urlparse

from django.conf import settings
from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.core.exceptions import ValidationError as DjangoValidationError
from django.utils.crypto import get_random_string
from django.utils.encoding import force_bytes, force_str
from django.utils.http import urlsafe_base64_encode, urlsafe_base64_decode
from django.template import TemplateDoesNotExist, loader
from django.utils.html import strip_tags
from django.utils.translation import gettext_lazy as _
from rest_framework import serializers

from apps.access.models import ACCOUNT_MANAGEABLE_PERMISSION_SCOPES, PermissionGrant
from apps.accounts.models import User


MANAGEABLE_PERMISSION_SCOPES = list(ACCOUNT_MANAGEABLE_PERMISSION_SCOPES)
MANAGEABLE_PERMISSION_SCOPE_VALUES = {scope.value for scope in ACCOUNT_MANAGEABLE_PERMISSION_SCOPES}


def build_qr_svg(data):
    try:
        import qrcode
        import qrcode.image.svg
    except ImportError:
        return ""

    image = qrcode.make(data, image_factory=qrcode.image.svg.SvgPathImage)
    buffer = BytesIO()
    image.save(buffer)
    return buffer.getvalue().decode("utf-8")


def sync_global_grants(user, scope_values, actor=None):
    cleaned_scopes = sorted({scope for scope in scope_values if scope in MANAGEABLE_PERMISSION_SCOPE_VALUES})
    PermissionGrant.objects.filter(
        user=user,
        book__isnull=True,
        category__isnull=True,
        contributor__isnull=True,
        scope__in=MANAGEABLE_PERMISSION_SCOPE_VALUES,
    ).exclude(scope__in=cleaned_scopes).delete()

    existing_scopes = set(
        PermissionGrant.objects.active_for_user(user)
        .filter(
            book__isnull=True,
            category__isnull=True,
            contributor__isnull=True,
            scope__in=MANAGEABLE_PERMISSION_SCOPE_VALUES,
        )
        .values_list("scope", flat=True)
    )
    for scope in cleaned_scopes:
        if scope in existing_scopes:
            continue
        PermissionGrant.objects.create(
            user=user,
            scope=scope,
            granted_by=actor,
            notes="Managed from the user administration workflow.",
        )


def send_password_reset_email(
    email,
    *,
    request,
    subject_template_name,
    email_template_name,
    extra_email_context=None,
):
    user_model = get_user_model()
    invited_user = (
        user_model._default_manager.filter(email__iexact=email, is_active=True)
        .order_by("pk")
        .first()
    )
    if invited_user is None:
        return

    use_https = request.is_secure() or settings.FRONTEND_BASE_URL.startswith("https://")
    protocol = "https" if use_https else "http"
    domain = request.get_host()
    site_name = domain
    token_generator = PasswordResetTokenGenerator()
    uid = urlsafe_base64_encode(force_bytes(invited_user.pk))
    token = token_generator.make_token(invited_user)

    configured_frontend_base_url = (getattr(settings, "FRONTEND_BASE_URL", "") or "").rstrip("/")
    request_frontend_base_url = f"{protocol}://{domain}".rstrip("/")

    frontend_base_url = configured_frontend_base_url or request_frontend_base_url
    configured_host = (urlparse(configured_frontend_base_url).hostname or "").lower()
    request_host = (urlparse(request_frontend_base_url).hostname or "").lower()
    localhost_hosts = {"localhost", "127.0.0.1"}
    if configured_host in localhost_hosts and request_host in localhost_hosts:
        frontend_base_url = request_frontend_base_url

    reset_url = f"{frontend_base_url}{settings.PASSWORD_RESET_FRONTEND_PATH}?uid={uid}&token={token}"

    email_context = {
        "email": invited_user.email,
        "domain": domain,
        "site_name": site_name,
        "uid": uid,
        "user": invited_user,
        "token": token,
        "protocol": protocol,
        "frontend_reset_url": f"{frontend_base_url}{settings.PASSWORD_RESET_FRONTEND_PATH}",
        "frontend_reset_full_url": reset_url,
        **(extra_email_context or {}),
    }

    subject = loader.render_to_string(subject_template_name, email_context)
    subject = " ".join(subject.splitlines()).strip()
    html_body = loader.render_to_string(email_template_name, email_context)
    text_template_name = f"{email_template_name.rsplit('.', 1)[0]}.txt"
    try:
        text_body = loader.render_to_string(text_template_name, email_context)
    except TemplateDoesNotExist:
        text_body = strip_tags(html_body)

    message = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[invited_user.email],
    )
    message.attach_alternative(html_body, "text/html")
    delivered = message.send(fail_silently=False)
    if delivered < 1:
        raise RuntimeError("Invite email could not be delivered.")


class UserSerializer(serializers.ModelSerializer):
    totp_enabled = serializers.BooleanField(source="has_totp_enabled", read_only=True)
    totp_required = serializers.BooleanField(read_only=True)
    totp_setup_required = serializers.BooleanField(source="requires_totp_setup", read_only=True)
    capabilities = serializers.ListField(source="capability_scopes", child=serializers.CharField(), read_only=True)
    profile_image_url = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "full_name",
            "profile_image_url",
            "is_active",
            "is_staff",
            "is_superuser",
            "totp_enabled",
            "totp_required",
            "totp_setup_required",
            "capabilities",
        ]

    def get_profile_image_url(self, obj):
        if not obj.profile_image:
            return ""
        request = self.context.get("request")
        if request is not None:
            return request.build_absolute_uri(obj.profile_image.url)
        return obj.profile_image.url


class SessionSerializer(serializers.Serializer):
    authenticated = serializers.BooleanField()
    user = UserSerializer(allow_null=True)


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=12)

    class Meta:
        model = User
        fields = ["email", "full_name", "password"]

    def create(self, validated_data):
        password = validated_data.pop("password")
        return User.objects.create_user(password=password, **validated_data)


class ManagedUserSerializer(UserSerializer):
    grant_count = serializers.SerializerMethodField()
    global_scopes = serializers.ListField(source="global_grant_scopes", child=serializers.CharField(), read_only=True)

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ["grant_count", "global_scopes"]

    def get_grant_count(self, obj):
        return obj.permission_grants.count()


class ManagedUserCreateSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=12, required=False, allow_blank=True, trim_whitespace=False)
    is_active = serializers.BooleanField(default=True)
    totp_required = serializers.BooleanField(default=False)
    send_invite_email = serializers.BooleanField(default=True, required=False, write_only=True)
    global_scopes = serializers.ListField(
        child=serializers.ChoiceField(choices=[scope.value for scope in MANAGEABLE_PERMISSION_SCOPES]),
        required=False,
        allow_empty=True,
    )

    class Meta:
        model = User
        fields = ["email", "full_name", "password", "is_active", "totp_required", "send_invite_email", "global_scopes"]

    def validate_global_scopes(self, value):
        if not value:
            raise serializers.ValidationError("Select at least one account permission.")
        return value

    def validate(self, attrs):
        password = (attrs.get("password") or "").strip()
        send_invite_email = attrs.get("send_invite_email", True)

        if not password and not send_invite_email:
            raise serializers.ValidationError({"password": "Set a password or send an invite email."})
        if send_invite_email and not attrs.get("is_active", True):
            raise serializers.ValidationError({"is_active": "Activate the account before sending an invite email."})
        return attrs

    def create(self, validated_data):
        password = (validated_data.pop("password", "") or "").strip()
        send_invite_email = validated_data.pop("send_invite_email", True)
        global_scopes = validated_data.pop("global_scopes", [])
        request = self.context["request"]

        with transaction.atomic():
            user = User.objects.create_user(password=password or get_random_string(24), **validated_data)
            sync_global_grants(user, global_scopes, actor=request.user)
            if send_invite_email:
                try:
                    send_password_reset_email(
                        user.email,
                        request=request,
                        subject_template_name="registration/account_invite_subject.txt",
                        email_template_name="registration/account_invite_email.html",
                        extra_email_context={
                            "invited_user": user,
                            "invited_by": request.user,
                        },
                    )
                except Exception as exc:
                    raise serializers.ValidationError(
                        {
                            "send_invite_email": "Invite email could not be delivered. Verify SMTP host, port, username, password, and sender domain."
                        }
                    ) from exc
        return user


class ManagedUserUpdateSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=12, required=False, allow_blank=False)
    global_scopes = serializers.ListField(
        child=serializers.ChoiceField(choices=[scope.value for scope in MANAGEABLE_PERMISSION_SCOPES]),
        required=False,
        allow_empty=True,
    )

    class Meta:
        model = User
        fields = ["email", "full_name", "is_active", "password", "totp_required", "global_scopes"]

    def validate_global_scopes(self, value):
        if value == []:
            raise serializers.ValidationError("Select at least one account permission.")
        return value

    def update(self, instance, validated_data):
        password = validated_data.pop("password", "")
        global_scopes = validated_data.pop("global_scopes", None)
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if password:
            instance.set_password(password)
        instance.save()
        if global_scopes is not None:
            sync_global_grants(instance, global_scopes, actor=self.context["request"].user)
        return instance


class ProfileSerializer(UserSerializer):
    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields


class ProfileUpdateSerializer(serializers.ModelSerializer):
    profile_image = serializers.FileField(required=False, allow_null=True)
    remove_profile_image = serializers.BooleanField(required=False, default=False, write_only=True)
    current_password = serializers.CharField(write_only=True, required=False, allow_blank=False, trim_whitespace=False)
    new_password = serializers.CharField(write_only=True, required=False, allow_blank=False, trim_whitespace=False)
    confirm_new_password = serializers.CharField(
        write_only=True,
        required=False,
        allow_blank=False,
        trim_whitespace=False,
    )

    class Meta:
        model = User
        fields = [
            "full_name",
            "profile_image",
            "remove_profile_image",
            "current_password",
            "new_password",
            "confirm_new_password",
        ]

    def validate(self, attrs):
        current_password = attrs.get("current_password", "")
        new_password = attrs.get("new_password", "")
        confirm_new_password = attrs.get("confirm_new_password", "")
        has_password_change = any([current_password, new_password, confirm_new_password])

        if not has_password_change:
            return attrs

        if not current_password:
            raise serializers.ValidationError({"current_password": "Enter your current password."})
        if not self.instance.check_password(current_password):
            raise serializers.ValidationError({"current_password": "Current password is incorrect."})
        if not new_password:
            raise serializers.ValidationError({"new_password": "Enter a new password."})
        if not confirm_new_password:
            raise serializers.ValidationError({"confirm_new_password": "Confirm your new password."})
        if new_password != confirm_new_password:
            raise serializers.ValidationError({"confirm_new_password": "The new password fields must match."})
        if self.instance.check_password(new_password):
            raise serializers.ValidationError({"new_password": "Choose a different password."})

        try:
            validate_password(new_password, self.instance)
        except DjangoValidationError as exc:
            raise serializers.ValidationError({"new_password": list(exc.messages)}) from exc

        return attrs

    def update(self, instance, validated_data):
        remove_profile_image = validated_data.pop("remove_profile_image", False)
        profile_image = validated_data.pop("profile_image", None)
        validated_data.pop("current_password", "")
        new_password = validated_data.pop("new_password", "")
        validated_data.pop("confirm_new_password", "")
        self.password_changed = False

        if remove_profile_image and instance.profile_image:
            instance.profile_image.delete(save=False)
            instance.profile_image = None

        if profile_image is not None:
            if instance.profile_image:
                instance.profile_image.delete(save=False)
            instance.profile_image = profile_image

        for field, value in validated_data.items():
            setattr(instance, field, value)

        if new_password:
            instance.set_password(new_password)
            self.password_changed = True

        instance.save()
        return instance


class LoginSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)
    otp_token = serializers.CharField(required=False, allow_blank=True, write_only=True)

    default_error_messages = {
        "invalid_credentials": _("Invalid email or password."),
        "otp_required": _("A valid TOTP code is required for this account."),
        "otp_invalid": _("The supplied TOTP code is invalid."),
    }

    def raise_login_error(self, code):
        raise serializers.ValidationError(
            {
                "detail": self.error_messages[code],
                "code": code,
            }
        )

    def validate(self, attrs):
        request = self.context["request"]
        email = attrs["email"]
        password = attrs["password"]
        otp_token = attrs.get("otp_token", "").strip()

        user = authenticate(request=request, email=email, password=password)
        if user is None:
            self.raise_login_error("invalid_credentials")

        if user.has_totp_enabled:
            if not otp_token:
                self.raise_login_error("otp_required")

            from django_otp.plugins.otp_totp.models import TOTPDevice

            device = TOTPDevice.objects.filter(user=user, confirmed=True).first()
            if device is None or not device.verify_token(otp_token):
                self.raise_login_error("otp_invalid")

        attrs["user"] = user
        return attrs


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()

    def save(self):
        send_password_reset_email(
            self.validated_data["email"],
            request=self.context["request"],
            subject_template_name="registration/password_reset_subject.txt",
            email_template_name="registration/password_reset_email.html",
        )


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.CharField()
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True, min_length=12)

    def validate(self, attrs):
        UserModel = get_user_model()
        try:
            user_id = force_str(urlsafe_base64_decode(attrs["uid"]))
            user = UserModel.objects.get(pk=user_id)
        except Exception as exc:
            raise serializers.ValidationError("Invalid reset link.") from exc

        token_generator = PasswordResetTokenGenerator()
        if not token_generator.check_token(user, attrs["token"]):
            raise serializers.ValidationError("Reset token is invalid or expired.")

        attrs["user"] = user
        return attrs

    def save(self):
        user = self.validated_data["user"]
        user.set_password(self.validated_data["new_password"])
        user.save(update_fields=["password"])
        return user


class TOTPStatusSerializer(serializers.Serializer):
    enabled = serializers.BooleanField()
    pending_setup = serializers.BooleanField()
    required = serializers.BooleanField()
    setup_required = serializers.BooleanField()


class TOTPSetupSerializer(serializers.Serializer):
    provisioning_uri = serializers.CharField()
    secret = serializers.CharField()
    qr_svg = serializers.CharField()

    @staticmethod
    def from_device(device):
        provisioning_uri = device.config_url
        secret = b32encode(device.bin_key).decode("utf-8").rstrip("=")
        return {
            "provisioning_uri": provisioning_uri,
            "secret": secret,
            "qr_svg": build_qr_svg(provisioning_uri),
        }


class TOTPConfirmSerializer(serializers.Serializer):
    token = serializers.CharField()
