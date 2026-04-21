import json
import re
from datetime import datetime, timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import pytest
from django.contrib.auth.tokens import PasswordResetTokenGenerator
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework.test import APIClient

from apps.access.models import PermissionGrant, PermissionScope
from apps.accounts.models import User
from apps.accounts.serializers.support import (
    PasswordLinkTokenGenerator,
    password_link_token_generator,
)


def extract_password_link_params(message_body, path):
    match = re.search(
        rf"https?://[^ ]+{re.escape(path)}\?uid=[^ \n]+&token=[^ \n]+",
        message_body,
    )
    assert match is not None
    parsed = urlparse(match.group(0))
    params = parse_qs(parsed.query)
    return params["uid"][0], params["token"][0]


def extract_setup_link_params(message_body):
    return extract_password_link_params(message_body, "/create-password")


def extract_reset_link_params(message_body):
    return extract_password_link_params(message_body, "/reset-password/confirm")


def build_totp_token(device):
    return str(
        totp(
            device.bin_key,
            step=device.step,
            t0=device.t0,
            digits=device.digits,
            drift=device.drift,
        )
    ).zfill(device.digits)


@pytest.mark.django_db
def test_email_login_requires_totp_when_enabled(client):
    user = User.objects.create_user(
        email="reader@example.com",
        password="strong-password-123",
        full_name="Reader",
    )

    response = client.post(
        "/api/auth/login/",
        data=json.dumps({"email": user.email, "password": "strong-password-123"}),
        content_type="application/json",
    )
    assert response.status_code == 200

    client.post("/api/auth/logout/")

    device = TOTPDevice.objects.create(user=user, name="default", confirmed=True)
    missing_token = client.post(
        "/api/auth/login/",
        data=json.dumps({"email": user.email, "password": "strong-password-123"}),
        content_type="application/json",
    )
    assert missing_token.status_code == 400
    assert missing_token.json()["code"] == "otp_required"

    token = build_totp_token(device)
    valid_token = client.post(
        "/api/auth/login/",
        data=json.dumps(
            {
                "email": user.email,
                "password": "strong-password-123",
                "otp_token": token,
            }
        ),
        content_type="application/json",
    )
    assert valid_token.status_code == 200
    assert valid_token.json()["email"] == user.email


@pytest.mark.django_db
def test_only_superadmin_can_create_managed_users(client):
    superadmin = User.objects.create_superuser(
        email="superadmin@example.com",
        password="strong-password-123",
    )
    regular_user = User.objects.create_user(
        email="member@example.com",
        password="strong-password-123",
    )

    client.force_login(regular_user)
    denied = client.post(
        "/api/auth/users/",
        data=json.dumps(
            {
                "email": "created@example.com",
                "full_name": "Created User",
                "password": "strong-password-456",
                "is_active": True,
            }
        ),
        content_type="application/json",
    )
    assert denied.status_code == 403

    client.force_login(superadmin)
    created = client.post(
        "/api/auth/users/",
        data=json.dumps(
            {
                "email": "created@example.com",
                "full_name": "Created User",
                "password": "strong-password-456",
                "is_active": True,
                "global_scopes": ["read:durable"],
            }
        ),
        content_type="application/json",
    )
    assert created.status_code == 201
    assert User.objects.filter(email="created@example.com", is_superuser=False, is_staff=False).exists()


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    FRONTEND_BASE_URL="http://127.0.0.1:5173",
    FRONTEND_PORT="5173",
)
def test_superadmin_can_create_managed_user_and_send_invite_email(client):
    superadmin = User.objects.create_superuser(
        email="superadmin@example.com",
        password="strong-password-123",
        full_name="Super Admin",
    )
    client.force_login(superadmin)

    created = client.post(
        "/api/auth/users/",
        data=json.dumps(
            {
                "email": "invited@example.com",
                "full_name": "Invited User",
                "is_active": True,
                "send_invite_email": True,
                "global_scopes": ["read:durable"],
            }
        ),
        content_type="application/json",
    )

    assert created.status_code == 201
    invited_user = User.objects.get(email="invited@example.com")
    assert invited_user.check_password("") is False
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == ["invited@example.com"]
    assert "Your RSalehin24 Library account is ready" in mail.outbox[0].subject
    assert "http://127.0.0.1:5173/create-password?uid=" in mail.outbox[0].body
    assert "&amp;" not in mail.outbox[0].body

    html_body, html_mimetype = mail.outbox[0].alternatives[0]
    assert html_mimetype == "text/html"
    assert "display: block;" in html_body
    assert "width: 100%;" in html_body
    assert "font-size: 18px" in html_body


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    FRONTEND_BASE_URL="http://localhost",
    FRONTEND_PORT="5173",
)
def test_invite_email_uses_frontend_port_when_frontend_base_url_omits_it(client):
    superadmin = User.objects.create_superuser(
        email="port-superadmin@example.com",
        password="strong-password-123",
        full_name="Super Admin",
    )
    client.force_login(superadmin)

    created = client.post(
        "/api/auth/users/",
        data=json.dumps(
            {
                "email": "port-invited@example.com",
                "full_name": "Invited User",
                "is_active": True,
                "send_invite_email": True,
                "global_scopes": ["read:durable"],
            }
        ),
        content_type="application/json",
    )

    assert created.status_code == 201
    assert len(mail.outbox) == 1
    assert "&amp;" not in mail.outbox[0].body

    reset_link_match = re.search(
        r"http://localhost:5173/create-password\?uid=[^ \n]+&token=[^ \n]+",
        mail.outbox[0].body,
    )
    assert reset_link_match is not None

    html_body, html_mimetype = mail.outbox[0].alternatives[0]
    assert html_mimetype == "text/html"
    assert "This is an automated message from localhost:5173." in html_body


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    FRONTEND_BASE_URL="http://127.0.0.1:5173",
    FRONTEND_PORT="5173",
    PASSWORD_RESET_TIMEOUT=6 * 60 * 60,
)
def test_password_reset_request_sends_reset_confirm_link_email(client):
    user = User.objects.create_user(
        email="reset-request@example.com",
        password="strong-password-123",
        full_name="Reset Request",
    )

    response = client.post(
        "/api/auth/password-reset/",
        data=json.dumps({"email": user.email}),
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["detail"] == "Reset email has been sent."
    assert len(mail.outbox) == 1
    assert mail.outbox[0].to == [user.email]
    assert (
        "http://127.0.0.1:5173/reset-password/confirm?uid=" in mail.outbox[0].body
    )
    assert (
        "This link stays valid for 6 hours from the time it was generated."
        in mail.outbox[0].body
    )
    assert "&amp;" not in mail.outbox[0].body

    html_body, html_mimetype = mail.outbox[0].alternatives[0]
    assert html_mimetype == "text/html"
    assert "Reset your password" in html_body
    assert "Reset Password" in html_body
    assert "This link stays valid for" in html_body
    assert "6 hours" in html_body
    assert "display: block;" in html_body
    assert "Reset password link:" in html_body
    assert "This is an automated message from 127.0.0.1:5173." in html_body


@pytest.mark.django_db
@override_settings(PASSWORD_RESET_TIMEOUT=6 * 60 * 60)
def test_password_reset_links_expire_after_six_hours(client):
    user = User.objects.create_user(
        email="reset-expiry@example.com",
        password="strong-password-123",
        full_name="Reset Expiry",
    )
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    generator = password_link_token_generator
    issued_at = datetime.now()

    with patch.object(PasswordLinkTokenGenerator, "_now", return_value=issued_at):
        token = generator.make_token(user)

    request_body = json.dumps({"uid": uid, "token": token})

    with patch.object(
        PasswordLinkTokenGenerator,
        "_now",
        return_value=issued_at + timedelta(hours=5, minutes=59),
    ):
        valid_response = client.post(
            "/api/auth/password-reset/validate/",
            data=request_body,
            content_type="application/json",
        )

    assert valid_response.status_code == 200
    assert valid_response.json()["detail"] == "Password link is valid."

    with patch.object(
        PasswordLinkTokenGenerator,
        "_now",
        return_value=issued_at + timedelta(hours=6, minutes=1),
    ):
        expired_response = client.post(
            "/api/auth/password-reset/validate/",
            data=request_body,
            content_type="application/json",
        )

    assert expired_response.status_code == 400
    assert expired_response.json()["detail"] == "Reset token is invalid or expired."


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    FRONTEND_BASE_URL="http://127.0.0.1:5173",
    FRONTEND_PORT="5173",
)
def test_latest_password_reset_request_invalidates_any_previous_reset_links(client):
    user = User.objects.create_user(
        email="repeat-reset@example.com",
        password="strong-password-123",
        full_name="Repeat Reset",
    )
    password_client = APIClient()

    first_response = client.post(
        "/api/auth/password-reset/",
        data=json.dumps({"email": user.email}),
        content_type="application/json",
    )
    second_response = client.post(
        "/api/auth/password-reset/",
        data=json.dumps({"email": user.email}),
        content_type="application/json",
    )

    assert first_response.status_code == 200
    assert second_response.status_code == 200
    assert len(mail.outbox) == 2

    first_uid, first_token = extract_reset_link_params(mail.outbox[0].body)
    second_uid, second_token = extract_reset_link_params(mail.outbox[1].body)

    assert first_uid == second_uid
    assert first_token != second_token

    first_validate = password_client.post(
        "/api/auth/password-reset/validate/",
        data=json.dumps({"uid": first_uid, "token": first_token}),
        content_type="application/json",
    )
    second_validate = password_client.post(
        "/api/auth/password-reset/validate/",
        data=json.dumps({"uid": second_uid, "token": second_token}),
        content_type="application/json",
    )

    assert first_validate.status_code == 400
    assert first_validate.json()["detail"] == "Reset token is invalid or expired."
    assert second_validate.status_code == 200
    assert second_validate.json()["detail"] == "Password link is valid."

    first_confirm = password_client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": first_uid,
                "token": first_token,
                "new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )
    second_confirm = password_client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": second_uid,
                "token": second_token,
                "new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert first_confirm.status_code == 400
    assert first_confirm.json()["detail"] == "Reset token is invalid or expired."
    assert second_confirm.status_code == 200
    assert second_confirm.json()["next_step"] == "login"

    user.refresh_from_db()
    assert user.check_password("strong-password-456") is True


@pytest.mark.django_db
def test_password_reset_confirm_returns_clean_short_password_error(client):
    user = User.objects.create_user(
        email="short-password@example.com",
        password="strong-password-123",
    )
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = PasswordResetTokenGenerator().make_token(user)

    response = client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": uid,
                "token": token,
                "new_password": "short",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Ensure this field has at least 12 characters."


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    FRONTEND_BASE_URL="http://127.0.0.1:5173",
    FRONTEND_PORT="5173",
)
def test_password_reset_request_omits_invited_users_with_pending_setup(client):
    invited_user = User.objects.create_user(
        email="pending-setup@example.com",
        password=None,
        full_name="Pending Setup",
        email_setup_pending=True,
    )

    response = client.post(
        "/api/auth/password-reset/",
        data=json.dumps({"email": invited_user.email}),
        content_type="application/json",
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "No user exist with this email."
    assert len(mail.outbox) == 0


@pytest.mark.django_db
def test_password_reset_request_returns_missing_user_message_when_email_is_unknown(client):
    response = client.post(
        "/api/auth/password-reset/",
        data=json.dumps({"email": "missing-user@example.com"}),
        content_type="application/json",
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "No user exist with this email."
    assert len(mail.outbox) == 0


@pytest.mark.django_db
def test_superadmin_can_create_update_and_delete_managed_users_with_grants_and_totp_policy(client):
    superadmin = User.objects.create_superuser(
        email="superadmin@example.com",
        password="strong-password-123",
    )
    client.force_login(superadmin)

    created = client.post(
        "/api/auth/users/",
        data=json.dumps(
            {
                "email": "managed@example.com",
                "full_name": "Managed User",
                "password": "strong-password-456",
                "is_active": True,
                "totp_required": True,
                "global_scopes": ["read:durable", "download:file"],
            }
        ),
        content_type="application/json",
    )

    assert created.status_code == 201
    managed_user = User.objects.get(email="managed@example.com")
    assert managed_user.totp_required is True
    assert set(
        PermissionGrant.objects.active_for_user(managed_user)
        .filter(book__isnull=True)
        .values_list("scope", flat=True)
    ) == {"read:durable", "download:file"}

    updated = client.patch(
        f"/api/auth/users/{managed_user.id}/",
        data=json.dumps(
            {
                "full_name": "Updated Managed User",
                "totp_required": False,
                "global_scopes": ["metadata:edit"],
            }
        ),
        content_type="application/json",
    )

    assert updated.status_code == 200
    managed_user.refresh_from_db()
    assert managed_user.full_name == "Updated Managed User"
    assert managed_user.totp_required is False
    assert set(
        PermissionGrant.objects.active_for_user(managed_user)
        .filter(book__isnull=True)
        .values_list("scope", flat=True)
    ) == {"metadata:edit"}

    deleted = client.delete(f"/api/auth/users/{managed_user.id}/")
    assert deleted.status_code == 204
    assert not User.objects.filter(id=managed_user.id).exists()


@pytest.mark.django_db
def test_managed_users_list_returns_offset_pagination_payload(client):
    superadmin = User.objects.create_superuser(
        email="paged-superadmin@example.com",
        password="strong-password-123",
    )
    client.force_login(superadmin)

    for index in range(75):
        User.objects.create_user(
            email=f"managed-user-{index:02d}@example.com",
            password="strong-password-123",
            full_name=f"Managed User {index:02d}",
        )

    response = client.get("/api/auth/users/?offset=0&limit=60")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["rows"]) == 60
    assert payload["pagination"] == {
        "offset": 0,
        "limit": 60,
        "totalCount": 76,
        "hasMore": True,
        "nextOffset": 60,
    }


@pytest.mark.django_db
def test_managed_users_list_supports_search_filter_and_sort(client):
    superadmin = User.objects.create_superuser(
        email="filter-superadmin@example.com",
        password="strong-password-123",
    )
    User.objects.create_user(
        email="alpha@example.com",
        password="strong-password-123",
        full_name="Alpha User",
        is_active=True,
    )
    disabled_user = User.objects.create_user(
        email="bravo@example.com",
        password="strong-password-123",
        full_name="Bravo User",
        is_active=False,
    )
    scoped_user = User.objects.create_user(
        email="metadata@example.com",
        password="strong-password-123",
        full_name="Metadata User",
        is_active=True,
        totp_required=True,
    )
    PermissionGrant.objects.create(
        user=scoped_user,
        scope=PermissionScope.METADATA_EDIT,
        granted_by=superadmin,
    )
    client.force_login(superadmin)

    disabled_response = client.get(
        "/api/auth/users/?status=disabled&sort=email_desc"
    )
    assert disabled_response.status_code == 200
    assert [row["email"] for row in disabled_response.json()["rows"]] == [
        "bravo@example.com",
    ]

    permission_response = client.get(
        "/api/auth/users/?q=metadata&status=all&sort=email_asc"
    )
    assert permission_response.status_code == 200
    assert [row["email"] for row in permission_response.json()["rows"]] == [
        "metadata@example.com",
    ]

    required_response = client.get(
        "/api/auth/users/?q=required&status=all&sort=name_asc"
    )
    assert required_response.status_code == 200
    assert [row["email"] for row in required_response.json()["rows"]] == [
        "metadata@example.com",
    ]


@pytest.mark.django_db
def test_superadmin_cannot_edit_own_account_from_managed_users_endpoint(client):
    superadmin = User.objects.create_superuser(
        email="self-edit-block@example.com",
        password="strong-password-123",
    )
    client.force_login(superadmin)

    response = client.patch(
        f"/api/auth/users/{superadmin.id}/",
        data=json.dumps(
            {
                "full_name": "Attempted Self Edit",
                "global_scopes": ["read:durable"],
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "You cannot edit your own account from Users & Access."


@pytest.mark.django_db
def test_password_reset_confirm_requires_logout_when_authenticated(client):
    user = User.objects.create_user(
        email="reset-auth-block@example.com",
        password="strong-password-123",
    )
    client.force_login(user)

    response = client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": "invalid",
                "token": "invalid",
                "new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Please log out first before resetting a password from this link."


@pytest.mark.django_db
def test_password_reset_confirm_logs_in_users_who_must_finish_totp_setup(client):
    user = User.objects.create_user(
        email="totp-reset@example.com",
        password="strong-password-123",
        totp_required=True,
    )
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = PasswordResetTokenGenerator().make_token(user)

    response = client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": uid,
                "token": token,
                "new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["next_step"] == "totp_setup"
    assert response.json()["user"]["totp_setup_required"] is True

    user.refresh_from_db()
    assert user.check_password("strong-password-456") is True

    session_response = client.get("/api/auth/session/")
    assert session_response.status_code == 200
    assert session_response.json()["authenticated"] is True
    assert session_response.json()["user"]["totp_setup_required"] is True


@pytest.mark.django_db
def test_password_reset_confirm_keeps_other_users_logged_out(client):
    user = User.objects.create_user(
        email="plain-reset@example.com",
        password="strong-password-123",
    )
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = PasswordResetTokenGenerator().make_token(user)

    response = client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": uid,
                "token": token,
                "new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    assert response.json()["next_step"] == "login"

    user.refresh_from_db()
    assert user.check_password("strong-password-456") is True

    session_response = client.get("/api/auth/session/")
    assert session_response.status_code == 200
    assert session_response.json()["authenticated"] is False


@pytest.mark.django_db
def test_password_reset_confirm_rejects_reused_token_after_password_is_set(client):
    user = User.objects.create_user(
        email="single-use-link@example.com",
        password="strong-password-123",
    )
    uid = urlsafe_base64_encode(force_bytes(user.pk))
    token = PasswordResetTokenGenerator().make_token(user)
    payload = {
        "uid": uid,
        "token": token,
        "new_password": "strong-password-456",
    }

    first_response = client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(payload),
        content_type="application/json",
    )

    assert first_response.status_code == 200
    assert first_response.json()["next_step"] == "login"

    validate_response = client.post(
        "/api/auth/password-reset/validate/",
        data=json.dumps({"uid": uid, "token": token}),
        content_type="application/json",
    )

    assert validate_response.status_code == 400
    assert validate_response.json()["detail"] == "Reset token is invalid or expired."

    second_response = client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(payload),
        content_type="application/json",
    )

    assert second_response.status_code == 400
    assert second_response.json()["detail"] == "Reset token is invalid or expired."

    user.refresh_from_db()
    assert user.check_password("strong-password-456") is True


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    FRONTEND_BASE_URL="http://127.0.0.1:5173",
    FRONTEND_PORT="5173",
)
def test_resending_setup_email_invalidates_previous_create_password_link(client):
    superadmin = User.objects.create_superuser(
        email="resend-superadmin@example.com",
        password="strong-password-123",
    )
    activation_client = APIClient()
    client.force_login(superadmin)

    created = client.post(
        "/api/auth/users/",
        data=json.dumps(
            {
                "email": "resend-target@example.com",
                "full_name": "Resend Target",
                "is_active": True,
                "send_invite_email": True,
                "global_scopes": ["read:durable"],
            }
        ),
        content_type="application/json",
    )

    assert created.status_code == 201
    assert len(mail.outbox) == 1
    first_uid, first_token = extract_setup_link_params(mail.outbox[0].body)

    invited_user = User.objects.get(email="resend-target@example.com")
    assert invited_user.can_resend_setup_email is True

    resent = client.post(f"/api/auth/users/{invited_user.id}/resend-setup-email/")

    assert resent.status_code == 200
    assert len(mail.outbox) == 2
    second_uid, second_token = extract_setup_link_params(mail.outbox[1].body)
    assert second_uid == first_uid
    assert second_token != first_token

    first_validate = activation_client.post(
        "/api/auth/password-reset/validate/",
        data=json.dumps({"uid": first_uid, "token": first_token}),
        content_type="application/json",
    )

    assert first_validate.status_code == 400
    assert first_validate.json()["detail"] == "Reset token is invalid or expired."

    second_validate = activation_client.post(
        "/api/auth/password-reset/validate/",
        data=json.dumps({"uid": second_uid, "token": second_token}),
        content_type="application/json",
    )

    assert second_validate.status_code == 200
    assert second_validate.json()["detail"] == "Password link is valid."

    first_attempt = activation_client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": first_uid,
                "token": first_token,
                "new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert first_attempt.status_code == 400
    assert first_attempt.json()["detail"] == "Reset token is invalid or expired."

    second_attempt = activation_client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": second_uid,
                "token": second_token,
                "new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert second_attempt.status_code == 200
    assert second_attempt.json()["next_step"] == "login"

    invited_user.refresh_from_db()
    assert invited_user.check_password("strong-password-456") is True
    assert invited_user.email_setup_pending is False


@pytest.mark.django_db
@override_settings(
    EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend",
    FRONTEND_BASE_URL="http://127.0.0.1:5173",
    FRONTEND_PORT="5173",
)
def test_totp_required_invite_keeps_setup_resend_available_until_totp_is_confirmed(client):
    superadmin = User.objects.create_superuser(
        email="totp-onboarding-superadmin@example.com",
        password="strong-password-123",
    )
    activation_client = APIClient()
    client.force_login(superadmin)

    created = client.post(
        "/api/auth/users/",
        data=json.dumps(
            {
                "email": "totp-onboarding@example.com",
                "full_name": "TOTP Onboarding",
                "is_active": True,
                "totp_required": True,
                "send_invite_email": True,
                "global_scopes": ["read:durable"],
            }
        ),
        content_type="application/json",
    )

    assert created.status_code == 201
    assert len(mail.outbox) == 1
    uid, token = extract_setup_link_params(mail.outbox[0].body)

    invite_user = User.objects.get(email="totp-onboarding@example.com")
    assert invite_user.can_resend_setup_email is True

    password_response = activation_client.post(
        "/api/auth/password-reset/confirm/",
        data=json.dumps(
            {
                "uid": uid,
                "token": token,
                "new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert password_response.status_code == 200
    assert password_response.json()["next_step"] == "totp_setup"

    invite_user.refresh_from_db()
    assert invite_user.email_setup_pending is True

    resend_while_totp_pending = client.post(
        f"/api/auth/users/{invite_user.id}/resend-setup-email/"
    )
    assert resend_while_totp_pending.status_code == 200
    assert resend_while_totp_pending.json()["can_resend_setup_email"] is True

    setup_response = activation_client.post(
        "/api/auth/2fa/setup/",
        data=json.dumps({}),
        content_type="application/json",
    )
    assert setup_response.status_code == 200

    device = TOTPDevice.objects.get(user=invite_user, confirmed=False)
    confirm_response = activation_client.post(
        "/api/auth/2fa/confirm/",
        data=json.dumps({"token": build_totp_token(device)}),
        content_type="application/json",
    )

    assert confirm_response.status_code == 200

    invite_user.refresh_from_db()
    assert invite_user.email_setup_pending is False

    resend_after_totp = client.post(
        f"/api/auth/users/{invite_user.id}/resend-setup-email/"
    )
    assert resend_after_totp.status_code == 400
    assert resend_after_totp.json()["detail"] == "This user does not need a setup email."
