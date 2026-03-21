from django.contrib.auth import login, logout
from django.db import transaction
from django_otp.plugins.otp_totp.models import TOTPDevice
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.serializers import (
    LoginSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegisterSerializer,
    SessionSerializer,
    TOTPConfirmSerializer,
    TOTPSetupSerializer,
    TOTPStatusSerializer,
    UserSerializer,
)
from apps.common.throttles import LoginRateThrottle, PasswordResetRateThrottle, RegisterRateThrottle


class SessionView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        user = request.user if request.user.is_authenticated else None
        return Response(
            SessionSerializer({"authenticated": bool(user), "user": user}).data
        )


class RegisterView(generics.CreateAPIView):
    permission_classes = [AllowAny]
    serializer_class = RegisterSerializer
    throttle_classes = [RegisterRateThrottle]


class LoginView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [LoginRateThrottle]

    def post(self, request):
        serializer = LoginSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        login(request, serializer.validated_data["user"])
        return Response(UserSerializer(request.user).data)


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

# Create your views here.
