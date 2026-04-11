from rest_framework import serializers

from apps.accounts.models import User


class UserSerializer(serializers.ModelSerializer):
    totp_enabled = serializers.BooleanField(source="has_totp_enabled", read_only=True)
    totp_required = serializers.BooleanField(read_only=True)
    totp_setup_required = serializers.BooleanField(source="requires_totp_setup", read_only=True)
    capabilities = serializers.ListField(source="capability_scopes", child=serializers.CharField(), read_only=True)
    profile_image_url = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            "id",
            "email",
            "full_name",
            "profile_image_url",
            "is_active",
            "is_staff",
            "is_superuser",
            "totp_enabled",
            "totp_required",
            "totp_setup_required",
            "capabilities",
        ]

    def get_profile_image_url(self, obj):
        if not obj.profile_image:
            return ""
        request = self.context.get("request")
        if request is not None:
            return request.build_absolute_uri(obj.profile_image.url)
        return obj.profile_image.url


class SessionSerializer(serializers.Serializer):
    authenticated = serializers.BooleanField()
    user = UserSerializer(allow_null=True)


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, min_length=12)

    class Meta:
        model = User
        fields = ["email", "full_name", "password"]

    def create(self, validated_data):
        password = validated_data.pop("password")
        return User.objects.create_user(password=password, **validated_data)


class ManagedUserSerializer(UserSerializer):
    grant_count = serializers.SerializerMethodField()
    global_scopes = serializers.ListField(source="global_grant_scopes", child=serializers.CharField(), read_only=True)

    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields + ["grant_count", "global_scopes"]

    def get_grant_count(self, obj):
        return obj.permission_grants.count()


class ProfileSerializer(UserSerializer):
    class Meta(UserSerializer.Meta):
        fields = UserSerializer.Meta.fields
