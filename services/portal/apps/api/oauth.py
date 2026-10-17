"""Registration of the first-party OAuth client of the workspace SPA.

Called by ``manage.py lumen_bootstrap`` next to the homeserver's client, so it is applied
on every deploy and is idempotent. The client is PUBLIC (a browser app cannot keep a
secret): no secret, PKCE (S256) required by allauth for public clients, exact redirect
URIs on the chat app's origin, authorization code + refresh token grants only, consent
skipped (first-party, like the homeserver), and only the workspace scopes.
"""

from __future__ import annotations

from allauth.idp.oidc.models import Client
from django.conf import settings
from django.contrib.auth.hashers import make_password


def ensure_nexus_web_client() -> tuple[Client, bool]:
    client, created = Client.objects.get_or_create(
        id=settings.NEXUS_WEB_CLIENT_ID, defaults={"name": f"{settings.BRAND['name']} web app"}
    )
    client.name = f"{settings.BRAND['name']} web app"
    client.type = Client.Type.PUBLIC
    client.secret = make_password(None)  # unusable: a public client authenticates with PKCE only
    client.set_scopes(list(settings.NEXUS_API_SCOPES))
    client.set_default_scopes(list(settings.NEXUS_API_SCOPES))
    client.set_grant_types([Client.GrantType.AUTHORIZATION_CODE, Client.GrantType.REFRESH_TOKEN])
    client.set_response_types([Client.ResponseType.CODE])
    client.set_redirect_uris(list(settings.NEXUS_WEB_REDIRECT_URIS))
    client.set_cors_origins(list(settings.NEXUS_CORS_ORIGINS))
    client.allow_uri_wildcards = False
    client.skip_consent = True
    client.clean()
    client.save()
    return client, created
