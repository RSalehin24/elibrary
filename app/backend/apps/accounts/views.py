from django.contrib.auth import get_user_model, login, logout, update_session_auth_hash
from django.db import transaction
from django_otp.plugins.otp_totp.models import TOTPDevice
from rest_framework import generics, status
from rest_framework.exceptions import ValidationError
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
    ProfileSerializer,
    ProfileUpdateSerializer,
    RegisterSerializer,
    SessionSerializer,
    TOTPConfirmSerializer,
    TOTPSetupSerializer,
    TOTPStatusSerializer,
    UserSerializer,
)
from apps.common.permissions import IsSuperAdmin
from apps.common.throttles import LoginRateThrottle, PasswordResetRateThrottle, RegisterRateThrottle


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
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response({"detail": "If the email exists, reset instructions were sent."})


class PasswordResetConfirmView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        if request.user.is_authenticated:
            return Response(
                {"detail": "Please log out first before resetting a password from this link."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response({"detail": "Password reset complete."})


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

# Create your views here.
