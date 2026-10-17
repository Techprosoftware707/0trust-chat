from django.apps import AppConfig


class McpConfig(AppConfig):
    """The Claude MCP connector: a remote MCP server at ``/mcp`` (Streamable HTTP) with OAuth on
    the portal's own provider (RFC 9728 metadata, RFC 8414 additions, DCR, CIMD, PKCE S256,
    RFC 8707 resource binding, RFC 9207 ``iss``, refresh rotation with reuse detection).

    Tokens are validated with ``apps.api.auth.authenticate_bearer`` and ``oauth.mcp_policy()``;
    every tool call is authorized through ``apps.crm.access`` with an ``Actor`` (the tools are
    the AI assistant's registry). The connector cannot read native chat content (end-to-end
    encrypted). See docs/nexus/CLAUDE-CONNECTOR.md.
    """

    name = "apps.mcp"
    label = "mcp"
    verbose_name = "MCP connector"

    def ready(self):
        from apps.crm import access

        from .models import McpGrant
        from .oauth import patch_loopback_matching
        from .policies import McpGrantPolicy

        patch_loopback_matching()
        access.register(McpGrant, McpGrantPolicy(), referencable=False)
