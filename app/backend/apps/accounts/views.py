from django.contrib.auth import get_user_model, login, logout, update_session_auth_hash
from django.db import transaction
from django.db.models import Case, Count, Exists, IntegerField, OuterRef, Prefetch, Q, Value, When
from django.db.models.functions import Lower
from django_otp.plugins.otp_totp.models import TOTPDevice
from rest_framework import generics, status
from rest_framework.exceptions import ErrorDetail, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.serializers import (
    LoginSerializer,
    ManagedUserCreateSerializer,
    ManagedUserSerializer,
    ManagedUserUpdateSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    PasswordResetValidateSerializer,
    ProfileSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
    SessionSerializer,
    TOTPConfirmSerializer,
    TOTPSetupSerializer,
    TOTPStatusSerializer,
    UserSerializer,
)
from apps.accounts.serializers.support import send_account_setup_email
from apps.access.models import ACCOUNT_MANAGEABLE_PERMISSION_SCOPES, PermissionGrant
from apps.common.permissions import IsSuperAdmin
from apps.common.throttles import LoginRateThrottle, PasswordResetRateThrottle, RegisterRateThrottle


def extract_validation_error_message(detail):
    if isinstance(detail, ErrorDetail):
        return str(detail).strip()
    if isinstance(detail, str):
        return detail.strip()
    if isinstance(detail, (list, tuple)):
        for item in detail:
            message = extract_validation_error_message(item)
            if message:
                return message
        return ""
    if isinstance(detail, dict):
        for key in ("detail", "message", "non_field_errors"):
            if key in detail:
                message = extract_validation_error_message(detail[key])
                if message:
                    return message
        for key, value in detail.items():
            if key in {"detail", "message", "non_field_errors", "code"}:
                continue
            message = extract_validation_error_message(value)
            if message:
                return message
    return ""


def normalize_validation_error_detail(exc):
    return extract_validation_error_message(exc.detail) or "Request failed."


MANAGED_USER_DEFAULT_LIMIT = 60
MANAGED_USER_MAX_LIMIT = 180


def normalized_managed_user_status(value):
    normalized = str(value or "").strip().lower()
    if normalized in {"active", "disabled", "totp_required"}:
        return normalized
    return "all"


def clamped_query_int(value, *, default, minimum=0, maximum=None):
    try:
        parsed = int(str(value).strip() or default)
    except (TypeError, ValueError):
        parsed = default
    parsed = max(minimum, parsed)
    if maximum is not None:
        parsed = min(parsed, maximum)
    return parsed


def apply_managed_user_search(queryset, raw_query):
    query = str(raw_query or "").strip().lower()
    if not query:
        return queryset

    search_filter = Q(email__icontains=query) | Q(full_name__icontains=query)

    if "active".find(query) != -1:
        search_filter |= Q(is_active=True)
    if "disabled".find(query) != -1:
        search_filter |= Q(is_active=False)
    if "required".find(query) != -1:
        search_filter |= Q(totp_required=True)
    if "enabled".find(query) != -1:
        search_filter |= Q(has_totp_enabled_value=True, totp_required=False)
    if "optional".find(query) != -1:
        search_filter |= Q(has_totp_enabled_value=False, totp_required=False)

    matching_scopes = [
        scope.value
        for scope in ACCOUNT_MANAGEABLE_PERMISSION_SCOPES
        if query in scope.value.lower() or query in scope.label.lower()
    ]
    if matching_scopes:
        search_filter |= Q(
            permission_grants__scope__in=matching_scopes,
            permission_grants__is_active=True,
            permission_grants__book__isnull=True,
            permission_grants__category__isnull=True,
            permission_grants__contributor__isnull=True,
        )

    return queryset.filter(search_filter).distinct()


def ordered_managed_users_queryset(queryset, sort_key):
    if sort_key == "name_desc":
        return queryset.order_by(Lower("full_name").desc(), Lower("email").desc())
    if sort_key == "email_asc":
        return queryset.order_by(Lower("email"), Lower("full_name"))
    if sort_key == "email_desc":
        return queryset.order_by(Lower("email").desc(), Lower("full_name").desc())
    if sort_key == "status":
        return queryset.order_by(
            Case(
                When(is_active=True, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            ),
            Lower("full_name"),
            Lower("email"),
        )
    return queryset.order_by(Lower("full_name"), Lower("email"))


class SessionView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        user = request.user if request.user.is_authenticated else None
        return Response(
            SessionSerializer({"authenticated": bool(user), "user": user}, context={"request": request}).data
        )


class RegisterView(generics.CreateAPIView):
    permission_classes = [IsAuthenticated, IsSuperAdmin]
    serializer_class = RegisterSerializer
    throttle_classes = [RegisterRateThrottle]


class LoginView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [LoginRateThrottle]

    def post(self, request):
        serializer = LoginSerializer(data=request.data, context={"request": request})
        try:
            serializer.is_valid(raise_exception=True)
        except ValidationError as exc:
            if isinstance(exc.detail, dict) and "code" in exc.detail and "detail" in exc.detail:
                code = exc.detail["code"]
                detail = exc.detail["detail"]
                if isinstance(code, (list, tuple)):
                    code = code[0]
                if isinstance(detail, (list, tuple)):
                    detail = detail[0]
                return Response({"detail": str(detail), "code": str(code)}, status=status.HTTP_400_BAD_REQUEST)
            raise
        login(request, serializer.validated_data["user"])
        return Response(UserSerializer(request.user, context={"request": request}).data)


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PasswordResetRequestView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [PasswordResetRateThrottle]

    def post(self, request):
        serializer = PasswordResetRequestSerializer(data=request.data, context={"request": request})
        try:
            serializer.is_valid(raise_exception=True)
            serializer.save()
        except ValidationError as exc:
            detail = normalize_validation_error_detail(exc)
            status_code = (
                status.HTTP_404_NOT_FOUND
                if detail == "No user exist with this email."
                else status.HTTP_400_BAD_REQUEST
            )
            return Response({"detail": detail}, status=status_code)
        return Response({"detail": "Reset email has been sent."})


class PasswordResetConfirmView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        if request.user.is_authenticated:
            return Response(
                {"detail": "Please log out first before resetting a password from this link."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = PasswordResetConfirmSerializer(data=request.data)
        try:
            serializer.is_valid(raise_exception=True)
        except ValidationError as exc:
            return Response(
                {"detail": normalize_validation_error_detail(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user = serializer.save()
        if user.requires_totp_setup:
            login(request, user)
            return Response(
                {
                    "detail": "Password saved. Continue with two-factor setup.",
                    "next_step": "totp_setup",
                    "user": UserSerializer(
                        request.user, context={"request": request}
                    ).data,
                }
            )
        return Response({"detail": "Password reset complete.", "next_step": "login"})


class PasswordResetValidateView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = PasswordResetValidateSerializer(data=request.data)
        try:
            serializer.is_valid(raise_exception=True)
        except ValidationError as exc:
            return Response(
                {"detail": normalize_validation_error_detail(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response({"detail": "Password link is valid."})


class TOTPStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        pending_setup = TOTPDevice.objects.filter(user=request.user, confirmed=False).exists()
        return Response(
            TOTPStatusSerializer(
                {
                    "enabled": request.user.has_totp_enabled,
                    "pending_setup": pending_setup,
                    "required": request.user.totp_required,
                    "setup_required": request.user.requires_totp_setup,
                }
            ).data
        )


class TOTPSetupView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def post(self, request):
        TOTPDevice.objects.filter(user=request.user, confirmed=False).delete()
        device = TOTPDevice.objects.create(user=request.user, name="default", confirmed=False)
        return Response(TOTPSetupSerializer(TOTPSetupSerializer.from_device(device)).data)


class TOTPConfirmView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def post(self, request):
        serializer = TOTPConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        device = TOTPDevice.objects.filter(user=request.user, confirmed=False).first()
        if device is None:
            return Response({"detail": "No pending TOTP setup exists."}, status=status.HTTP_400_BAD_REQUEST)

        if not device.verify_token(serializer.validated_data["token"]):
            return Response({"detail": "Invalid TOTP token."}, status=status.HTTP_400_BAD_REQUEST)

        device.confirmed = True
        device.save(update_fields=["confirmed"])
        if request.user.email_setup_pending and request.user.has_usable_password():
            request.user.email_setup_pending = False
            request.user.save(update_fields=["email_setup_pending"])
        return Response({"detail": "TOTP is now enabled."})


class TOTPCancelSetupView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def post(self, request):
        TOTPDevice.objects.filter(user=request.user, confirmed=False).delete()
        return Response({"detail": "Pending TOTP setup canceled."})


class TOTPDisableView(APIView):
    permission_classes = [IsAuthenticated]

    @transaction.atomic
    def post(self, request):
        if request.user.totp_required:
            return Response(
                {"detail": "An administrator requires TOTP for this account."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        deleted, _ = TOTPDevice.objects.filter(user=request.user).delete()
        if not deleted:
            return Response({"detail": "TOTP is not enabled for this account."}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"detail": "TOTP has been disabled."})


class ProfileView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser, FormParser, MultiPartParser]

    def get(self, request):
        return Response(ProfileSerializer(request.user, context={"request": request}).data)

    def patch(self, request):
        serializer = ProfileUpdateSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        if getattr(serializer, "password_changed", False):
            update_session_auth_hash(request, request.user)
        return Response(ProfileSerializer(request.user, context={"request": request}).data)


class ManagedUserListCreateView(generics.ListCreateAPIView):
    permission_classes = [IsAuthenticated, IsSuperAdmin]

    def get_queryset(self):
        user_model = get_user_model()
        global_grants = PermissionGrant.objects.active().filter(
            book__isnull=True,
            category__isnull=True,
            contributor__isnull=True,
        )
        return (
            user_model.objects.annotate(
                grant_count_value=Count("permission_grants", distinct=True),
                has_totp_enabled_value=Exists(
                    TOTPDevice.objects.filter(user_id=OuterRef("pk"), confirmed=True)
                ),
            )
            .prefetch_related(
                Prefetch(
                    "permission_grants",
                    queryset=global_grants,
                    to_attr="prefetched_active_global_grants",
                )
            )
        )

    def get_serializer_class(self):
        if self.request.method == "POST":
            return ManagedUserCreateSerializer
        return ManagedUserSerializer

    def list(self, request, *args, **kwargs):
        queryset = self.get_queryset()
        query = request.query_params.get("q", "")
        status_filter = normalized_managed_user_status(
            request.query_params.get("status", "all")
        )
        sort_key = str(request.query_params.get("sort", "name_asc") or "name_asc").strip()
        offset = clamped_query_int(
            request.query_params.get("offset"),
            default=0,
            minimum=0,
        )
        limit = clamped_query_int(
            request.query_params.get("limit"),
            default=MANAGED_USER_DEFAULT_LIMIT,
            minimum=1,
            maximum=MANAGED_USER_MAX_LIMIT,
        )

        if status_filter == "active":
            queryset = queryset.filter(is_active=True)
        elif status_filter == "disabled":
            queryset = queryset.filter(is_active=False)
        elif status_filter == "totp_required":
            queryset = queryset.filter(totp_required=True)

        queryset = apply_managed_user_search(queryset, query)
        queryset = ordered_managed_users_queryset(queryset, sort_key)

        total_count = queryset.count()
        rows = list(queryset[offset : offset + limit])
        next_offset = offset + len(rows)

        return Response(
            {
                "rows": ManagedUserSerializer(
                    rows,
                    many=True,
                    context={"request": request},
                ).data,
                "pagination": {
                    "offset": offset,
                    "limit": limit,
                    "totalCount": total_count,
                    "hasMore": next_offset < total_count,
                    "nextOffset": next_offset,
                },
            }
        )


class ManagedUserDetailView(generics.RetrieveUpdateDestroyAPIView):
    permission_classes = [IsAuthenticated, IsSuperAdmin]

    def get_queryset(self):
        return get_user_model().objects.order_by("email")

    def get_serializer_class(self):
        if self.request.method in {"PUT", "PATCH"}:
            return ManagedUserUpdateSerializer
        return ManagedUserSerializer

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.pk == request.user.pk:
            return Response({"detail": "You cannot edit your own account from Users & Access."}, status=status.HTTP_400_BAD_REQUEST)
        return super().update(request, *args, **kwargs)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.is_superuser:
            return Response({"detail": "Super admin users cannot be deleted."}, status=status.HTTP_400_BAD_REQUEST)
        if instance.pk == request.user.pk:
            return Response({"detail": "You cannot delete your own account."}, status=status.HTTP_400_BAD_REQUEST)
        instance.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ManagedUserResendSetupEmailView(APIView):
    permission_classes = [IsAuthenticated, IsSuperAdmin]

    @transaction.atomic
    def post(self, request, pk):
        user = get_user_model().objects.filter(pk=pk).first()
        if user is None:
            return Response({"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND)
        if user.is_superuser:
            return Response({"detail": "Super admin users do not use setup emails."}, status=status.HTTP_400_BAD_REQUEST)
        if user.pk == request.user.pk:
            return Response({"detail": "You cannot send a setup email to your own account."}, status=status.HTTP_400_BAD_REQUEST)
        if not user.can_resend_setup_email:
            return Response({"detail": "This user does not need a setup email."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            send_account_setup_email(user, request=request, invited_by=request.user)
        except Exception:
            return Response({"detail": "Setup email could not be delivered."}, status=status.HTTP_400_BAD_REQUEST)
        return Response(ManagedUserSerializer(user, context={"request": request}).data)

# Create your views here.
