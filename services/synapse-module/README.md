# lumen_synapse

Out-of-tree Synapse module (documented module API) that enforces Lumen plan
entitlements for media uploads: per-file size limit and a rolling 30-day upload
quota per user. It queries the internal ops API with a bearer token and caches
results for `cache_seconds`. On lookup failure it uses the last cached value or
the configured defaults (Free plan), never higher limits.

Mounted read-only into the Synapse container at `/modules` and enabled in
`homeserver.yaml`:

```yaml
modules:
  - module: lumen_synapse.LumenEntitlements
    config:
      entitlements_url: http://ops:8000/internal/v1/media-limits
      token_path: /run/secrets/internal_api_token
      cache_seconds: 300
      default_upload_max_mb: 25
      default_quota_mb_30d: 1024
```
