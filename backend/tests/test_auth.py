import json

import pytest
from django.core import mail
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice
from rest_framework.test import APIClient

from apps.access.models import PermissionGrant
from apps.accounts.models import User


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

    token = str(
        totp(
            device.bin_key,
            step=device.step,
            t0=device.t0,
            digits=device.digits,
            drift=device.drift,
        )
    ).zfill(device.digits)
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
@override_settings(EMAIL_BACKEND="django.core.mail.backends.locmem.EmailBackend")
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
    assert "Your Bangla Library account is ready" in mail.outbox[0].subject
    assert "/reset-password?uid=" in mail.outbox[0].body


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
def test_totp_required_users_are_limited_to_setup_endpoints_until_configured(client):
    user = User.objects.create_user(
        email="setup-required@example.com",
        password="strong-password-123",
        full_name="Needs Setup",
        totp_required=True,
    )
    client.force_login(user)

    session = client.get("/api/auth/session/")
    assert session.status_code == 200
    assert session.json()["user"]["totp_required"] is True
    assert session.json()["user"]["totp_setup_required"] is True

    status_response = client.get("/api/auth/2fa/status/")
    assert status_response.status_code == 200
    assert status_response.json()["required"] is True
    assert status_response.json()["setup_required"] is True

    blocked = client.get("/api/catalog/books/")
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "otp_setup_required"

    setup = client.post(
        "/api/auth/2fa/setup/",
        data=json.dumps({}),
        content_type="application/json",
    )
    assert setup.status_code == 200
    assert setup.json()["provisioning_uri"].startswith("otpauth://")
    assert "RSalehin24%20Library" in setup.json()["provisioning_uri"]
    assert "<svg" in setup.json()["qr_svg"]

    cancel = client.post(
        "/api/auth/2fa/cancel/",
        data=json.dumps({}),
        content_type="application/json",
    )
    assert cancel.status_code == 200

    after_cancel = client.get("/api/auth/2fa/status/")
    assert after_cancel.status_code == 200
    assert after_cancel.json()["pending_setup"] is False
    assert after_cancel.json()["setup_required"] is True

    disable = client.post(
        "/api/auth/2fa/disable/",
        data=json.dumps({}),
        content_type="application/json",
    )
    assert disable.status_code == 400


@pytest.mark.django_db
def test_authenticated_user_can_update_profile_name(client):
    user = User.objects.create_user(
        email="profile@example.com",
        password="strong-password-123",
        full_name="Before",
    )
    client.force_login(user)

    response = client.patch(
        "/api/auth/profile/",
        data=json.dumps({"full_name": "After"}),
        content_type="application/json",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.full_name == "After"


@pytest.mark.django_db
def test_authenticated_user_can_upload_profile_image(client):
    user = User.objects.create_user(
        email="photo@example.com",
        password="strong-password-123",
        full_name="Photo User",
    )
    api_client = APIClient()
    api_client.force_authenticate(user=user)

    upload = SimpleUploadedFile("avatar.png", b"fake-image-bytes", content_type="image/png")

    response = api_client.patch(
        "/api/auth/profile/",
        data={"full_name": "Photo User", "profile_image": upload},
        format="multipart",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    assert bool(user.profile_image.name) is True
    assert response.json()["profile_image_url"]


@pytest.mark.django_db
def test_authenticated_user_can_change_password_from_profile_and_remain_signed_in(client):
    user = User.objects.create_user(
        email="password-change@example.com",
        password="strong-password-123",
        full_name="Password User",
    )
    client.force_login(user)

    response = client.patch(
        "/api/auth/profile/",
        data=json.dumps(
            {
                "current_password": "strong-password-123",
                "new_password": "strong-password-456",
                "confirm_new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 200
    user.refresh_from_db()
    assert user.check_password("strong-password-456") is True

    session_response = client.get("/api/auth/session/")
    assert session_response.status_code == 200
    assert session_response.json()["authenticated"] is True


@pytest.mark.django_db
def test_profile_password_change_requires_the_current_password(client):
    user = User.objects.create_user(
        email="password-guard@example.com",
        password="strong-password-123",
        full_name="Password Guard",
    )
    client.force_login(user)

    response = client.patch(
        "/api/auth/profile/",
        data=json.dumps(
            {
                "current_password": "wrong-password-123",
                "new_password": "strong-password-456",
                "confirm_new_password": "strong-password-456",
            }
        ),
        content_type="application/json",
    )

    assert response.status_code == 400
    assert "current_password" in response.json()
    user.refresh_from_db()
    assert user.check_password("strong-password-123") is True
