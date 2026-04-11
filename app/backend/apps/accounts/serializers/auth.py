from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode
from django.utils.translation import gettext_lazy as _
from rest_framework import serializers

from .support import send_password_reset_email


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
        raise serializers.ValidationError({"detail": self.error_messages[code], "code": code})

    def validate(self, attrs):
        request = self.context["request"]
        user = authenticate(request=request, email=attrs["email"], password=attrs["password"])
        if user is None:
            self.raise_login_error("invalid_credentials")
        otp_token = attrs.get("otp_token", "").strip()
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
