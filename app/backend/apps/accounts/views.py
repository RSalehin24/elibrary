from django.contrib.auth import get_user_model, login, logout, update_session_auth_hash
from django.db import transaction
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
        return user_model.objects.order_by("email").prefetch_related("permission_grants")

    def get_serializer_class(self):
        if self.request.method == "POST":
            return ManagedUserCreateSerializer
        return ManagedUserSerializer

    def list(self, request, *args, **kwargs):
        queryset = self.get_queryset()
        payload = [
            {
                **ManagedUserSerializer(user, context={"request": request}).data,
                "grant_count": user.permission_grants.count(),
            }
            for user in queryset
        ]
        return Response(payload)


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
