from base64 import b32encode

from django.conf import settings
from django.contrib.auth import authenticate
from django.contrib.auth.forms import PasswordResetForm
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.contrib.auth import get_user_model
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode
from django.utils.translation import gettext_lazy as _
from rest_framework import serializers

from apps.accounts.models import User


class UserSerializer(serializers.ModelSerializer):
    totp_enabled = serializers.BooleanField(source="has_totp_enabled", read_only=True)
    capabilities = serializers.ListField(source="capability_scopes", child=serializers.CharField(), read_only=True)

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "full_name",
            "is_staff",
            "is_superuser",
            "totp_enabled",
            "capabilities",
        ]


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

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ["is_active", "grant_count"]

    def get_grant_count(self, obj):
        return obj.permission_grants.count()


class ManagedUserCreateSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=12)
    is_active = serializers.BooleanField(default=True)

    class Meta:
        model = User
        fields = ["email", "full_name", "password", "is_active"]

    def create(self, validated_data):
        password = validated_data.pop("password")
        return User.objects.create_user(password=password, **validated_data)


class ManagedUserUpdateSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=12, required=False, allow_blank=False)

    class Meta:
        model = User
        fields = ["full_name", "is_active", "password"]

    def update(self, instance, validated_data):
        password = validated_data.pop("password", "")
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if password:
            instance.set_password(password)
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
        request = self.context["request"]
        form = PasswordResetForm(data=self.validated_data)
        if form.is_valid():
            form.save(
                request=request,
                use_https=request.is_secure(),
                from_email=settings.DEFAULT_FROM_EMAIL,
                email_template_name="registration/password_reset_email.html",
                subject_template_name="registration/password_reset_subject.txt",
                extra_email_context={
                    "frontend_reset_url": (
                        f"{settings.FRONTEND_BASE_URL.rstrip('/')}{settings.PASSWORD_RESET_FRONTEND_PATH}"
                    )
                },
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


class TOTPSetupSerializer(serializers.Serializer):
    provisioning_uri = serializers.CharField()
    secret = serializers.CharField()

    @staticmethod
    def from_device(device):
        secret = b32encode(device.bin_key).decode("utf-8").rstrip("=")
        return {
            "provisioning_uri": device.config_url,
            "secret": secret,
        }


class TOTPConfirmSerializer(serializers.Serializer):
    token = serializers.CharField()
