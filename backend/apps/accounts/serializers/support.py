from base64 import b32encode
from io import BytesIO
from urllib.parse import urlparse

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.template import TemplateDoesNotExist, loader
from django.utils.crypto import get_random_string
from django.utils.encoding import force_bytes
from django.utils.html import strip_tags
from django.utils.http import urlsafe_base64_encode
from rest_framework import serializers

from apps.access.models import ACCOUNT_MANAGEABLE_PERMISSION_SCOPES, PermissionGrant
from apps.accounts.models import User


MANAGEABLE_PERMISSION_SCOPES = list(ACCOUNT_MANAGEABLE_PERMISSION_SCOPES)
MANAGEABLE_PERMISSION_SCOPE_VALUES = {
    scope.value for scope in ACCOUNT_MANAGEABLE_PERMISSION_SCOPES
}


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
    cleaned_scopes = sorted(
        {scope for scope in scope_values if scope in MANAGEABLE_PERMISSION_SCOPE_VALUES}
    )
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
        "site_name": domain,
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
        from_email=getattr(
            settings,
            "ACCOUNT_INVITE_FROM_EMAIL",
            settings.DEFAULT_FROM_EMAIL,
        ),
        to=[invited_user.email],
    )
    message.attach_alternative(html_body, "text/html")
    delivered = message.send(fail_silently=False)
    if delivered < 1:
        raise RuntimeError("Invite email could not be delivered.")


def create_managed_user(validated_data, *, request):
    password = (validated_data.pop("password", "") or "").strip()
    send_invite_email = validated_data.pop("send_invite_email", True)
    global_scopes = validated_data.pop("global_scopes", [])

    with transaction.atomic():
        user = User.objects.create_user(
            password=password or get_random_string(24),
            **validated_data,
        )
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
                        "send_invite_email": (
                            "Invite email could not be delivered. For Brevo, verify "
                            "BREVO_API_KEY and that ACCOUNT_INVITE_FROM_EMAIL/DEFAULT_FROM_EMAIL "
                            "is a verified sender."
                        )
                    }
                ) from exc
    return user
