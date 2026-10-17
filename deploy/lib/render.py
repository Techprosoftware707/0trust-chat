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
    "LUMEN_TEST_SETUP": "false",  # install.sh --test: no domain (see configure.sh test_configure)
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
    "SYNAPSE_IP_RANGE_WHITELIST": "",  # test environments only: allow federation to private ranges
    "PRESENCE_ENABLED": "true",
    # Voice/video calls: MatrixRTC + LiveKit SFU (with its embedded TURN) + lk-jwt-service.
    "CALLS_ENABLED": "true",
    "LUMEN_RTC_DOMAIN": "",  # default rtc.<primary>: SFU signalling (wss) through Caddy
    "CALLS_PUBLIC_IP": "",  # IP advertised in ICE candidates; empty = discover with STUN
    "CALLS_UDP_PORTS": "7882-7889",  # WebRTC media over UDP (LiveKit UDP mux), one port or a range
    "CALLS_TCP_PORT": "7881",  # ICE over TCP when UDP is blocked
    "CALLS_TURN_UDP_PORT": "3478",  # TURN/UDP
    # Deprecated, ignored: LiveKit 1.13 only advertises TURN/TLS as turns:<domain>:443 (it expects
    # a TLS-terminating L4 proxy there), and 443 is Caddy's, so Lumen does not offer TURN/TLS.
    "CALLS_TURN_TLS_PORT": "",
    # Interface LiveKit uses for media when CALLS_PUBLIC_IP is not an address of this host
    # (1:1 NAT, STUN discovery). Empty = the interface of the default route, detected at render.
    "CALLS_INTERFACE": "",
    "CALLS_MAX_PARTICIPANTS": "0",  # per call; 0 = no fixed limit (bounded by server capacity)
    "CALLS_ALLOW_PRIVATE_NODE_IP": "false",  # test labs only: TURN may relay to a private node IP
    "RTC_NETWORK_SUBNET": "172.30.42.0/28",  # Docker network: authorization service <-> host
    "VOIP_ENABLED": "",  # deprecated (legacy 1:1 calls via coturn were replaced by CALLS_*)
    "TURN_EXTERNAL_IP": "",  # deprecated alias of CALLS_PUBLIC_IP
    # Native/desktop apps (docs/apps/integration.md): URL scheme for the SSO return and
    # deep links, and the identities that verified app links / universal links accept.
    "APP_URL_SCHEME": "io.lumen.secure",
    "APP_LINKS_ANDROID_PACKAGE": "io.lumen.secure",
    "APP_LINKS_ANDROID_SHA256": "",  # comma-separated signing-certificate fingerprints (AA:BB:...)
    "APP_LINKS_APPLE_TEAM_ID": "",
    "APP_LINKS_APPLE_BUNDLE_ID": "io.lumen.secure",
    # Push notifications for the mobile apps: Synapse pushers -> Sygnal -> FCM / APNs.
    # Payloads carry no message content (event_id_only, push.include_content: false).
    "PUSH_ENABLED": "false",
    "PUSH_PORT": "5000",  # Sygnal on 127.0.0.1 (host network), reached through Caddy only
    "PUSH_ANDROID_APP_ID": "io.lumen.secure.android",
    "PUSH_IOS_APP_ID": "io.lumen.secure.ios",
    "PUSH_FCM_PROJECT_ID": "",  # needs the secret push_fcm_service_account (lumenctl set-secret)
    "PUSH_APNS_TEAM_ID": "",  # needs the secret push_apns_key (.p8, lumenctl set-secret)
    "PUSH_APNS_KEY_ID": "",
    "PUSH_APNS_TOPIC": "",  # default: APP_LINKS_APPLE_BUNDLE_ID
    "PUSH_APNS_SANDBOX": "false",  # true for development builds (APNs sandbox)
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
    # test/unified-business-workspace: "Nexus Office AI" is a temporary test brand
    # (docs/nexus/IMPLEMENTATION-NOTES.md); BRAND_* in lumen.conf still override it.
    "BRAND_NAME": "Nexus Office AI",
    "BRAND_SHORT_NAME": "Nexus",
    "BRAND_TAGLINE": "Your encrypted business workspace: chat, calls, CRM and AI in one place.",
    # Nexus: production | test | development. Anything but production shows a persistent
    # test banner and allows the synthetic demo-data commands. This branch is a test build.
    "NEXUS_ENVIRONMENT": "test",
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

BOOL_KEYS = {"PRESENCE_ENABLED", "CALLS_ENABLED", "CALLS_ALLOW_PRIVATE_NODE_IP", "WIREGUARD_ENABLED", "PUBLIC_STATUS_PAGE",
             "PUSH_ENABLED", "PUSH_APNS_SANDBOX"}
DOMAIN_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# UIDs/GIDs used inside containers (documented in docs/operations/admin-guide.md).
UID_APP = 10001
UID_CADDY = 10200
GID_SECRETS = 10100
GID_SOCKETS = 10300
UID_SYNAPSE = 991
UID_LIVEKIT = 10400
UID_LKJWT = 10401
UID_SYGNAL = 10500
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
    cfg["LUMEN_RTC_DOMAIN"] = (cfg["LUMEN_RTC_DOMAIN"] or f"rtc.{p}").lower()
    cfg["CALLS_PUBLIC_IP"] = cfg["CALLS_PUBLIC_IP"] or cfg["TURN_EXTERNAL_IP"]
    cfg["MATRIX_SERVER_NAME"] = (cfg["MATRIX_SERVER_NAME"] or p).lower()
    cfg["PUSH_APNS_TOPIC"] = cfg["PUSH_APNS_TOPIC"] or cfg["APP_LINKS_APPLE_BUNDLE_ID"]
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
    for key in ("LUMEN_PRIMARY_DOMAIN", "LUMEN_APP_DOMAIN", "LUMEN_MATRIX_DOMAIN", "LUMEN_OPS_DOMAIN", "LUMEN_RTC_DOMAIN", "MATRIX_SERVER_NAME"):
        if not DOMAIN_RE.match(cfg[key]):
            errors.append(f"{key}={cfg[key]!r} is not a valid domain name")
    hosts = [cfg["LUMEN_PRIMARY_DOMAIN"], cfg["LUMEN_APP_DOMAIN"], cfg["LUMEN_MATRIX_DOMAIN"], cfg["LUMEN_OPS_DOMAIN"], cfg["LUMEN_RTC_DOMAIN"]]
    if len(set(hosts)) != len(hosts):
        errors.append("primary, app, matrix, ops and rtc domains must all be different")
    if cfg["MATRIX_SERVER_NAME"] not in {cfg["LUMEN_PRIMARY_DOMAIN"], cfg["LUMEN_MATRIX_DOMAIN"]}:
        errors.append("MATRIX_SERVER_NAME must be the primary domain (recommended) or the matrix domain")
    if not EMAIL_RE.match(cfg["ADMIN_EMAIL"]):
        errors.append("ADMIN_EMAIL must be a valid email address (used for ACME and as operator contact)")
    if cfg["CHAT_DIST_DIR"] and (not cfg["CHAT_DIST_DIR"].startswith("/") or Path(cfg["CHAT_DIST_DIR"]).name != "chat"):
        errors.append("CHAT_DIST_DIR must be an absolute path ending in /chat (its parent directory is served read-only)")
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
    if cfg["NEXUS_ENVIRONMENT"] not in {"production", "test", "development"}:
        errors.append("NEXUS_ENVIRONMENT must be production, test or development")
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
    num_keys = ("CALLS_TCP_PORT", "CALLS_TURN_UDP_PORT", "CALLS_MAX_PARTICIPANTS", "WG_PORT",
                "LUMEN_OPS_PORT", "SMTP_PORT", "BILLING_GRACE_DAYS", "DEFAULT_MAX_UPLOAD_MB")
    for k in num_keys:
        if not cfg[k].isdigit():
            errors.append(f"{k} must be a number")
    try:
        lo, hi = udp_port_range(cfg["CALLS_UDP_PORTS"])
        if not (1024 < lo <= hi <= 65535) or hi - lo > 63:
            raise ValueError
    except ValueError:
        errors.append("CALLS_UDP_PORTS must be a port or a range of at most 64 ports above 1024 (e.g. 7882-7889)")
    call_ports = [cfg[k] for k in ("CALLS_TCP_PORT", "LUMEN_OPS_PORT") if cfg[k].isdigit()]
    if len(set(call_ports)) != len(call_ports) or {"80", "443"} & set(call_ports):
        errors.append("CALLS_TCP_PORT and LUMEN_OPS_PORT must differ from each other and from 80/443")
    if cfg["CALLS_INTERFACE"] and not re.fullmatch(r"[A-Za-z0-9_.:@-]{1,15}", cfg["CALLS_INTERFACE"]):
        errors.append("CALLS_INTERFACE must be a network interface name (e.g. eth0)")
    if cfg["CALLS_PUBLIC_IP"]:
        try:
            ipaddress.ip_address(cfg["CALLS_PUBLIC_IP"])
        except ValueError:
            errors.append("CALLS_PUBLIC_IP must be an IP address")
    try:
        rtc_net = ipaddress.ip_network(cfg["RTC_NETWORK_SUBNET"], strict=True)
        if not rtc_net.is_private or rtc_net.version != 4 or not 24 <= rtc_net.prefixlen <= 28:
            raise ValueError
    except ValueError:
        errors.append("RTC_NETWORK_SUBNET must be a private IPv4 network between /24 and /28 (e.g. 172.30.42.0/28)")
    if cfg["LUMEN_OPS_PORT"] in {"80", "443"}:
        errors.append("LUMEN_OPS_PORT must not be 80 or 443")
    reverse_dns = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_-]*)+$", re.I)
    for k in ("APP_URL_SCHEME", "APP_LINKS_ANDROID_PACKAGE", "APP_LINKS_APPLE_BUNDLE_ID", "PUSH_ANDROID_APP_ID",
              "PUSH_IOS_APP_ID", "PUSH_APNS_TOPIC"):
        if not reverse_dns.match(cfg[k]):
            errors.append(f"{k} must be a reverse-DNS identifier (e.g. io.lumen.secure)")
    for fp in split_list(cfg["APP_LINKS_ANDROID_SHA256"]):
        if not re.fullmatch(r"([0-9A-F]{2}:){31}[0-9A-F]{2}", fp.upper()):
            errors.append("APP_LINKS_ANDROID_SHA256 must list SHA-256 fingerprints like AB:CD:...(32 bytes)")
            break
    for k in ("APP_LINKS_APPLE_TEAM_ID", "PUSH_APNS_TEAM_ID", "PUSH_APNS_KEY_ID"):
        if cfg[k] and not re.fullmatch(r"[A-Z0-9]{10}", cfg[k]):
            errors.append(f"{k} must be a 10-character Apple identifier")
    if cfg["PUSH_FCM_PROJECT_ID"] and not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", cfg["PUSH_FCM_PROJECT_ID"]):
        errors.append("PUSH_FCM_PROJECT_ID must be a Firebase project ID")
    if bool(cfg["PUSH_APNS_TEAM_ID"]) != bool(cfg["PUSH_APNS_KEY_ID"]):
        errors.append("PUSH_APNS_TEAM_ID and PUSH_APNS_KEY_ID are needed together")
    if not cfg["PUSH_PORT"].isdigit() or not 1024 < int(cfg["PUSH_PORT"]) < 65536:
        errors.append("PUSH_PORT must be a port above 1024")
    if cfg["PUSH_ENABLED"].lower() in {"true", "yes", "1", "on"} and not (cfg["PUSH_FCM_PROJECT_ID"] or cfg["PUSH_APNS_KEY_ID"]):
        errors.append("PUSH_ENABLED needs PUSH_FCM_PROJECT_ID (Android) and/or PUSH_APNS_TEAM_ID + PUSH_APNS_KEY_ID (iOS)")
    for k in BOOL_KEYS:
        if cfg[k].lower() not in {"true", "false", "yes", "no", "1", "0", "on", "off"}:
            errors.append(f"{k} must be true or false")
    if errors:
        raise ConfigError("\n".join(f"  - {e}" for e in errors))


def udp_port_range(value: str) -> tuple[int, int]:
    lo, _, hi = value.strip().partition("-")
    return int(lo), int(hi or lo)


def rtc_ips(cfg) -> dict[str, str]:
    """Fixed addresses on the rtc network: gateway (host), authorization service, worker."""
    net = ipaddress.ip_network(cfg["RTC_NETWORK_SUBNET"])
    return {"gateway": str(net[1]), "lkjwt": str(net[2]), "worker": str(net[3])}


def livekit_key_id(secrets: Path) -> str:
    """The API key *name* (not secret) from the `livekit_keys` secret ("<name>: <secret>")."""
    try:
        return (secrets / "livekit_keys").read_text().split(":", 1)[0].strip() or "RENDER_PLACEHOLDER"
    except OSError:
        return "RENDER_PLACEHOLDER"


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
    if isinstance(v, float):
        return repr(v)
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
            # the web app, and the native/desktop apps' SSO return (RFC 8252 private-use scheme)
            "client_whitelist": [f"https://{cfg['LUMEN_APP_DOMAIN']}/", f"{cfg['APP_URL_SCHEME']}:/sso-callback"],
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
        # Logins here are SSO only (password login is disabled): the client exchanges a
        # single-use, short-lived random login token. Brute-force protection lives at
        # the portal (allauth rate limits). Synapse's default per-IP login limit (burst
        # 5, then ~1 per 5.5 min) would lock out a team signing in from one office NAT.
        "rc_login": {
            "address": {"per_second": 0.5, "burst_count": 30},
            "account": {"per_second": 0.1, "burst_count": 10},
            "failed_attempts": {"per_second": 0.05, "burst_count": 5},
        },
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
        # Synapse reads ONE certificate per file, so list each CA file separately.
        hs["federation_custom_ca_list"] = [p.strip() for p in cfg["FEDERATION_CUSTOM_CA"].split(",") if p.strip()]
    if cfg["SYNAPSE_IP_RANGE_WHITELIST"]:
        # Synapse blocks outbound federation to private ranges (SSRF protection);
        # only test networks should ever whitelist any.
        hs["ip_range_whitelist"] = split_list(cfg["SYNAPSE_IP_RANGE_WHITELIST"])
    hs["default_room_version"] = "12"
    # Push notifications never carry message content, whatever format a client asks for.
    hs["push"] = {"include_content": False}
    if truthy(cfg["CALLS_ENABLED"]):
        # MatrixRTC (Element Call protocol) with a LiveKit SFU, per Element Call's
        # self-hosting requirements and MSC4195: clients ask *this* homeserver for an
        # SFU token; Synapse proxies the request (MSC4512) to lk-jwt-service, which
        # checks that the user is joined to the room (MSC4502) before minting it.
        hs["experimental_features"] = {
            "msc3266_enabled": True,  # room summary API
            "msc4143_enabled": True,  # /rtc/transports endpoint (MSC4519)
            "msc4222_enabled": True,  # sync state_after (reliable call membership state)
            "msc4502_enabled": True,  # appservice scope: rooms:is_joined
            "msc4512_enabled": True,  # appservice request proxying for /rtc/livekit
        }
        hs["max_event_delay_duration"] = "24h"  # MSC4140 delayed leave events
        # Call key distribution is bursty; heart-beats restart delayed events every ~5 s.
        hs["rc_message"] = {"per_second": 0.5, "burst_count": 30}
        hs["rc_delayed_event_mgmt"] = {"per_second": 1, "burst_count": 20}
        hs["matrix_rtc"] = {"transports": [{"type": "livekit", "url": f"wss://{cfg['LUMEN_RTC_DOMAIN']}"}]}
        hs["app_service_config_files"] = ["/run/secrets/lkjwt_registration"]
        # Members of private rooms may join calls: the call membership and slot
        # events are state events, which otherwise need power level 50. (Synapse
        # replaces the whole `events` map, so the defaults are repeated here.)
        call_events = {
            "m.room.name": 50, "m.room.power_levels": 100, "m.room.history_visibility": 100,
            "m.room.canonical_alias": 50, "m.room.avatar": 50, "m.room.tombstone": 150,
            "m.room.server_acl": 100, "m.room.encryption": 100,
            "org.matrix.msc3401.call.member": 0, "org.matrix.msc4143.rtc.member": 0,
            "org.matrix.msc4143.rtc.slot": 0,
        }
        hs["default_power_level_content_override"] = {
            preset: {"events": call_events} for preset in ("private_chat", "trusted_private_chat")
        }
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


def serves_test_ca(cfg) -> bool:
    """Test setups with the private CA offer that CA (a public certificate, nothing secret) as a
    plain-http download, so test devices can be set up to trust it. The installer and
    `lumenctl test-ca` print its SHA-256 fingerprint to compare before trusting it."""
    return truthy(cfg["LUMEN_TEST_SETUP"]) and cfg["TLS_MODE"] == "internal"


def http_sites(cfg, calls: bool) -> list[str]:
    """Port 80: redirect to https (plus, in test setups, the test CA download)."""
    p, app, mx, rtc = cfg["LUMEN_PRIMARY_DOMAIN"], cfg["LUMEN_APP_DOMAIN"], cfg["LUMEN_MATRIX_DOMAIN"], cfg["LUMEN_RTC_DOMAIN"]
    hosts = [app, mx] + ([rtc] if calls else [])
    lines = []
    if serves_test_ca(cfg):
        lines += [
            f"http://{p} {{",
            "\thandle /lumen-test-ca.crt {",
            # Only the root certificate: the rewrite pins the one file, whatever the request.
            "\t\troot * /data/caddy/pki/authorities/local",
            "\t\trewrite * /root.crt",
            '\t\theader Content-Type "application/x-x509-ca-cert"',
            '\t\theader Content-Disposition "attachment; filename=lumen-test-ca.crt"',
            '\t\theader Cache-Control "no-store"',
            "\t\tfile_server",
            "\t}",
            "\thandle {",
            "\t\tredir https://{host}{uri} 308",
            "\t}",
            "}",
            "",
        ]
    else:
        hosts.insert(0, p)
    lines += [", ".join(f"http://{h}" for h in hosts) + " {", "\tredir https://{host}{uri} 308", "}", ""]
    return lines


def push_enabled(cfg) -> bool:
    return truthy(cfg["PUSH_ENABLED"])


def push_route(cfg) -> list[str]:
    """The push gateway endpoint on the homeserver host. Only this server's homeserver
    calls it (pushers are always registered on the user's own homeserver; its requests
    arrive from the Docker networks), so every other source gets 404."""
    if not cfg.get("_PUSH_READY"):  # disabled, or no platform credential yet: no gateway runs
        return ["\t\t@push_off path /_matrix/push/*", "\t\trespond @push_off 404"]
    return [
        "\t\t@push_gw {",
        "\t\t\tpath /_matrix/push/v1/notify",
        "\t\t\tremote_ip private_ranges",
        "\t\t}",
        "\t\thandle @push_gw {",
        f"\t\t\treverse_proxy 127.0.0.1:{int(cfg['PUSH_PORT'])}",
        "\t\t}",
        "\t\t@push_other path /_matrix/push/*",
        "\t\trespond @push_other 404",
    ]


def client_wellknown(cfg) -> dict:
    """/.well-known/matrix/client: the homeserver plus the public endpoints the Lumen apps
    discover at runtime (docs/apps/integration.md section 2). Nothing here is secret."""
    p, app, mx = cfg["LUMEN_PRIMARY_DOMAIN"], cfg["LUMEN_APP_DOMAIN"], cfg["LUMEN_MATRIX_DOMAIN"]
    lumen = {
        "version": 1,
        "brand": {"name": cfg["BRAND_NAME"], "short_name": cfg["BRAND_SHORT_NAME"]},
        "portal_url": f"https://{p}",
        "account_url": f"https://{p}/portal/security/",
        # Account deletion must be reachable from inside the apps (App Store guideline 5.1.1(v)).
        "account_delete_url": f"https://{p}/portal/privacy/delete/",
        "privacy_url": f"https://{p}/privacy/",
        "help_url": f"https://{p}/docs/",
        "sso_idp_id": "oidc-lumen",
        "web_app_url": f"https://{app}",
    }
    if cfg["REGISTRATION_MODE"] != "closed":
        lumen["signup_url"] = f"https://{p}/accounts/signup/"
    if truthy(cfg["CALLS_ENABLED"]):
        lumen["call_widget_url"] = f"https://{app}/widget/call/"
    if cfg.get("_PUSH_READY"):
        # Only once a platform can actually deliver: otherwise the apps would register
        # pushers that the gateway rejects (and the homeserver then deletes).
        lumen["push_gateway_url"] = f"https://{mx}/_matrix/push/v1/notify"
    return {"m.homeserver": {"base_url": f"https://{mx}"}, "io.lumen.app": lumen}


def app_links_handlers(cfg) -> list[str]:
    """Verified app links (Android assetlinks.json) and universal links (Apple AASA) for
    https://<app>/ URLs, served only when the operator configured the app identities."""
    lines: list[str] = []
    fps = [f.upper() for f in split_list(cfg["APP_LINKS_ANDROID_SHA256"])]
    if fps:
        assetlinks = [{
            "relation": ["delegate_permission/common.handle_all_urls"],
            "target": {"namespace": "android_app", "package_name": cfg["APP_LINKS_ANDROID_PACKAGE"],
                       "sha256_cert_fingerprints": fps},
        }]
        lines += ["	handle /.well-known/assetlinks.json {", "		header Content-Type application/json",
                  f"		respond `{json.dumps(assetlinks, separators=(',', ':'))}` 200", "	}"]
    if cfg["APP_LINKS_APPLE_TEAM_ID"]:
        app_id = f"{cfg['APP_LINKS_APPLE_TEAM_ID']}.{cfg['APP_LINKS_APPLE_BUNDLE_ID']}"
        aasa = {"applinks": {"details": [{"appIDs": [app_id], "components": [{"#": "/room/*"}, {"#": "/dm/*"}, {"#": "/user/*"}]}]}}
        lines += ["	handle /.well-known/apple-app-site-association {", "		header Content-Type application/json",
                  f"		respond `{json.dumps(aasa, separators=(',', ':'))}` 200", "	}"]
    return lines


def render_caddy(cfg, out: Path) -> None:
    p, app, mx, ops = cfg["LUMEN_PRIMARY_DOMAIN"], cfg["LUMEN_APP_DOMAIN"], cfg["LUMEN_MATRIX_DOMAIN"], cfg["LUMEN_OPS_DOMAIN"]
    rtc = cfg["LUMEN_RTC_DOMAIN"]
    calls = truthy(cfg["CALLS_ENABLED"])
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
    client_wk = json.dumps(client_wellknown(cfg), separators=(",", ":"))
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
        *http_sites(cfg, calls),
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
        *app_links_handlers(cfg),
        # The call widget for the mobile apps (docs/apps/integration.md 6.2); the apps bundle
        # their own copy and use this one only where their bundled copy cannot run.
        "\thandle /widget/call/* {",
        "\t\troot * /srv/www/chat",
        "\t\ttry_files {path} /widget/call/index.html",
        "\t\tfile_server",
        "\t\t@widget_assets path /widget/call/assets/*",
        '\t\theader @widget_assets Cache-Control "public, max-age=31536000, immutable"',
        "\t\t@widget_html path /widget/call/ /widget/call/index.html",
        '\t\theader @widget_html Cache-Control "no-cache"',
        "\t}",
        "\thandle /config.json {",
        "\t\troot * /srv/chat-config",
        "\t\tfile_server",
        '\t\theader Cache-Control "no-store"',
        "\t}",
        "\thandle {",
        "\t\troot * /srv/www/chat",
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
        *push_route(cfg),
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
        *(rtc_site(cfg) if calls else []),
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


def rtc_site(cfg) -> list[str]:
    """LiveKit signalling (WebSocket) for clients. The LiveKit server API (/twirp) and
    metrics are only reachable from the rtc Docker network (authorization service and
    worker); TURN and WebRTC media use their own ports and never pass through Caddy."""
    subnet = cfg["RTC_NETWORK_SUBNET"]
    return [
        f"{cfg['LUMEN_RTC_DOMAIN']} {{",
        caddy_tls(cfg["TLS_MODE"], cfg).rstrip("\n"),
        "\timport lumen_headers",
        "\tlog",
        "\trequest_body {",
        "\t\tmax_size 1MB",
        "\t}",
        "\troute {",
        f"\t\t@api_internal {{",
        "\t\t\tpath /twirp/*",
        f"\t\t\tremote_ip {subnet}",
        "\t\t}",
        "\t\thandle @api_internal {",
        "\t\t\treverse_proxy 127.0.0.1:7880",
        "\t\t}",
        f"\t\t@metrics_internal {{",
        "\t\t\tpath /metrics",
        f"\t\t\tremote_ip {subnet}",
        "\t\t}",
        "\t\thandle @metrics_internal {",
        "\t\t\treverse_proxy 127.0.0.1:6789",
        "\t\t}",
        "\t\t@private path /twirp/* /metrics /debug/* /sfu_webhook*",
        "\t\trespond @private 404",
        "\t\treverse_proxy 127.0.0.1:7880 {",
        "\t\t\theader_up X-Real-IP {remote_host}",
        "\t\t}",
        "\t}",
        "}",
        "",
    ]


def _ip_json(*args: str):
    """`ip -j ...` on this host, or None when unavailable (renders off-host, tests)."""
    import subprocess
    try:
        res = subprocess.run(["ip", "-j", *args], capture_output=True, text=True, timeout=5, check=True)
        return json.loads(res.stdout or "null")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def media_scope(cfg) -> dict:
    """Which local addresses LiveKit may use for media (ICE host candidates and sockets).

    Unrestricted, LiveKit binds every address of the host — Docker bridges, wg0, lab
    bridges — and can answer connectivity checks from an address the client never
    granted a TURN permission for (seen in the calls lab: relayed checks to the node IP
    went unanswered while replies left from another bridge address). So: only the
    advertised address when it is assigned to this host, otherwise only the interface
    that carries the default route (1:1 NAT, STUN discovery) or CALLS_INTERFACE.
    """
    ip = cfg["CALLS_PUBLIC_IP"]
    if ip:
        addrs = _ip_json("addr", "show") or []
        local = {a.get("local") for i in addrs for a in i.get("addr_info", [])}
        if ip in local:
            return {"ips": {"includes": [f"{ip}/{128 if ':' in ip else 32}"]}}
    iface = cfg["CALLS_INTERFACE"]
    if not iface:
        route = _ip_json("route", "get", "1.1.1.1") or []
        iface = route[0].get("dev", "") if route else ""
    return {"interfaces": {"includes": [iface]}} if iface else {}


def render_livekit(cfg, out: Path, secrets: Path) -> None:
    if not truthy(cfg["CALLS_ENABLED"]):
        return
    lo, hi = udp_port_range(cfg["CALLS_UDP_PORTS"])
    rtc: dict = {
        "tcp_port": int(cfg["CALLS_TCP_PORT"]),
        "udp_port": f"{lo}-{hi}" if hi > lo else str(lo),
        "allow_tcp_fallback": True,
        "congestion_control": {"enabled": True, "allow_pause": True},
        "enable_loopback_candidate": False,
    }
    if cfg["CALLS_PUBLIC_IP"]:
        rtc["use_external_ip"] = False
        rtc["node_ip"] = cfg["CALLS_PUBLIC_IP"]
    else:
        rtc["use_external_ip"] = True
    rtc.update(media_scope(cfg))
    turn: dict = {
        "enabled": True,
        "domain": cfg["LUMEN_RTC_DOMAIN"],
        "udp_port": int(cfg["CALLS_TURN_UDP_PORT"]),
        # Relay sockets live on this host and only talk to the SFU's own media ports.
        "relay_range_start": 40000,
        "relay_range_end": 40999,
        "ttl_seconds": 300,
        "per_user_relay_allocation_limit": 12,
        # Never relay into the admin VPN or the Docker networks.
        "deny_peer_cidrs": [cfg["WG_SUBNET"], cfg["RTC_NETWORK_SUBNET"], "172.16.0.0/12"],
    }
    if truthy(cfg["CALLS_ALLOW_PRIVATE_NODE_IP"]) and cfg["CALLS_PUBLIC_IP"]:
        # Test labs where the SFU's address is private: allow relaying to exactly it.
        turn["allow_restricted_peer_cidrs"] = [f"{cfg['CALLS_PUBLIC_IP']}/32"]
        turn["deny_peer_cidrs"] = [c for c in turn["deny_peer_cidrs"]
                                   if ipaddress.ip_address(cfg["CALLS_PUBLIC_IP"]) not in ipaddress.ip_network(c)]
    conf = {
        "port": 7880,
        "bind_addresses": ["127.0.0.1"],
        "prometheus": {"port": 6789},
        "rtc": rtc,
        "key_file": "/run/secrets/livekit_keys",
        "room": {
            # Rooms are created by the authorization service for authorised local users only.
            "auto_create": False,
            "empty_timeout": 300,
            "departure_timeout": 20,
            "max_participants": int(cfg["CALLS_MAX_PARTICIPANTS"]),
        },
        "turn": turn,
        "webhook": {
            "api_key": livekit_key_id(secrets),
            "urls": [f"http://{rtc_ips(cfg)['lkjwt']}:8080/sfu_webhook"],
        },
        "audio": {"active_red_encoding": True},
        "logging": {"level": "info", "pion_level": "error", "json": True},
    }
    header = ("# Generated by Lumen (deploy/lib/render.py). Do not edit.\n"
              "# API keys are read from /run/secrets/livekit_keys. No TURN/TLS listener: LiveKit would\n"
              "# advertise it on :443, which is Caddy's (see docs/adr/0002-calling.md D4).\n")
    write(out / "livekit" / "livekit.yaml", header + to_yaml(conf), 0o644)


PUSH_CREDENTIALS = {"android": "push_fcm_service_account", "ios": "push_apns_key"}


def push_platforms_ready(cfg, secrets: Path) -> list[str]:
    """Push platforms that are configured AND have their credential file. Sygnal refuses to
    start if any configured platform's credential is missing or empty, so a platform whose
    credential hasn't been supplied yet (lumenctl set-secret) is left out until it is."""
    if not push_enabled(cfg):
        return []
    wanted = {"android": bool(cfg["PUSH_FCM_PROJECT_ID"]), "ios": bool(cfg["PUSH_APNS_KEY_ID"])}
    ready = []
    for platform, name in PUSH_CREDENTIALS.items():
        f = secrets / name
        if wanted[platform] and f.is_file() and f.stat().st_size > 0:
            ready.append(platform)
    return ready


def render_sygnal(cfg, out: Path) -> None:
    """Sygnal (Matrix push gateway) configuration. Secrets stay in /run/secrets files;
    logs at WARNING so push keys and room IDs are not written to ordinary logs.
    Only platforms in cfg["_PUSH_READY"] (see push_platforms_ready) are configured."""
    apps: dict = {}
    ready = cfg.get("_PUSH_READY", [])
    if "android" in ready:
        apps[cfg["PUSH_ANDROID_APP_ID"]] = {
            "type": "gcm", "api_version": "v1", "project_id": cfg["PUSH_FCM_PROJECT_ID"],
            "service_account_file": "/run/secrets/push_fcm_service_account",
        }
    if "ios" in ready:
        apps[cfg["PUSH_IOS_APP_ID"]] = {
            "type": "apns", "keyfile": "/run/secrets/push_apns_key", "key_id": cfg["PUSH_APNS_KEY_ID"],
            "team_id": cfg["PUSH_APNS_TEAM_ID"], "topic": cfg["PUSH_APNS_TOPIC"],
            "platform": "sandbox" if truthy(cfg["PUSH_APNS_SANDBOX"]) else "production",
        }
    conf = {
        "http": {"bind_addresses": ["127.0.0.1"], "port": int(cfg["PUSH_PORT"])},
        "log": {
            "setup": {
                "version": 1,
                "formatters": {"plain": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"}},
                "handlers": {"stderr": {"class": "logging.StreamHandler", "formatter": "plain", "stream": "ext://sys.stderr"}},
                "root": {"level": "WARNING", "handlers": ["stderr"]},
                "disable_existing_loggers": False,
            },
            "access": {"x_forwarded_for": True},
        },
        "apps": apps,
    }
    if not apps:
        return  # no sygnal.yaml: the gateway isn't started (push_active in common.sh)
    header = "# Generated by Lumen (deploy/lib/render.py). Do not edit. Secrets: /run/secrets/push_*\n"
    write(out / "sygnal" / "sygnal.yaml", header + to_yaml(conf), 0o644)


def render_chat_config(cfg, out: Path) -> None:
    data = {
        "brand": {"name": cfg["BRAND_NAME"], "short_name": cfg["BRAND_SHORT_NAME"]},
        "homeserver": {"base_url": f"https://{cfg['LUMEN_MATRIX_DOMAIN']}", "server_name": cfg["MATRIX_SERVER_NAME"]},
        "sso": {"idp_id": "oidc-lumen", "label": f"Continue with your {cfg['BRAND_SHORT_NAME']} account"},
        "portal_url": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}",
        "allow_custom_homeserver": True,
        "calls": {
            "enabled": truthy(cfg["CALLS_ENABLED"]),
            # The SFU is discovered through the homeserver (MSC4143 /rtc/transports);
            # this is only shown in the app's call diagnostics.
            "rtc_domain": cfg["LUMEN_RTC_DOMAIN"],
        },
        "privacy_url": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}/privacy/",
        "help_url": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}/docs/",
        # Nexus business workspace: the SPA's API (bearer tokens from the portal's OAuth
        # server, public client registered by lumen_bootstrap) and the environment banner.
        "workspace": {"api_url": f"https://{cfg['LUMEN_PRIMARY_DOMAIN']}/api/v1", "client_id": "nexus-web"},
        "environment": cfg["NEXUS_ENVIRONMENT"],
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
        "LUMEN_WWW_DIR": str(Path(cfg["CHAT_DIST_DIR"] or f"{cfg['LUMEN_DATA_DIR']}/www/chat").parent),
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
        "UID_LIVEKIT": str(UID_LIVEKIT),
        "UID_LKJWT": str(UID_LKJWT),
        "UID_SYGNAL": str(UID_SYGNAL),
        "PUSH_PORT": cfg["PUSH_PORT"],
        "LUMEN_RTC_DOMAIN": cfg["LUMEN_RTC_DOMAIN"],
        "RTC_NETWORK_SUBNET": cfg["RTC_NETWORK_SUBNET"],
        "RTC_GATEWAY_IP": rtc_ips(cfg)["gateway"],
        "RTC_LKJWT_IP": rtc_ips(cfg)["lkjwt"],
        "RTC_WORKER_IP": rtc_ips(cfg)["worker"],
        "LKJWT_SSL_CERT_FILE": "/etc/lumen-ca/ca.crt" if cfg["TLS_MODE"] == "internal" else "/etc/ssl/certs/ca-certificates.crt",
    }
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
        "FEDERATION_PROBE_NOTARY", "PRESENCE_ENABLED", "CALLS_ENABLED", "LUMEN_RTC_DOMAIN", "CALLS_PUBLIC_IP",
        "CALLS_UDP_PORTS", "CALLS_TCP_PORT", "CALLS_TURN_UDP_PORT", "WIREGUARD_ENABLED", "SMTP_HOST",
        "SMTP_PORT", "SMTP_USER", "SMTP_SECURITY", "SMTP_FROM", "BILLING_PROVIDER", "BILLING_CURRENCY",
        "BILLING_GRACE_DAYS", "STRIPE_PUBLISHABLE_KEY", "BRAND_NAME", "BRAND_SHORT_NAME", "BRAND_TAGLINE",
        "BRAND_LEGAL_NAME", "BRAND_JURISDICTION", "SUPPORT_EMAIL", "SECURITY_EMAIL", "PRIVACY_EMAIL",
        "PUBLIC_STATUS_PAGE", "SYNAPSE_OIDC_CLIENT_ID", "LOG_LEVEL", "TLS_MODE", "APP_URL_SCHEME",
        "NEXUS_ENVIRONMENT",
    ]
    text = "# Generated by Lumen. Non-secret application settings.\n"
    text += "".join(f"{k}={cfg[k]}\n" for k in keys)
    text += "SYNAPSE_INTERNAL_URL=http://synapse:8008\n"
    text += "POSTGRES_HOST=postgres\nPOSTGRES_DB=lumen\nPOSTGRES_USER=lumen_app\n"
    text += "HOST_AGENT_SOCKET=/run/lumen-agent/agent.sock\nLUMEN_STATUS_DIR=/var/lib/lumen/status\n"
    text += "LUMEN_DISK_PROBE_PATH=/var/lib/lumen/status\n"
    text += f"RTC_GATEWAY_IP={rtc_ips(cfg)['gateway']}\n"
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
    cfg["_PUSH_READY"] = push_platforms_ready(cfg, args.secrets)
    render_synapse(cfg, out)
    copy_synapse_templates(args.repo, out, cfg)
    render_postgres(cfg, out)
    render_caddy(cfg, out)
    render_livekit(cfg, out, args.secrets)
    render_sygnal(cfg, out)
    render_chat_config(cfg, out)
    render_compose_env(cfg, out, args.repo)
    render_app_env(cfg, out)
    print(f"rendered configuration into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
