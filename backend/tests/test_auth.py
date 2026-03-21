import json

import pytest
from django_otp.oath import totp
from django_otp.plugins.otp_totp.models import TOTPDevice

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
            }
        ),
        content_type="application/json",
    )
    assert created.status_code == 201
    assert User.objects.filter(email="created@example.com", is_superuser=False, is_staff=False).exists()
