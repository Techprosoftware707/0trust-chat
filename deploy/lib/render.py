#!/usr/bin/env python3
"""Render every Lumen configuration file from /etc/lumen/lumen.conf.

Stdlib only (runs on a fresh Ubuntu 24.04 host). Usage:

    render.py --conf /etc/lumen/lumen.conf --secrets /etc/lumen/secrets \
              --repo /opt/lumen --out /etc/lumen/rendered.staging

Validation of the result (caddy validate, synapse --generate-keys, compose
config) is done by the calling shell script before the staging directory is
swapped into place.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import sys
from pathlib import Path

# ----------------------------------------------------------------------------
# Config loading and validation
# ----------------------------------------------------------------------------

DEFAULTS: dict[str, str] = {
    "LUMEN_PRIMARY_DOMAIN": "",
    "LUMEN_APP_DOMAIN": "",
    "LUMEN_MATRIX_DOMAIN": "",
    "LUMEN_OPS_DOMAIN": "",
    "MATRIX_SERVER_NAME": "",
    "LUMEN_OPS_PORT": "8443",
    "ADMIN_EMAIL": "",
    "TLS_MODE": "acme",  # acme | internal
    "ACME_CA": "",
    "OPS_TLS_MODE": "",  # defaults to TLS_MODE
    "ADMIN_ALLOWED_CIDRS": "",
    "REGISTRATION_MODE": "open",
    "FEDERATION_MODE": "open",
    "FEDERATION_ALLOWLIST": "",
    "FEDERATION_PROBE_NOTARY": "",
    "TRUSTED_KEY_SERVERS": "matrix.org",
    "FEDERATION_CUSTOM_CA": "",  # path inside synapse container, test environments only
    "PRESENCE_ENABLED": "true",
    "VOIP_ENABLED": "false",
    "TURN_EXTERNAL_IP": "",
    "TURN_MIN_PORT": "49160",
    "TURN_MAX_PORT": "49200",
    "WIREGUARD_ENABLED": "false",
    "WG_SUBNET": "10.77.0.0/24",
    "WG_PORT": "51820",
    "SMTP_HOST": "",
    "SMTP_PORT": "587",
    "SMTP_USER": "",
    "SMTP_SECURITY": "starttls",
    "SMTP_FROM": "",
    "BILLING_PROVIDER": "none",
    "BILLING_CURRENCY": "usd",
    "BILLING_GRACE_DAYS": "14",
    "STRIPE_PUBLISHABLE_KEY": "",
    "BRAND_NAME": "Lumen Secure",
    "BRAND_SHORT_NAME": "Lumen",
    "BRAND_TAGLINE": "Private conversations on an open, federated network.",
    "BRAND_LEGAL_NAME": "",
    "BRAND_JURISDICTION": "",
    "SUPPORT_EMAIL": "",
    "SECURITY_EMAIL": "",
    "PRIVACY_EMAIL": "",
    "PUBLIC_STATUS_PAGE": "true",
    "DEFAULT_MAX_UPLOAD_MB": "1024",
    "SYNAPSE_OIDC_CLIENT_ID": "lumen-synapse",
    "LUMEN_DATA_DIR": "/var/lib/lumen",
    "LUMEN_CONFIG_DIR": "/etc/lumen",
    "LUMEN_SOCKET_DIR": "/var/lib/lumen/sockets",
    "BACKUP_DIR": "/var/backups/lumen",
    "LUMEN_PROJECT": "lumen",
    "LUMEN_VERSION": "",
    "POSTGRES_SHARED_BUFFERS": "",
    "LOG_LEVEL": "INFO",
    "EXTRA_HOSTS_IP": "host-gateway",
    "CA_BUNDLE_HOST_PATH": "",  # extra CA bundle for probes/OIDC (internal TLS mode)
    "CHAT_DIST_DIR": "",
    "MEM_TOTAL_MB": "",
    "LUMEN_BUILD_EXTRA_CA": "",
}

BOOL_KEYS = {"PRESENCE_ENABLED", "VOIP_ENABLED", "WIREGUARD_ENABLED", "PUBLIC_STATUS_PAGE"}
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# UIDs/GIDs used inside containers (documented in docs/operations/admin-guide.md).
UID_APP = 10001
UID_CADDY = 10200
GID_SECRETS = 10100
GID_SOCKETS = 10300
UID_SYNAPSE = 991
UID_POSTGRES = 70


class ConfigError(Exception):
    pass


def parse_conf(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ConfigError(f"{path}:{lineno}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not re.match(r"^[A-Z][A-Z0-9_]*$", key):
            raise ConfigError(f"{path}:{lineno}: invalid key {key!r}")
        values[key] = value
    return values


def truthy(v: str) -> bool:
    return v.strip().lower() in {"1", "true", "yes", "on"}


def load_config(conf_path: Path) -> dict[str, str]:
    cfg = dict(DEFAULTS)
    cfg.update(parse_conf(conf_path))
    p = cfg["LUMEN_PRIMARY_DOMAIN"].lower().strip(".")
    if not p:
        raise ConfigError("LUMEN_PRIMARY_DOMAIN is required")
    cfg["LUMEN_PRIMARY_DOMAIN"] = p
    cfg["LUMEN_APP_DOMAIN"] = (cfg["LUMEN_APP_DOMAIN"] or f"app.{p}").lower()
    cfg["LUMEN_MATRIX_DOMAIN"] = (cfg["LUMEN_MATRIX_DOMAIN"] or f"matrix.{p}").lower()
    cfg["LUMEN_OPS_DOMAIN"] = (cfg["LUMEN_OPS_DOMAIN"] or f"ops.{p}").lower()
    cfg["MATRIX_SERVER_NAME"] = (cfg["MATRIX_SERVER_NAME"] or p).lower()
    cfg["OPS_TLS_MODE"] = cfg["OPS_TLS_MODE"] or cfg["TLS_MODE"]
    cfg["BRAND_LEGAL_NAME"] = cfg["BRAND_LEGAL_NAME"] or f"The operator of {p}"
    for k in ("SUPPORT_EMAIL", "SECURITY_EMAIL", "PRIVACY_EMAIL"):
        cfg[k] = cfg[k] or cfg["ADMIN_EMAIL"]
    cfg["SMTP_FROM"] = cfg["SMTP_FROM"] or f"{cfg['BRAND_NAME']} <no-reply@{p}>"
    if not cfg["FEDERATION_PROBE_NOTARY"] and cfg["FEDERATION_MODE"] == "open":
        cfg["FEDERATION_PROBE_NOTARY"] = "matrix.org"
    if cfg["FEDERATION_PROBE_NOTARY"] == "none":
        cfg["FEDERATION_PROBE_NOTARY"] = ""
    validate(cfg)
    return cfg


def validate(cfg: dict[str, str]) -> None:
    errors = []
    for key in ("LUMEN_PRIMARY_DOMAIN", "LUMEN_APP_DOMAIN", "LUMEN_MATRIX_DOMAIN", "LUMEN_OPS_DOMAIN", "MATRIX_SERVER_NAME"):
        if not DOMAIN_RE.match(cfg[key]):
            errors.append(f"{key}={cfg[key]!r} is not a valid domain name")
    hosts = [cfg["LUMEN_PRIMARY_DOMAIN"], cfg["LUMEN_APP_DOMAIN"], cfg["LUMEN_MATRIX_DOMAIN"], cfg["LUMEN_OPS_DOMAIN"]]
    if len(set(hosts)) != len(hosts):
        errors.append("primary, app, matrix and ops domains must all be different")
    if cfg["MATRIX_SERVER_NAME"] not in {cfg["LUMEN_PRIMARY_DOMAIN"], cfg["LUMEN_MATRIX_DOMAIN"]}:
        errors.append("MATRIX_SERVER_NAME must be the primary domain (recommended) or the matrix domain")
    if not EMAIL_RE.match(cfg["ADMIN_EMAIL"]):
        errors.append("ADMIN_EMAIL must be a valid email address (used for ACME and as operator contact)")
    if cfg["TLS_MODE"] not in {"acme", "internal"} or cfg["OPS_TLS_MODE"] not in {"acme", "internal"}:
        errors.append("TLS_MODE / OPS_TLS_MODE must be 'acme' or 'internal'")
    if cfg["REGISTRATION_MODE"] not in {"open", "invite", "closed"}:
        errors.append("REGISTRATION_MODE must be open, invite or closed")
    if cfg["FEDERATION_MODE"] not in {"open", "allowlist", "closed"}:
        errors.append("FEDERATION_MODE must be open, allowlist or closed")
    for d in split_list(cfg["FEDERATION_ALLOWLIST"]):
        if not DOMAIN_RE.match(d.split(":")[0]):
            errors.append(f"FEDERATION_ALLOWLIST entry {d!r} is not a domain")
    if cfg["FEDERATION_MODE"] == "allowlist" and not split_list(cfg["FEDERATION_ALLOWLIST"]):
        errors.append("FEDERATION_MODE=allowlist needs FEDERATION_ALLOWLIST (comma-separated server names)")
    if cfg["BILLING_PROVIDER"] not in {"none", "manual", "stripe"}:
        errors.append("BILLING_PROVIDER must be none, manual or stripe")
    if cfg["SMTP_SECURITY"] not in {"starttls", "tls", "none"}:
        errors.append("SMTP_SECURITY must be starttls, tls or none")
    for cidr in split_list(cfg["ADMIN_ALLOWED_CIDRS"]):
        try:
            ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            errors.append(f"ADMIN_ALLOWED_CIDRS entry {cidr!r} is not a CIDR")
    try:
        net = ipaddress.ip_network(cfg["WG_SUBNET"], strict=True)
        if not net.is_private or net.version != 4 or net.prefixlen > 29:
            errors.append("WG_SUBNET must be a private IPv4 network of /29 or larger")
    except ValueError:
        errors.append("WG_SUBNET is not a valid network (e.g. 10.77.0.0/24)")
    for k in ("TURN_MIN_PORT", "TURN_MAX_PORT", "WG_PORT", "LUMEN_OPS_PORT", "SMTP_PORT", "BILLING_GRACE_DAYS", "DEFAULT_MAX_UPLOAD_MB"):
        if not cfg[k].isdigit():
            errors.append(f"{k} must be a number")
    if cfg["TURN_MIN_PORT"].isdigit() and cfg["TURN_MAX_PORT"].isdigit():
        lo, hi = int(cfg["TURN_MIN_PORT"]), int(cfg["TURN_MAX_PORT"])
        if not (1024 < lo < hi <= 65535) or hi - lo > 2000:
            errors.append("TURN port range must be within 1025-65535 and at most 2000 ports")
    if cfg["LUMEN_OPS_PORT"] in {"80", "443"}:
        errors.append("LUMEN_OPS_PORT must not be 80 or 443")
    for k in BOOL_KEYS:
        if cfg[k].lower() not in {"true", "false", "yes", "no", "1", "0", "on", "off"}:
            errors.append(f"{k} must be true or false")
    if truthy(cfg["VOIP_ENABLED"]) and cfg["TURN_EXTERNAL_IP"]:
        try:
            ipaddress.ip_address(cfg["TURN_EXTERNAL_IP"])
        except ValueError:
            errors.append("TURN_EXTERNAL_IP must be an IP address")
    if errors:
        raise ConfigError("\n".join(f"  - {e}" for e in errors))


def split_list(value: str) -> list[str]:
    return [v.strip().lower() for v in value.replace(" ", ",").split(",") if v.strip()]


# ----------------------------------------------------------------------------
# Minimal YAML emitter (dicts, lists, str, int, bool, None)
# ----------------------------------------------------------------------------


def _scalar(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    return json.dumps(str(v), ensure_ascii=False)


def to_yaml(obj, indent: int = 0) -> str:
    pad = "  " * indent
    lines: list[str] = []
    if isinstance(obj, dict):
        if not obj:
            return pad + "{}\n"
        for k, v in obj.items():
            key = k if re.match(r"^[A-Za-z_][A-Za-z0-9_.-]*$", k) else json.dumps(k)
            if isinstance(v, dict) and v:
                lines.append(f"{pad}{key}:\n{to_yaml(v, indent + 1)}")
            elif isinstance(v, list) and v:
                lines.append(f"{pad}{key}:\n{to_yaml(v, indent + 1)}")
            elif isinstance(v, (dict, list)):
                lines.append(f"{pad}{key}: {'{}' if isinstance(v, dict) else '[]'}\n")
            else:
                lines.append(f"{pad}{key}: {_scalar(v)}\n")
        return "".join(lines)
    if isinstance(obj, list):
        for item in obj:
            if isinstance(item, (dict, list)) and item:
                inner = to_yaml(item, indent + 1)
                first, _, rest = inner.partition("\n")
                lines.append(f"{pad}- {first.strip()}\n{rest}")
            else:
                lines.append(f"{pad}- {_scalar(item)}\n")
        return "".join(lines)
    return pad + _scalar(obj) + "\n"


# ----------------------------------------------------------------------------
# Renderers
# ----------------------------------------------------------------------------


def write(path: Path, content: str, mode: int = 0o640) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    os.chmod(path, mode)


def mem_total_mb(cfg) -> int:
    if cfg.get("MEM_TOTAL_MB", "").isdigit():
        return int(cfg["MEM_TOTAL_MB"])
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 4096


def render_synapse(cfg, out: Path) -> None:
    server_name = cfg["MATRIX_SERVER_NAME"]
    hs: dict = {
        "server_name": server_name,
        "public_baseurl": f"https://{cfg['LUMEN_MATRIX_DOMAIN']}/",
        "web_client_location": f"https://{cfg['LUMEN_APP_DOMAIN']}/",
        "serve_server_wellknown": False,
        "pid_file": "/data/homeserver.pid",
        "admin_contact": f"mailto:{cfg['SECURITY_EMAIL']}",
        "listeners": [
            {
                # Caddy (host network) reaches Synapse through this socket only.
                "path": "/sockets/synapse.sock",
                "mode": 0o660,
                "type": "http",
                "x_forwarded": True,
                "resources": [{"names": ["client", "federation"], "compress": False}],
            },
            {
                # Internal network: health checks and the admin API for ops/worker.
                "port": 8008,
                "tls": False,
                "type": "http",
                "x_forwarded": False,
                "bind_addresses": ["0.0.0.0"],
                "resources": [{"names": ["client"], "compress": False}],
            },
        ],
        "database": {
            "name": "psycopg2",
            "args": {
                "host": "postgres",
                "port": 5432,
                "dbname": "synapse",
                "user": "synapse",
                "passfile": "/run/secrets/synapse_pgpass",
                "application_name": "synapse",
                "connect_timeout": 10,
                "cp_min": 5,
                "cp_max": 10,
                "keepalives_idle": 10,
                "keepalives_interval": 10,
                "keepalives_count": 3,
            },
        },
        "log_config": "/config/log.config",
        "media_store_path": "/data/media_store",
        "signing_key_path": "/data/signing.key",
        "report_stats": False,
        "macaroon_secret_key_path": "/run/secrets/synapse_macaroon",
        "form_secret_path": "/run/secrets/synapse_form_secret",
        "registration_shared_secret_path": "/run/secrets/synapse_registration_secret",
        "enable_registration": False,
        "password_config": {"enabled": False},
        "oidc_providers": [
            {
                "idp_id": "lumen",
                "idp_name": cfg["BRAND_NAME"],
                "discover": True,
                "issuer": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}",
                "client_id": cfg["SYNAPSE_OIDC_CLIENT_ID"],
                "client_secret_path": "/run/secrets/synapse_oidc_client_secret",
                "client_auth_method": "client_secret_post",
                "scopes": ["openid", "profile", "email"],
                "pkce_method": "always",
                "allow_existing_users": False,
                "enable_registration": True,
                "user_mapping_provider": {
                    "config": {
                        "subject_template": "{{ user.sub }}",
                        "localpart_template": "{{ user.preferred_username }}",
                        "display_name_template": "{{ user.name }}",
                        "email_template": "{{ user.email }}",
                        "confirm_localpart": False,
                    }
                },
            }
        ],
        "sso": {
            "client_whitelist": [f"https://{cfg['LUMEN_APP_DOMAIN']}/"],
            "update_profile_information": True,
        },
        "templates": {"custom_template_directory": "/config/templates"},
        "encryption_enabled_by_default_for_room_type": "all",
        "enable_authenticated_media": True,
        "url_preview_enabled": False,
        "max_upload_size": f"{int(cfg['DEFAULT_MAX_UPLOAD_MB'])}M",
        "presence": {"enabled": truthy(cfg["PRESENCE_ENABLED"])},
        "user_directory": {"enabled": True, "search_all_users": False, "prefer_local_users": True},
        "require_auth_for_profile_requests": True,
        "limit_profile_requests_to_users_who_share_rooms": True,
        "include_profile_data_on_invite": True,
        "allow_public_rooms_over_federation": False,
        "allow_public_rooms_without_auth": False,
        "user_ips_max_age": "28d",
        "redaction_retention_period": "7d",
        "forget_rooms_on_leave": True,
        "federation_client_minimum_tls_version": "1.2",
        "trusted_key_servers": [{"server_name": s} for s in split_list(cfg["TRUSTED_KEY_SERVERS"])],
        "suppress_key_server_warning": True,
        "modules": [
            {
                "module": "lumen_synapse.LumenEntitlements",
                "config": {
                    "entitlements_url": "http://ops:8000/internal/v1/media-limits",
                    "token_path": "/run/secrets/internal_api_token",
                    "cache_seconds": 300,
                    "default_upload_max_mb": 25,
                    "default_quota_mb_30d": 1024,
                    "info_uri": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}/pricing/",
                },
            }
        ],
    }
    mode = cfg["FEDERATION_MODE"]
    if mode == "allowlist":
        hs["federation_domain_whitelist"] = split_list(cfg["FEDERATION_ALLOWLIST"])
    elif mode == "closed":
        hs["federation_domain_whitelist"] = []
        hs["trusted_key_servers"] = []
    if cfg["FEDERATION_CUSTOM_CA"]:
        hs["federation_custom_ca_list"] = [cfg["FEDERATION_CUSTOM_CA"]]
    if truthy(cfg["VOIP_ENABLED"]):
        turn_host = cfg["LUMEN_MATRIX_DOMAIN"]
        hs["turn_uris"] = [
            f"turn:{turn_host}:3478?transport=udp",
            f"turn:{turn_host}:3478?transport=tcp",
        ]
        hs["turn_shared_secret_path"] = "/run/secrets/turn_shared_secret"
        hs["turn_user_lifetime"] = "1h"
        hs["turn_allow_guests"] = False
    header = (
        "# Generated by Lumen (deploy/lib/render.py) from /etc/lumen/lumen.conf.\n"
        "# Do not edit: changes are overwritten by install.sh / update.sh.\n"
        "# Secrets are referenced by *_path / passfile and live in /etc/lumen/secrets.\n"
    )
    write(out / "synapse" / "homeserver.yaml", header + to_yaml(hs))
    log_config = {
        "version": 1,
        "formatters": {"precise": {"format": "%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(request)s - %(message)s"}},
        "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "precise"}},
        "loggers": {
            "synapse.storage.SQL": {"level": "WARNING"},
            "synapse.access.http": {"level": "INFO"},
            "twisted": {"level": "WARNING"},
        },
        "root": {"level": cfg["LOG_LEVEL"], "handlers": ["console"]},
        "disable_existing_loggers": False,
    }
    write(out / "synapse" / "log.config", to_yaml(log_config))


def render_postgres(cfg, out: Path) -> None:
    hba = """# Generated by Lumen. Only scram-sha-256 password auth over the internal network.
# TYPE  DATABASE  USER        ADDRESS     METHOD
local   all       postgres                peer
local   all       all                     scram-sha-256
host    lumen     lumen_app   all         scram-sha-256
host    synapse   synapse     all         scram-sha-256
host    all       all         all         reject
"""
    write(out / "postgres" / "pg_hba.conf", hba, 0o644)
    mem = mem_total_mb(cfg)
    shared = cfg["POSTGRES_SHARED_BUFFERS"] or f"{max(128, min(mem // 8, 2048))}MB"
    conf = f"""# Generated by Lumen
data_directory = '/var/lib/postgresql/data/pgdata'
listen_addresses = '*'
max_connections = 100
shared_buffers = {shared}
effective_cache_size = {max(256, mem // 2)}MB
work_mem = 8MB
maintenance_work_mem = 128MB
wal_compression = on
password_encryption = scram-sha-256
log_min_duration_statement = 2000
log_connections = off
log_disconnections = off
log_line_prefix = '%m [%p] %u@%d '
hba_file = '/etc/postgresql/pg_hba.conf'
"""
    write(out / "postgres" / "postgresql.conf", conf, 0o644)


def caddy_tls(mode: str, cfg) -> str:
    if mode == "internal":
        return "\ttls internal\n"
    return ""


SECURITY_HEADERS = """(lumen_headers) {
	header {
		Strict-Transport-Security "max-age=63072000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		X-Frame-Options "DENY"
		-Server
		-X-Powered-By
	}
}
"""


def render_caddy(cfg, out: Path) -> None:
    p, app, mx, ops = cfg["LUMEN_PRIMARY_DOMAIN"], cfg["LUMEN_APP_DOMAIN"], cfg["LUMEN_MATRIX_DOMAIN"], cfg["LUMEN_OPS_DOMAIN"]
    sock = "/sockets"
    acme = ""
    if cfg["TLS_MODE"] == "acme" or cfg["OPS_TLS_MODE"] == "acme":
        acme = f"\temail {cfg['ADMIN_EMAIL']}\n"
        if cfg["ACME_CA"]:
            acme += f"\tacme_ca {cfg['ACME_CA']}\n"
    admin_cidrs = ["127.0.0.1/8", "::1/128"]
    if truthy(cfg["WIREGUARD_ENABLED"]):
        admin_cidrs.append(cfg["WG_SUBNET"])
    admin_cidrs += split_list(cfg["ADMIN_ALLOWED_CIDRS"])
    server_wk = json.dumps({"m.server": f"{mx}:443"})
    client_wk = json.dumps({"m.homeserver": {"base_url": f"https://{mx}"}})
    matrix_wellknown = f"""	handle /.well-known/matrix/server {{
		header Content-Type application/json
		header Access-Control-Allow-Origin *
		respond `{server_wk}` 200
	}}
	handle /.well-known/matrix/client {{
		header Content-Type application/json
		header Access-Control-Allow-Origin *
		respond `{client_wk}` 200
	}}
"""
    brand = """	handle_path /brand/* {
		root * /srv/brand
		file_server
		header Cache-Control "public, max-age=3600"
	}
"""
    chat_csp = (
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; "
        "img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; "
        "connect-src 'self' https: wss:; worker-src 'self' blob:; frame-src 'none'; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    )
    lines = [
        "# Generated by Lumen (deploy/lib/render.py). Do not edit.",
        "{",
        "\tadmin off",
        acme.rstrip("\n") if acme else "",
        "\tskip_install_trust" if "internal" in {cfg["TLS_MODE"], cfg["OPS_TLS_MODE"]} else "",
        "\tservers {",
        "\t\tprotocols h1 h2 h3",
        "\t\ttimeouts {",
        "\t\t\tread_header 15s",
        "\t\t\tidle 2m",
        "\t\t}",
        "\t}",
        "\tlog default {",
        "\t\toutput stdout",
        "\t\tformat filter {",
        "\t\t\twrap json",
        "\t\t\tfields {",
        "\t\t\t\trequest>uri query {",
        "\t\t\t\t\treplace access_token REDACTED",
        "\t\t\t\t\treplace loginToken REDACTED",
        "\t\t\t\t\treplace code REDACTED",
        "\t\t\t\t\treplace state REDACTED",
        "\t\t\t\t\treplace session REDACTED",
        "\t\t\t\t}",
        "\t\t\t\t# Privacy: access logs keep only the network part of client IPs.",
        "\t\t\t\trequest>remote_ip ip_mask {",
        "\t\t\t\t\tipv4 24",
        "\t\t\t\t\tipv6 48",
        "\t\t\t\t}",
        "\t\t\t\trequest>client_ip ip_mask {",
        "\t\t\t\t\tipv4 24",
        "\t\t\t\t\tipv6 48",
        "\t\t\t\t}",
        "\t\t\t}",
        "\t\t}",
        "\t}",
        "}",
        "",
        SECURITY_HEADERS,
        "(lumen_logskip) {",
        "\tlog_skip /invite/*",
        "\tlog_skip /setup/*",
        "\tlog_skip /accounts/password/reset/key/*",
        "\tlog_skip /accounts/confirm-email/*",
        "\tlog_skip /_synapse/client/oidc/callback*",
        "}",
        "",
        f"http://{p}, http://{app}, http://{mx} {{",
        "\tredir https://{host}{uri} 308",
        "}",
        "",
        f"{p} {{",
        caddy_tls(cfg["TLS_MODE"], cfg).rstrip("\n"),
        "\timport lumen_headers",
        "\timport lumen_logskip",
        "\tlog",
        "\tencode zstd gzip",
        "\trequest_body {",
        "\t\tmax_size 2MB",
        "\t}",
        "\troute {",
        "\t\t@private path /ops /ops/* /internal /internal/*",
        "\t\trespond @private 404",
        matrix_wellknown.rstrip("\n").replace("\n\t", "\n\t\t").replace("\thandle", "\t\thandle", 1),
        brand.rstrip("\n").replace("\n\t", "\n\t\t").replace("\thandle_path", "\t\thandle_path", 1),
        f"\t\treverse_proxy unix/{sock}/portal.sock {{",
        "\t\t\theader_up X-Real-IP {remote_host}",
        "\t\t}",
        "\t}",
        "}",
        "",
        f"{app} {{",
        caddy_tls(cfg["TLS_MODE"], cfg).rstrip("\n"),
        "\timport lumen_headers",
        "\timport lumen_logskip",
        "\tlog",
        "\tencode zstd gzip",
        "\trequest_body {",
        "\t\tmax_size 64KB",
        "\t}",
        "\theader {",
        f'\t\tContent-Security-Policy "{chat_csp}"',
        '\t\tPermissions-Policy "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()"',
        '\t\tCross-Origin-Opener-Policy "same-origin"',
        '\t\tCross-Origin-Resource-Policy "same-origin"',
        "\t}",
        brand.rstrip("\n"),
        "\thandle /config.json {",
        "\t\troot * /srv/chat-config",
        "\t\tfile_server",
        '\t\theader Cache-Control "no-store"',
        "\t}",
        "\thandle {",
        "\t\troot * /srv/chat",
        "\t\ttry_files {path} /index.html",
        "\t\tfile_server",
        "\t\t@assets path /assets/*",
        '\t\theader @assets Cache-Control "public, max-age=31536000, immutable"',
        "\t\t@html path / /index.html",
        '\t\theader @html Cache-Control "no-cache"',
        "\t}",
        "}",
        "",
        f"{mx} {{",
        caddy_tls(cfg["TLS_MODE"], cfg).rstrip("\n"),
        "\timport lumen_headers",
        "\timport lumen_logskip",
        "\tlog",
        "\t@upload path_regexp upload ^/_matrix/(media|client)/[^/]+/(media/)?upload",
        "\trequest_body @upload {",
        f"\t\tmax_size {int(cfg['DEFAULT_MAX_UPLOAD_MB']) + 16}MB",
        "\t}",
        "\t@other not path_regexp ^/_matrix/(media|client)/[^/]+/(media/)?upload",
        "\trequest_body @other {",
        "\t\tmax_size 64MB",
        "\t}",
        "\troute {",
        "\t\t@admin path /_synapse/admin /_synapse/admin/*",
        "\t\trespond @admin 404",
        matrix_wellknown.rstrip("\n").replace("\n\t", "\n\t\t").replace("\thandle", "\t\thandle", 1),
        "\t\t@matrix path /_matrix/* /_synapse/client/*",
        "\t\thandle @matrix {",
        f"\t\t\treverse_proxy unix/{sock}/synapse.sock {{",
        "\t\t\t\ttransport http {",
        "\t\t\t\t\tread_timeout 10m",
        "\t\t\t\t\twrite_timeout 10m",
        "\t\t\t\t}",
        "\t\t\t}",
        "\t\t}",
        "\t\trespond 404",
        "\t}",
        "}",
        "",
        f"{ops}:{cfg['LUMEN_OPS_PORT']} {{",
        caddy_tls(cfg["OPS_TLS_MODE"], cfg).rstrip("\n"),
        "\timport lumen_headers",
        "\tlog",
        "\trequest_body {",
        "\t\tmax_size 2MB",
        "\t}",
        f"\t@outside not remote_ip {' '.join(admin_cidrs)}",
        "\troute {",
        "\t\t# Network allow-list first: anything else is dropped without a response.",
        "\t\tabort @outside",
        "\t\t@internal path /internal /internal/*",
        "\t\trespond @internal 404",
        "\t\thandle_path /brand/* {",
        "\t\t\troot * /srv/brand",
        "\t\t\tfile_server",
        "\t\t}",
        f"\t\treverse_proxy unix/{sock}/ops.sock {{",
        "\t\t\theader_up X-Real-IP {remote_host}",
        "\t\t\theader_up X-Lumen-Gateway {file./run/secrets/ops_gateway_secret}",
        "\t\t}",
        "\t}",
        "}",
        "",
    ]
    text = "\n".join(line for line in lines if line != "") + "\n"
    write(out / "caddy" / "Caddyfile", text, 0o640)


def render_coturn(cfg, out: Path, secrets: Path) -> None:
    if not truthy(cfg["VOIP_ENABLED"]):
        return
    secret_file = secrets / "turn_shared_secret"
    turn_secret = secret_file.read_text().strip() if secret_file.exists() else "RENDER_PLACEHOLDER"
    ext = cfg["TURN_EXTERNAL_IP"]
    conf = f"""# Generated by Lumen. TURN relay for 1:1 calls (credentials are time-limited HMACs issued by Synapse).
listening-port=3478
min-port={cfg['TURN_MIN_PORT']}
max-port={cfg['TURN_MAX_PORT']}
realm={cfg['LUMEN_MATRIX_DOMAIN']}
use-auth-secret
static-auth-secret={turn_secret}
{"external-ip=" + ext if ext else ""}
fingerprint
no-cli
no-tls
no-dtls
no-multicast-peers
no-tcp-relay
stale-nonce=600
user-quota=12
total-quota=1200
bps-capacity=0
log-file=stdout
no-software-attribute
# Never relay into private/internal networks (prevents SSRF through TURN).
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.0.2.0-192.0.2.255
denied-peer-ip=192.88.99.0-192.88.99.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=198.51.100.0-198.51.100.255
denied-peer-ip=203.0.113.0-203.0.113.255
denied-peer-ip=240.0.0.0-255.255.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
"""
    write(out / "coturn" / "turnserver.conf", conf, 0o640)


def render_chat_config(cfg, out: Path) -> None:
    data = {
        "brand": {"name": cfg["BRAND_NAME"], "short_name": cfg["BRAND_SHORT_NAME"]},
        "homeserver": {"base_url": f"https://{cfg['LUMEN_MATRIX_DOMAIN']}", "server_name": cfg["MATRIX_SERVER_NAME"]},
        "sso": {"idp_id": "oidc-lumen", "label": f"Continue with your {cfg['BRAND_SHORT_NAME']} account"},
        "portal_url": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}",
        "allow_custom_homeserver": True,
        "voip_enabled": truthy(cfg["VOIP_ENABLED"]),
        "privacy_url": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}/privacy/",
        "help_url": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}/docs/",
    }
    write(out / "chat" / "config.json", json.dumps(data, indent=2) + "\n", 0o644)


def render_compose_env(cfg, out: Path, repo: Path) -> None:
    versions = parse_conf(repo / "deploy" / "versions.env")
    env = {
        "COMPOSE_PROJECT_NAME": cfg["LUMEN_PROJECT"],
        "LUMEN_REPO_DIR": str(repo),
        "LUMEN_CONFIG_DIR": cfg["LUMEN_CONFIG_DIR"],
        "LUMEN_DATA_DIR": cfg["LUMEN_DATA_DIR"],
        "LUMEN_SOCKET_DIR": cfg["LUMEN_SOCKET_DIR"],
        "LUMEN_RENDERED_DIR": f"{cfg['LUMEN_CONFIG_DIR']}/rendered",
        "LUMEN_SECRETS_DIR": f"{cfg['LUMEN_CONFIG_DIR']}/secrets",
        "LUMEN_BRANDING_DIR": f"{cfg['LUMEN_CONFIG_DIR']}/branding",
        "LUMEN_CHAT_DIST": cfg["CHAT_DIST_DIR"] or f"{cfg['LUMEN_DATA_DIR']}/www/chat",
        "LUMEN_STATUS_DIR": f"{cfg['LUMEN_DATA_DIR']}/status",
        "LUMEN_AGENT_DIR": "/run/lumen-agent",
        "LUMEN_PRIMARY_DOMAIN": cfg["LUMEN_PRIMARY_DOMAIN"],
        "LUMEN_APP_DOMAIN": cfg["LUMEN_APP_DOMAIN"],
        "LUMEN_MATRIX_DOMAIN": cfg["LUMEN_MATRIX_DOMAIN"],
        "LUMEN_OPS_DOMAIN": cfg["LUMEN_OPS_DOMAIN"],
        "LUMEN_OPS_PORT": cfg["LUMEN_OPS_PORT"],
        "MATRIX_SERVER_NAME": cfg["MATRIX_SERVER_NAME"],
        "EXTRA_HOSTS_IP": cfg["EXTRA_HOSTS_IP"],
        "CA_BUNDLE_HOST_PATH": cfg["CA_BUNDLE_HOST_PATH"]
        or (f"{cfg['LUMEN_CONFIG_DIR']}/ca/bundle.crt" if cfg["TLS_MODE"] == "internal" else "/dev/null"),
        "LUMEN_VERSION": cfg["LUMEN_VERSION"] or versions.get("LUMEN_VERSION", "dev"),
        "UID_APP": str(UID_APP),
        "UID_CADDY": str(UID_CADDY),
        "GID_SECRETS": str(GID_SECRETS),
        "GID_SOCKETS": str(GID_SOCKETS),
        "TURN_MIN_PORT": cfg["TURN_MIN_PORT"],
        "TURN_MAX_PORT": cfg["TURN_MAX_PORT"],
    }
    if cfg["LUMEN_BUILD_EXTRA_CA"]:
        env["LUMEN_BUILD_EXTRA_CA"] = cfg["LUMEN_BUILD_EXTRA_CA"]
    if cfg["TLS_MODE"] == "internal":
        # Test/staging only: trust the bundle that includes Caddy's local CA.
        env["SYNAPSE_SSL_CERT_FILE"] = "/etc/lumen-ca/ca.crt"
    for k, v in versions.items():
        env[k] = v
    text = "# Generated by Lumen (deploy/lib/render.py). Non-secret values only.\n"
    text += "".join(f"{k}={v}\n" for k, v in env.items())
    write(out / "compose.env", text, 0o640)


def render_app_env(cfg, out: Path) -> None:
    """Environment for portal/ops/worker containers (non-secret)."""
    keys = [
        "LUMEN_PRIMARY_DOMAIN", "LUMEN_APP_DOMAIN", "LUMEN_MATRIX_DOMAIN", "LUMEN_OPS_DOMAIN", "LUMEN_OPS_PORT",
        "MATRIX_SERVER_NAME", "REGISTRATION_MODE", "FEDERATION_MODE", "FEDERATION_ALLOWLIST",
        "FEDERATION_PROBE_NOTARY", "PRESENCE_ENABLED", "VOIP_ENABLED", "WIREGUARD_ENABLED", "SMTP_HOST",
        "SMTP_PORT", "SMTP_USER", "SMTP_SECURITY", "SMTP_FROM", "BILLING_PROVIDER", "BILLING_CURRENCY",
        "BILLING_GRACE_DAYS", "STRIPE_PUBLISHABLE_KEY", "BRAND_NAME", "BRAND_SHORT_NAME", "BRAND_TAGLINE",
        "BRAND_LEGAL_NAME", "BRAND_JURISDICTION", "SUPPORT_EMAIL", "SECURITY_EMAIL", "PRIVACY_EMAIL",
        "PUBLIC_STATUS_PAGE", "SYNAPSE_OIDC_CLIENT_ID", "LOG_LEVEL",
    ]
    text = "# Generated by Lumen. Non-secret application settings.\n"
    text += "".join(f"{k}={cfg[k]}\n" for k in keys)
    text += "SYNAPSE_INTERNAL_URL=http://synapse:8008\n"
    text += "POSTGRES_HOST=postgres\nPOSTGRES_DB=lumen\nPOSTGRES_USER=lumen_app\n"
    text += "HOST_AGENT_SOCKET=/run/lumen-agent/agent.sock\nLUMEN_STATUS_DIR=/var/lib/lumen/status\n"
    text += "LUMEN_DISK_PROBE_PATH=/var/lib/lumen/status\n"
    if cfg["TLS_MODE"] == "internal":
        text += "LUMEN_PROBE_CA_BUNDLE=/etc/lumen-ca/ca.crt\nREQUESTS_CA_BUNDLE=/etc/lumen-ca/ca.crt\n"
    write(out / "app.env", text, 0o640)


def copy_synapse_templates(repo: Path, out: Path, cfg) -> None:
    src = repo / "deploy" / "templates" / "synapse-templates"
    dst = out / "synapse" / "templates"
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    for f in sorted(list(src.glob("*.html")) + list(src.glob("*.css"))):
        text = f.read_text(encoding="utf-8")
        text = text.replace("__BRAND_NAME__", cfg["BRAND_NAME"]).replace("__PORTAL_URL__", f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}")
        (dst / f.name).write_text(text, encoding="utf-8")
        os.chmod(dst / f.name, 0o644)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--conf", required=True, type=Path)
    ap.add_argument("--secrets", required=True, type=Path)
    ap.add_argument("--repo", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--print-config", action="store_true", help="print resolved config (no secrets) as JSON and exit")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.conf)
    except (ConfigError, OSError) as exc:
        print(f"Configuration error in {args.conf}:\n{exc}", file=sys.stderr)
        return 2
    if args.print_config:
        print(json.dumps(cfg, indent=2, sort_keys=True))
        return 0
    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, mode=0o750)
    render_synapse(cfg, out)
    copy_synapse_templates(args.repo, out, cfg)
    render_postgres(cfg, out)
    render_caddy(cfg, out)
    render_coturn(cfg, out, args.secrets)
    render_chat_config(cfg, out)
    render_compose_env(cfg, out, args.repo)
    render_app_env(cfg, out)
    print(f"rendered configuration into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
