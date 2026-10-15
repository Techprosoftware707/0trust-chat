#!/usr/bin/env bash
# Explains common Lumen problems: DNS, TLS, Matrix discovery, federation,
# homeserver and database health, application origins, SMTP and payment webhooks.
# Read-only. Never prints secrets.
#
#   sudo ./diagnose.sh [--no-color]

set -o nounset -o pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LUMEN_REPO_DIR="${LUMEN_REPO_DIR:-$SCRIPT_DIR}"
[[ " $* " == *" --no-color "* ]] && exec > >(cat)  # non-tty => common.sh disables colours
source "$LUMEN_REPO_DIR/deploy/lib/common.sh"
set +o errexit
source "$LUMEN_REPO_DIR/deploy/lib/stack.sh"
source "$LUMEN_REPO_DIR/deploy/lib/verify.sh"
require_root

PROBLEMS=0
problem() { fail "$1"; printf '      %s→ %s%s\n' "$C_DIM" "$2" "$C_RESET"; PROBLEMS=$((PROBLEMS + 1)); }

[[ -f "$LUMEN_CONF" ]] || { echo "No $LUMEN_CONF: Lumen is not installed. Run: sudo bash install.sh"; exit 2; }
p="$(conf_get LUMEN_PRIMARY_DOMAIN)"; app="$(conf_get LUMEN_APP_DOMAIN "app.$p")"
mx="$(conf_get LUMEN_MATRIX_DOMAIN "matrix.$p")"; ops="$(conf_get LUMEN_OPS_DOMAIN "ops.$p")"
sn="$(conf_get MATRIX_SERVER_NAME "$p")"; tls_mode="$(conf_get TLS_MODE acme)"

step "Configuration"
if python3 "$LUMEN_REPO_DIR/deploy/lib/render.py" --conf "$LUMEN_CONF" --secrets "$LUMEN_SECRETS_DIR" --repo "$LUMEN_REPO_DIR" --out /nonexistent --print-config >/dev/null 2>/tmp/lumen-diag-conf.$$; then
  ok "lumen.conf is valid (server name $sn, TLS $tls_mode, federation $(conf_get FEDERATION_MODE open))"
else
  problem "lumen.conf is invalid" "$(tr '\n' ' ' </tmp/lumen-diag-conf.$$)"
fi
rm -f /tmp/lumen-diag-conf.$$
for f in django_secret_key postgres_app_password synapse_db_password synapse_oidc_client_secret internal_api_token ops_gateway_secret oidc_private_key.pem; do
  [[ -s "$LUMEN_SECRETS_DIR/$f" ]] || problem "secret '$f' is missing or empty" "re-run sudo bash install.sh to regenerate missing secrets"
done
[[ -s "$LUMEN_SECRETS_DIR/synapse_admin_token" ]] || problem "homeserver admin token missing" "the console can't manage Matrix accounts; re-run install.sh"
# Application origins must agree with the rendered configuration.
if [[ -f "$LUMEN_RENDERED_DIR/chat/config.json" ]]; then
  cfg_hs="$(python3 -c "import json; print(json.load(open('$LUMEN_RENDERED_DIR/chat/config.json'))['homeserver']['base_url'])")"
  [[ "$cfg_hs" == "https://$mx" ]] && ok "chat app origin configuration matches ($cfg_hs)" \
    || problem "chat app points to $cfg_hs but the homeserver is https://$mx" "run sudo ./update.sh to re-render configuration"
fi
grep -q "issuer: \"https://$p\"" "$LUMEN_RENDERED_DIR/synapse/homeserver.yaml" 2>/dev/null \
  && ok "homeserver SSO issuer matches the portal (https://$p)" \
  || problem "homeserver OIDC issuer doesn't match https://$p" "run sudo ./update.sh"

step "DNS"
pub="$(public_ip)"
[[ -n "$pub" ]] && info "public IPv4 of this server: $pub" || warn "could not determine the public IP (no outbound internet?)"
for host in "$p" "$app" "$mx" "$ops"; do
  addrs="$(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
  if [[ -z "$addrs" ]]; then
    [[ "$tls_mode" == internal ]] && warn "$host does not resolve (internal test mode)" \
      || problem "$host does not resolve" "create an A record: $host → ${pub:-<this server IP>}"
  elif [[ -n "$pub" && " $addrs " != *" $pub "* && "$tls_mode" == acme ]]; then
    problem "$host resolves to $addrs, not this server ($pub)" "fix the DNS record; certificates and federation depend on it"
  else
    ok "$host → $addrs"
  fi
done
if [[ "$sn" != "$mx" ]]; then
  srv="$(getent hosts "_matrix-fed._tcp.$sn" 2>/dev/null || true)"
  [[ -n "$srv" ]] && warn "an SRV record exists for $sn; .well-known delegation takes precedence (fine)"
fi

step "TLS certificates"
for host in "$p" "$app" "$mx"; do
  info_line="$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$host" 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null | tr '\n' ' ')"
  if [[ -z "$info_line" ]]; then
    problem "no certificate served for $host" "check 'sudo ./lumenctl logs caddy' for ACME errors (DNS, port 80 blocked, rate limits)"
    continue
  fi
  end="$(sed -n 's/.*notAfter=\(.*\)$/\1/p' <<<"$info_line")"
  days=$((($(date -d "$end" +%s) - $(date +%s)) / 86400))
  issuer="$(sed -n 's/.*issuer=\(.*\) notAfter.*/\1/p' <<<"$info_line")"
  if [[ "$tls_mode" == acme && "$issuer" == *"Caddy Local Authority"* ]]; then
    problem "$host uses Caddy's local test CA although TLS_MODE=acme" "ACME issuance failed; see 'sudo ./lumenctl logs caddy | grep -i acme'"
  elif ((days < 7)) && [[ "$tls_mode" == acme ]]; then
    problem "$host certificate expires in $days days" "renewal is failing; check port 80/443 reachability and Caddy logs"
  else
    ok "$host: $issuer, expires in $days days"
  fi
done
acme_err="$(compose logs --since 24h caddy 2>/dev/null | grep -iE '"level":"error".*(acme|certificate|challenge)' | tail -n 3)"
[[ -n "$acme_err" ]] && problem "Caddy reported certificate errors in the last 24h" "$(sed -E 's/.*"msg":"([^"]*)".*"error":"([^"]{0,160}).*/\1: \2/' <<<"$acme_err" | tail -n1)"

step "Matrix discovery and federation"
wk="$(_vcurl "$sn" 443 -fsS "https://$sn/.well-known/matrix/server" 2>/dev/null)"
if [[ "$wk" == *"\"$mx:443\""* ]]; then ok "/.well-known/matrix/server delegates $sn → $mx:443"
else problem "server discovery invalid ($wk)" "https://$sn/.well-known/matrix/server must return {\"m.server\": \"$mx:443\"}"; fi
wkc="$(_vcurl "$sn" 443 -fsS "https://$sn/.well-known/matrix/client" 2>/dev/null)"
[[ "$wkc" == *"https://$mx"* ]] && ok "/.well-known/matrix/client → https://$mx" || problem "client discovery invalid" "clients won't find the homeserver from $sn"
if [[ "$(conf_get FEDERATION_MODE open)" == closed ]]; then
  ok "federation disabled by policy"
else
  if _server_keys_valid "$mx" "$sn" >/dev/null 2>&1; then ok "signing keys served and self-signed"
  else problem "federation key endpoint invalid" "check the homeserver logs: sudo ./lumenctl logs synapse"; fi
  notary="$(conf_get FEDERATION_PROBE_NOTARY "")"
  [[ -z "$notary" && "$(conf_get FEDERATION_MODE open)" == open ]] && notary=matrix.org
  if [[ "$notary" == none || -z "$notary" ]]; then
    warn "no notary configured: external federation reachability is not tested"
  elif [[ "$tls_mode" == internal ]]; then
    warn "internal TLS mode: other servers cannot verify this server's certificate, so federation will not work"
  else
    resp="$(curl -fsS --max-time 25 -X POST -H 'Content-Type: application/json' -d "{\"server_keys\":{\"$sn\":{}}}" "https://$notary/_matrix/key/v2/query" 2>/dev/null)"
    if [[ "$resp" == *"\"server_name\":\"$sn\""* || "$resp" == *"\"server_name\": \"$sn\""* ]]; then
      ok "$notary fetched this server's keys over federation (external reachability confirmed)"
    else
      problem "$notary could not fetch this server's keys" "other servers can't reach https://$mx:443 — check DNS, firewall (443/tcp) and the certificate"
    fi
  fi
fi

step "Homeserver and database"
st="$(container_health synapse)"; [[ "$st" == healthy ]] && ok "homeserver healthy" || problem "homeserver is $st" "sudo ./lumenctl logs synapse"
if compose exec -T synapse curl -fsS -o /dev/null -H "Authorization: Bearer $(cat "$LUMEN_SECRETS_DIR/synapse_admin_token" 2>/dev/null)" http://localhost:8008/_synapse/admin/v1/server_version 2>/dev/null; then
  ok "homeserver admin token accepted"
else
  problem "homeserver admin token rejected" "re-run sudo bash install.sh (it re-creates the service account token)"
fi
if compose exec -T postgres pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
  ok "PostgreSQL accepting connections"
  compose exec -T -e PGPASSWORD="$(cat "$LUMEN_SECRETS_DIR/postgres_app_password")" postgres psql -h 127.0.0.1 -U lumen_app -d lumen -tAc 'SELECT 1' >/dev/null 2>&1 \
    && ok "portal database login works (role lumen_app)" || problem "portal role cannot log in" "run sudo ./lumenctl reconcile-db"
  compose exec -T -e PGPASSWORD="$(cat "$LUMEN_SECRETS_DIR/synapse_db_password")" postgres psql -h 127.0.0.1 -U synapse -d synapse -tAc 'SELECT 1' >/dev/null 2>&1 \
    && ok "homeserver database login works (role synapse)" || problem "homeserver role cannot log in" "run sudo ./lumenctl reconcile-db"
  compose exec -T postgres psql -h 127.0.0.1 -U lumen_app -d synapse -tAc 'SELECT 1' >/dev/null 2>&1 \
    && problem "portal role can open the homeserver database" "database separation is broken; check pg_hba.conf" \
    || ok "database separation: portal role cannot open the homeserver database"
else
  problem "PostgreSQL is not accepting connections" "sudo ./lumenctl logs postgres"
fi
for s in portal ops worker caddy; do
  st="$(container_health "$s")"
  [[ "$st" == healthy || ( "$s" == caddy && "$st" == running ) ]] && ok "$s $st" || problem "$s is $st" "sudo ./lumenctl logs $s"
done

step "Email (SMTP)"
smtp="$(conf_get SMTP_HOST "")"
if [[ -z "$smtp" ]]; then
  warn "SMTP not configured: email verification and password reset by email are disabled (by design)"
else
  if compose exec -T worker python manage.py shell -c "from apps.ops.probes import probe_email; r=probe_email(); print(r.status, r.summary)" 2>/dev/null | grep -q '^ok'; then
    ok "SMTP $smtp: handshake and login succeed"
  else
    problem "SMTP $smtp check failed" "verify SMTP_HOST/PORT/SECURITY/USER in lumen.conf and /etc/lumen/secrets/smtp_password"
  fi
fi

step "Payments"
bp="$(conf_get BILLING_PROVIDER none)"
case "$bp" in
  none) ok "no payment provider (free plan only)" ;;
  manual) ok "manual billing (plans assigned in the console)" ;;
  stripe)
    [[ -s "$LUMEN_SECRETS_DIR/stripe_secret_key" ]] || problem "Stripe secret key missing" "write it to $LUMEN_SECRETS_DIR/stripe_secret_key and run update.sh"
    [[ -s "$LUMEN_SECRETS_DIR/stripe_webhook_secret" ]] || problem "Stripe webhook secret missing" "create the webhook in Stripe → https://$p/billing/webhooks/stripe/ and store its whsec_ secret"
    wh="$(compose exec -T worker python manage.py shell -c "
from apps.billing.models import WebhookEvent as W
from django.utils import timezone; from datetime import timedelta
d=timezone.now()-timedelta(days=7)
print(W.objects.filter(received_at__gte=d, outcome__in=['processed','ignored']).count(), W.objects.filter(received_at__gte=d, outcome='rejected').count(), W.objects.filter(received_at__gte=d, outcome='failed').count())" 2>/dev/null | tail -n1)"
    read -r good rejected failedw <<<"${wh:-0 0 0}"
    ((rejected > 0)) && problem "$rejected webhook(s) rejected (bad signature) in 7 days" "the webhook signing secret doesn't match Stripe's endpoint secret"
    ((failedw > 0)) && problem "$failedw webhook(s) failed processing" "see the console → Webhooks"
    ((good > 0)) && ok "$good webhook(s) processed in 7 days" || warn "no Stripe webhooks received in 7 days (normal if no billing activity)"
    ;;
esac

step "Host"
if command -v ufw >/dev/null 2>&1; then
  ufw status 2>/dev/null | grep -q "Status: active" && ok "UFW active" || warn "UFW inactive (no host firewall)"
  for port in 80/tcp 443/tcp; do ufw status 2>/dev/null | grep -q "^$port" || { ufw status | grep -q "Status: active" && problem "firewall does not allow $port" "sudo ufw allow $port"; }; done
fi
if has_systemd; then
  timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes && ok "clock synchronised" || problem "clock not synchronised" "sudo timedatectl set-ntp true (TOTP and TLS need accurate time)"
  systemctl is-active --quiet lumen-agent && ok "lumen-agent running" || problem "lumen-agent not running" "sudo systemctl restart lumen-agent; journalctl -u lumen-agent"
fi
pct="$(df -P "$(conf_get LUMEN_DATA_DIR /var/lib/lumen)" | awk 'NR==2 {gsub("%","",$5); print $5}')"
((pct >= 90)) && problem "disk ${pct}% full" "free space or grow the disk; PostgreSQL stops when the disk is full" || ok "disk ${pct}% used"

printf '\n%s\n' "$( ((PROBLEMS == 0)) && echo "No problems found." || echo "$PROBLEMS problem(s) found — see the arrows above for what to do.")"
exit $((PROBLEMS > 0 ? 1 : 0))
