from __future__ import annotations

from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from apps.core import ratelimit
from apps.core.audit import security_event

from .providers import StripeProvider, get_provider

MAX_WEBHOOK_BYTES = 256 * 1024


@csrf_exempt  # authenticated by the provider's signature instead
@require_POST
def stripe_webhook(request):
    provider = get_provider()
    if not isinstance(provider, StripeProvider) or not provider.is_configured():
        return HttpResponse(status=404)
    decision = ratelimit.check_request(request, "webhook", limit=600, window_seconds=60)
    if not decision.allowed:
        return HttpResponse(status=429)
    if len(request.body) > MAX_WEBHOOK_BYTES:
        return HttpResponse(status=413)
    result = provider.handle_webhook(request.body, request.META.get("HTTP_STRIPE_SIGNATURE"))
    if result.outcome == "rejected":
        security_event(request, "webhook_rejected", detail={"provider": "stripe", "reason": result.detail[:100]})
    return JsonResponse({"outcome": result.outcome}, status=result.status)
