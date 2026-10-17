"""System checks of the integrations app."""

from django.conf import settings
from django.core.checks import Warning, register


@register()
def mock_mode_in_production(app_configs, **kwargs):
    if settings.NEXUS_INTEGRATIONS_MOCK and settings.NEXUS_ENVIRONMENT == "production":
        return [Warning(
            "NEXUS_INTEGRATIONS_MOCK is set but NEXUS_ENVIRONMENT is production: mock providers are refused and stay off.",
            id="nexus_integrations.W001",
        )]
    return []
