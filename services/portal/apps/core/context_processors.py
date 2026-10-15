from django.conf import settings

from . import runtime


def lumen(request):
    try:
        maintenance = runtime.get("maintenance_mode")
        maintenance_message = runtime.get("maintenance_message")
        announcement = runtime.get("announcement")
        registration_mode = runtime.registration_mode()
    except Exception:  # database not ready (e.g. during bootstrap)
        maintenance, maintenance_message, announcement = False, "", ""
        registration_mode = settings.REGISTRATION_MODE
    return {
        "brand": settings.BRAND,
        "lumen": {
            "surface": settings.SURFACE,
            "manage_base": "ops/base_ops.html" if settings.SURFACE == "ops" else "portal/base_portal.html",
            "version": settings.LUMEN_VERSION,
            "app_url": settings.APP_BASE_URL,
            "matrix_url": settings.MATRIX_BASE_URL,
            "public_url": settings.PUBLIC_BASE_URL,
            "server_name": settings.MATRIX_SERVER_NAME,
            "email_enabled": settings.EMAIL_ENABLED,
            "billing_provider": settings.BILLING_PROVIDER,
            "registration_mode": registration_mode,
            "federation_mode": settings.FEDERATION_MODE,
            "voip_enabled": settings.VOIP_ENABLED,
            "maintenance": maintenance,
            "maintenance_message": maintenance_message,
            "announcement": announcement,
            "brand_asset_url": settings.BRAND_ASSET_URL,
            "public_status_page": settings.PUBLIC_STATUS_PAGE,
        },
    }
