from django.apps import AppConfig


class McpConfig(AppConfig):
    """The Claude MCP connector (AI team). Already registered; ``urls.py`` is mounted at
    /mcp/ on the public surface.

    Authenticate with ``apps.api.auth.authenticate_bearer`` and your own ``TokenPolicy``
    (resource ``<PUBLIC_BASE_URL>/mcp``, your own scopes, resource-bound tokens); authorize
    every tool call through ``apps.crm.access`` with an ``Actor``. The connector cannot read
    native chat content (end-to-end encrypted).
    """

    name = "apps.mcp"
    label = "mcp"
    verbose_name = "MCP connector"
