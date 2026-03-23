from urllib.parse import urljoin

from django.conf import settings
from django.urls import reverse


def public_api_url(viewname, *, kwargs=None, request=None):
    path = reverse(viewname, kwargs=kwargs)
    public_origin = getattr(settings, "PUBLIC_API_ORIGIN", "").rstrip("/")
    if public_origin:
        return urljoin(f"{public_origin}/", path.lstrip("/"))
    if request is not None:
        return request.build_absolute_uri(path)
    return path
