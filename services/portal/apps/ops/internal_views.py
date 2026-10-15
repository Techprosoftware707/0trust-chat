"""Internal API used by the homeserver module (not reachable via Caddy).

Authenticated with a bearer token shared only between `ops` and `synapse`.
Returns the media-upload entitlements of a local Matrix user.
"""

from __future__ import annotations

import hmac

from django.conf import settings
from django.contrib.auth import get_user_model
from django.http import JsonResponse
from django.views.decorators.http import require_GET

from apps.billing.services import user_entitlements

THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000


def _authorised(request) -> bool:
    header = request.META.get("HTTP_AUTHORIZATION", "")
    if not header.startswith("Bearer ") or not settings.INTERNAL_API_TOKEN:
        return False
    return hmac.compare_digest(header[7:].encode(), settings.INTERNAL_API_TOKEN.encode())


@require_GET
def media_limits(request):
    if not _authorised(request):
        return JsonResponse({"error": "unauthorised"}, status=401)
    user_id = request.GET.get("user_id", "")
    suffix = f":{settings.MATRIX_SERVER_NAME}"
    if not user_id.startswith("@") or not user_id.endswith(suffix) or len(user_id) > 255:
        return JsonResponse({"error": "not a local user"}, status=400)
    localpart = user_id[1 : -len(suffix)]
    User = get_user_model()
    user = User.objects.filter(username=localpart).first()
    if user is None:
        # Service accounts or users not managed by the portal get Free limits.
        from apps.billing.services import free_plan

        plan = free_plan()
        upload_mb, quota_mb, plan_code, status = (
            plan.entitlement("upload_max_mb"),
            plan.entitlement("media_quota_mb_30d"),
            plan.code,
            "unmanaged",
        )
    else:
        ent = user_entitlements(user)
        upload_mb, quota_mb, plan_code, status = ent.upload_max_mb, ent.media_quota_mb_30d, ent.source_plan, user.status
    return JsonResponse(
        {
            "user_id": user_id,
            "plan": plan_code,
            "account_status": status,
            "upload_max_bytes": upload_mb * 1024 * 1024,
            "limits": [{"time_period_ms": THIRTY_DAYS_MS, "max_bytes": quota_mb * 1024 * 1024}],
        }
    )


@require_GET
def healthz(request):
    return JsonResponse({"status": "ok"})
