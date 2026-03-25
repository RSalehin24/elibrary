import os
from pathlib import Path
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent.parent


def env(key, default=None):
    return os.environ.get(key, default)


def env_bool(key, default=False):
    value = env(key)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_list(key, default=""):
    raw_value = env(key, default)
    if not raw_value:
        return []
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def append_unique(items, value):
    if value and value not in items:
        items.append(value)
    return items


def normalized_origin(value):
    parsed = urlparse((value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def hostname_from_url(value):
    parsed = urlparse((value or "").strip())
    return parsed.hostname or ""


def database_config(url):
    parsed = urlparse(url)
    if parsed.scheme in {"sqlite", "sqlite3"}:
        db_name = parsed.path or "/db.sqlite3"
        return {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": db_name.replace("///", "/"),
        }

    engine_map = {
        "postgres": "django.db.backends.postgresql",
        "postgresql": "django.db.backends.postgresql",
        "pgsql": "django.db.backends.postgresql",
    }
    engine = engine_map.get(parsed.scheme)
    if not engine:
        raise ValueError(f"Unsupported database scheme: {parsed.scheme}")

    return {
        "ENGINE": engine,
        "NAME": parsed.path.lstrip("/"),
        "USER": parsed.username or "",
        "PASSWORD": parsed.password or "",
        "HOST": parsed.hostname or "",
        "PORT": parsed.port or "",
    }


APP_ENV = env("APP_ENV", "development")
DEBUG = env_bool("DJANGO_DEBUG", APP_ENV != "production")
SECRET_KEY = env("DJANGO_SECRET_KEY", "development-only-insecure-secret-key")
PUBLIC_BASE_URL = env("PUBLIC_BASE_URL", "http://localhost")
FRONTEND_BASE_URL = env("FRONTEND_BASE_URL", PUBLIC_BASE_URL).rstrip("/")
PUBLIC_API_ORIGIN = env("PUBLIC_API_ORIGIN", PUBLIC_BASE_URL).rstrip("/")
ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,backend,nginx")
CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS", "")
CORS_ALLOWED_ORIGINS = env_list("DJANGO_CORS_ALLOWED_ORIGINS", "")
CORS_ALLOW_CREDENTIALS = env_bool("DJANGO_CORS_ALLOW_CREDENTIALS", True)

for host in {hostname_from_url(FRONTEND_BASE_URL), hostname_from_url(PUBLIC_API_ORIGIN)}:
    append_unique(ALLOWED_HOSTS, host)

for origin in {normalized_origin(FRONTEND_BASE_URL), normalized_origin(PUBLIC_API_ORIGIN)}:
    append_unique(CSRF_TRUSTED_ORIGINS, origin)
    append_unique(CORS_ALLOWED_ORIGINS, origin)

PASSWORD_RESET_FRONTEND_PATH = env("PASSWORD_RESET_FRONTEND_PATH", "/reset-password")
SUPER_ADMIN_EMAIL = env("SUPER_ADMIN_EMAIL", "rsalehin24@gmail.com")
SUPER_ADMIN_PASSWORD = env("SUPER_ADMIN_PASSWORD", "")
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", "noreply@banglalibrary.local")
SOURCE_SITE_HOST = env("SOURCE_SITE_HOST", "www.ebanglalibrary.com").strip().lower()
SOURCE_SITE_FALLBACK_HOSTS = env_list("SOURCE_SITE_FALLBACK_HOSTS", "ebanglalibrary.com")
OTP_TOTP_ISSUER = env("OTP_TOTP_ISSUER", "RSalehin24 Library")
CATALOG_EXPORT_FONT_PATH = env("CATALOG_EXPORT_FONT_PATH", "")


INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "django_filters",
    "django_otp",
    "django_otp.plugins.otp_totp",
    "apps.common",
    "apps.accounts",
    "apps.catalog",
    "apps.ingestion",
    "apps.access",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django_otp.middleware.OTPMiddleware",
    "apps.common.middleware.RequireTotpSetupMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    }
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": database_config(env("DATABASE_URL", f"sqlite:///{BASE_DIR / 'db.sqlite3'}"))
}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

AUTH_USER_MODEL = "accounts.User"
AUTHENTICATION_BACKENDS = ["django.contrib.auth.backends.ModelBackend"]

LANGUAGE_CODE = "en-us"
TIME_ZONE = env("TIME_ZONE", "Asia/Dhaka")

USE_I18N = True
USE_TZ = True

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.AllowAny",
    ],
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
    ],
    "DEFAULT_RENDERER_CLASSES": [
        "rest_framework.renderers.JSONRenderer",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "login": env("THROTTLE_LOGIN", "10/hour"),
        "register": env("THROTTLE_REGISTER", "5/hour"),
        "password_reset": env("THROTTLE_PASSWORD_RESET", "5/hour"),
        "submission": env("THROTTLE_SUBMISSION", "40/hour"),
    },
}

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]
MEDIA_URL = "/media/"
MEDIA_ROOT = Path(env("MEDIA_ROOT", str(BASE_DIR / "storage" / "media")))

public_urls_use_https = any(origin.startswith("https://") for origin in {FRONTEND_BASE_URL, PUBLIC_API_ORIGIN})

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = env("SESSION_COOKIE_SAMESITE", "Lax")
SESSION_COOKIE_SECURE = env_bool("SESSION_COOKIE_SECURE", public_urls_use_https)
CSRF_COOKIE_SECURE = env_bool("CSRF_COOKIE_SECURE", public_urls_use_https)
CSRF_COOKIE_SAMESITE = env("CSRF_COOKIE_SAMESITE", "Lax")
SECURE_BROWSER_XSS_FILTER = True
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
USE_X_FORWARDED_HOST = env_bool("DJANGO_USE_X_FORWARDED_HOST", True)

if env_bool("DJANGO_SECURE_PROXY_SSL_HEADER", True):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

CELERY_BROKER_URL = env("CELERY_BROKER_URL", "redis://redis:6379/0")
CELERY_RESULT_BACKEND = env("CELERY_RESULT_BACKEND", CELERY_BROKER_URL)
CELERY_TASK_ALWAYS_EAGER = env_bool("CELERY_TASK_ALWAYS_EAGER", APP_ENV != "production")
CELERY_TASK_EAGER_PROPAGATES = True

EMAIL_BACKEND = env("EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend")
EMAIL_HOST = env("EMAIL_HOST", "")
EMAIL_PORT = int(env("EMAIL_PORT", "587"))
EMAIL_HOST_USER = env("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", True)
EMAIL_USE_SSL = env_bool("EMAIL_USE_SSL", False)
EMAIL_TIMEOUT = int(env("EMAIL_TIMEOUT", "20"))
BREVO_API_KEY = env("BREVO_API_KEY", "")
ANYMAIL = {
    "BREVO_API_KEY": BREVO_API_KEY,
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "structured": {
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        }
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "structured",
        }
    },
    "root": {
        "handlers": ["console"],
        "level": env("LOG_LEVEL", "INFO"),
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
