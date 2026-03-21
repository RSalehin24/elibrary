from django.contrib.auth.models import AbstractUser, BaseUserManager
from django.db import models

from apps.common.models import TimeStampedModel


class UserManager(BaseUserManager):
    use_in_migrations = True

    def _create_user(self, email, password, **extra_fields):
        if not email:
            raise ValueError("An email address is required.")

        email = self.normalize_email(email)
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, email, password=None, **extra_fields):
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, password, **extra_fields)

    def create_superuser(self, email, password, **extra_fields):
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        extra_fields.setdefault("is_active", True)

        if extra_fields.get("is_staff") is not True:
            raise ValueError("Superuser must have is_staff=True.")
        if extra_fields.get("is_superuser") is not True:
            raise ValueError("Superuser must have is_superuser=True.")

        return self._create_user(email, password, **extra_fields)


class User(AbstractUser, TimeStampedModel):
    username = None
    email = models.EmailField(unique=True)
    full_name = models.CharField(max_length=255, blank=True)

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = []

    objects = UserManager()

    def __str__(self):
        return self.display_name or self.email

    @property
    def display_name(self):
        return self.full_name or self.email

    @property
    def has_totp_enabled(self):
        try:
            from django_otp.plugins.otp_totp.models import TOTPDevice
        except ImportError:
            return False

        return TOTPDevice.objects.filter(user=self, confirmed=True).exists()

    @property
    def capability_scopes(self):
        if self.is_superuser:
            return [
                "submit:create",
                "preview:read_once",
                "read:durable",
                "download:file",
                "metadata:edit",
                "processing:manage",
                "access:manage",
                "admin:full_control",
            ]

        scopes = {"submit:create"}

        try:
            from apps.access.models import PermissionGrant
        except Exception:
            return sorted(scopes)

        active_grants = PermissionGrant.objects.active_for_user(self)
        scopes.update(active_grants.values_list("scope", flat=True))
        return sorted(scopes)

# Create your models here.
