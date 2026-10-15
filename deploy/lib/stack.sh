#!/usr/bin/env bash
# Stack lifecycle: secrets, directories, rendering, validation, build, start.
# Sourced by install.sh / update.sh / lumenctl.

# --- Secrets -------------------------------------------------------------------

# gen_secret NAME [BYTES] — create a random hex secret file if it doesn't exist.
gen_secret() {
  local name="$1" bytes="${2:-32}" path="$LUMEN_SECRETS_DIR/$1"
  if [[ ! -s "$path" ]]; then
    umask 077
    openssl rand -hex "$bytes" | tr -d '\n' >"$path"
    _log "SECRET generated $name"
  fi
  chown "root:$GID_SECRETS" "$path"
  chmod 0440 "$path"
}

# ensure_optional_secret NAME — empty placeholder so Compose can mount it.
ensure_optional_secret() {
  local path="$LUMEN_SECRETS_DIR/$1"
  [[ -e "$path" ]] || : >"$path"
  chown "root:$GID_SECRETS" "$path"
  chmod 0440 "$path"
}

ensure_secrets() {
  install -d -m 0750 -o root -g "$GID_SECRETS" "$LUMEN_SECRETS_DIR"
  gen_secret django_secret_key 48
  gen_secret postgres_superuser_password 24
  gen_secret postgres_app_password 24
  gen_secret synapse_db_password 24
  gen_secret synapse_macaroon 32
  gen_secret synapse_form_secret 32
  gen_secret synapse_registration_secret 32
  gen_secret synapse_oidc_client_secret 32
  gen_secret internal_api_token 32
  gen_secret ops_gateway_secret 32
  gen_secret turn_shared_secret 32
  ensure_optional_secret smtp_password
  ensure_optional_secret stripe_secret_key
  ensure_optional_secret stripe_webhook_secret
  ensure_optional_secret synapse_admin_token
  # OIDC signing key for the portal identity provider.
  if [[ ! -s "$LUMEN_SECRETS_DIR/oidc_private_key.pem" ]]; then
    (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$LUMEN_SECRETS_DIR/oidc_private_key.pem" 2>/dev/null)
    _log "SECRET generated oidc_private_key.pem"
  fi
  chown "root:$GID_SECRETS" "$LUMEN_SECRETS_DIR/oidc_private_key.pem"
  chmod 0440 "$LUMEN_SECRETS_DIR/oidc_private_key.pem"
  # libpq requires its passfile to be owned by the reading user and mode 0600.
  local pw
  pw="$(cat "$LUMEN_SECRETS_DIR/synapse_db_password")"
  (umask 077 && printf 'postgres:5432:synapse:synapse:%s\n' "$pw" >"$LUMEN_SECRETS_DIR/synapse_pgpass")
  chown "$UID_SYNAPSE:$UID_SYNAPSE" "$LUMEN_SECRETS_DIR/synapse_pgpass"
  chmod 0600 "$LUMEN_SECRETS_DIR/synapse_pgpass"
}

# --- Directories -----------------------------------------------------------------

ensure_dirs() {
  local data; data="$(conf_get LUMEN_DATA_DIR /var/lib/lumen)"
  local sockets; sockets="$(conf_get LUMEN_SOCKET_DIR "$data/sockets")"
  install -d -m 0755 "$data"
  install -d -m 0700 -o "$UID_POSTGRES" -g "$UID_POSTGRES" "$data/postgres"
  install -d -m 0750 -o "$UID_SYNAPSE" -g "$UID_SYNAPSE" "$data/synapse"
  install -d -m 0750 -o "$UID_SYNAPSE" -g "$UID_SYNAPSE" "$data/synapse/media_store"
  install -d -m 0750 -o "$UID_CADDY" -g "$UID_CADDY" "$data/caddy" "$data/caddy/data" "$data/caddy/config"
  # setgid so every socket inherits the shared socket group
  install -d -m 2770 -o root -g "$GID_SOCKETS" "$sockets"
  install -d -m 0755 "$data/status" "$data/www" "$data/www/chat"
  install -d -m 0750 -o root -g "$GID_SECRETS" "$LUMEN_CONFIG_DIR"
  install -d -m 0755 "$LUMEN_BRANDING_DIR"
  for f in logo.svg favicon.svg theme.css; do
    [[ -e "$LUMEN_BRANDING_DIR/$f" ]] || install -m 0644 "$LUMEN_REPO_DIR/branding/$f" "$LUMEN_BRANDING_DIR/$f"
  done
  install -d -m 0750 /run/lumen-agent 2>/dev/null || true
  chgrp "$GID_SOCKETS" /run/lumen-agent 2>/dev/null || true
}

# --- Rendering ---------------------------------------------------------------------

render_staging() {
  local staging="$LUMEN_CONFIG_DIR/rendered.staging"
  python3 "$LUMEN_REPO_DIR/deploy/lib/render.py" \
    --conf "$LUMEN_CONF" --secrets "$LUMEN_SECRETS_DIR" \
    --repo "$LUMEN_REPO_DIR" --out "$staging" >>"${_log_file:-/dev/null}" 2>&1 \
    || { python3 "$LUMEN_REPO_DIR/deploy/lib/render.py" --conf "$LUMEN_CONF" --secrets "$LUMEN_SECRETS_DIR" --repo "$LUMEN_REPO_DIR" --out "$staging" --print-config >/dev/null; die "Configuration rendering failed (see messages above / log)."; }
  chgrp -R "$GID_SECRETS" "$staging"
  chmod 0750 "$staging"
  find "$staging" -type d -exec chmod 0750 {} +
  chmod -R g+r "$staging"
  # Containers read these as non-root users:
  chmod 0755 "$staging" "$staging/synapse" "$staging/synapse/templates" "$staging/postgres" "$staging/chat"
  chmod 0644 "$staging/synapse/templates/"* "$staging/postgres/"* "$staging/chat/config.json"
  chown "root:$UID_SYNAPSE" "$staging/synapse/homeserver.yaml" "$staging/synapse/log.config"
  chmod 0640 "$staging/synapse/homeserver.yaml" "$staging/synapse/log.config"
  chown "root:$UID_CADDY" "$staging/caddy" "$staging/caddy/Caddyfile"
  chmod 0750 "$staging/caddy"; chmod 0640 "$staging/caddy/Caddyfile"
  if [[ -f "$staging/coturn/turnserver.conf" ]]; then
    chgrp -R "$GID_SECRETS" "$staging/coturn"; chmod 0750 "$staging/coturn"; chmod 0640 "$staging/coturn/turnserver.conf"
  fi
}

# validate_staging — validate rendered config with the real tools before use.
validate_staging() {
  local staging="$LUMEN_CONFIG_DIR/rendered.staging"
  # shellcheck disable=SC1091
  set -a; source "$staging/compose.env"; set +a
  info "validating Caddy configuration"
  docker run --rm --network none --user "$UID_CADDY:$UID_CADDY" --group-add "$GID_SECRETS" \
    -v "$staging/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$LUMEN_SECRETS_DIR/ops_gateway_secret:/run/secrets/ops_gateway_secret:ro" \
    -e XDG_DATA_HOME=/tmp -e XDG_CONFIG_HOME=/tmp \
    "$CADDY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >>"$_log_file" 2>&1 \
    || die "Caddy rejected the generated configuration. See $_log_file"
  ok "Caddy configuration valid"
  info "validating homeserver configuration (and generating the signing key if missing)"
  local data; data="$(conf_get LUMEN_DATA_DIR /var/lib/lumen)"
  docker run --rm --network none --user "$UID_SYNAPSE:$UID_SYNAPSE" --group-add "$GID_SECRETS" \
    --entrypoint python \
    -e PYTHONPATH=/modules \
    -v "$data/synapse:/data" -v "$staging/synapse:/config:ro" \
    -v "$LUMEN_REPO_DIR/services/synapse-module:/modules:ro" \
    -v "$LUMEN_SECRETS_DIR/synapse_pgpass:/run/secrets/synapse_pgpass:ro" \
    -v "$LUMEN_SECRETS_DIR/synapse_macaroon:/run/secrets/synapse_macaroon:ro" \
    -v "$LUMEN_SECRETS_DIR/synapse_form_secret:/run/secrets/synapse_form_secret:ro" \
    -v "$LUMEN_SECRETS_DIR/synapse_registration_secret:/run/secrets/synapse_registration_secret:ro" \
    -v "$LUMEN_SECRETS_DIR/synapse_oidc_client_secret:/run/secrets/synapse_oidc_client_secret:ro" \
    -v "$LUMEN_SECRETS_DIR/internal_api_token:/run/secrets/internal_api_token:ro" \
    -v "$LUMEN_SECRETS_DIR/turn_shared_secret:/run/secrets/turn_shared_secret:ro" \
    "$SYNAPSE_IMAGE" -m synapse.app.homeserver --config-path /config/homeserver.yaml --generate-keys >>"$_log_file" 2>&1 \
    || die "The homeserver rejected the generated configuration. See $_log_file"
  ok "homeserver configuration valid; signing key present"
  info "validating Compose file"
  LUMEN_RENDERED_DIR="$staging" docker compose --project-directory "$LUMEN_REPO_DIR" --env-file "$staging/compose.env" \
    -f "$LUMEN_REPO_DIR/docker-compose.yml" --profile voip config -q >>"$_log_file" 2>&1 \
    || die "docker compose rejected the configuration. See $_log_file"
  ok "Compose configuration valid"
}

# promote_staging — atomically replace the active configuration (keeps .prev).
promote_staging() {
  local staging="$LUMEN_CONFIG_DIR/rendered.staging" active="$LUMEN_RENDERED_DIR" prev="$LUMEN_CONFIG_DIR/rendered.prev"
  rm -rf "$prev"
  if [[ -d "$active" ]]; then mv "$active" "$prev"; fi
  mv "$staging" "$active"
  # Bind mounts pin the old inodes, so containers must be recreated to see it.
  LUMEN_FORCE_RECREATE=1
  ok "configuration activated (previous kept in $prev)"
}

rollback_config() {
  local active="$LUMEN_RENDERED_DIR" prev="$LUMEN_CONFIG_DIR/rendered.prev"
  [[ -d "$prev" ]] || return 1
  rm -rf "$active.failed"
  mv "$active" "$active.failed"
  mv "$prev" "$active"
  warn "restored previous configuration (failed one kept in $active.failed)"
}

# --- Images ----------------------------------------------------------------------------

pull_images() {
  # shellcheck disable=SC1091
  set -a; source "$(compose_env_file)"; set +a
  local img
  for img in "$POSTGRES_IMAGE" "$SYNAPSE_IMAGE" "$CADDY_IMAGE" "$PYTHON_BASE_IMAGE" "$NODE_BASE_IMAGE"; do
    run docker pull -q "$img" || die "Could not pull $img. Check internet access to the registry."
  done
  if truthy "$(conf_get VOIP_ENABLED false)"; then run docker pull -q "$COTURN_IMAGE" || die "Could not pull $COTURN_IMAGE"; fi
  ok "base images pulled (pinned by digest)"
}

build_portal() {
  run compose build portal || die "Building the portal image failed. See $_log_file"
  ok "portal image built ($PORTAL_IMAGE)"
}

build_chat() {
  # shellcheck disable=SC1091
  set -a; source "$(compose_env_file)"; set +a
  local dest="$LUMEN_CHAT_DIST" tmp
  tmp="$(mktemp -d "$(dirname "$dest")/.chat-build.XXXXXX")"
  run docker build --file "$LUMEN_REPO_DIR/services/chat/Dockerfile" \
    --build-arg "NODE_BASE_IMAGE=$NODE_BASE_IMAGE" \
    --target dist --output "type=local,dest=$tmp" "$LUMEN_REPO_DIR" \
    || { rm -rf "$tmp"; die "Building the web chat app failed. See $_log_file"; }
  [[ -f "$tmp/index.html" ]] || { rm -rf "$tmp"; die "Chat build produced no index.html"; }
  chmod -R a+rX "$tmp"
  rm -rf "$dest.prev"
  [[ -d "$dest" ]] && mv "$dest" "$dest.prev"
  mv "$tmp" "$dest"
  chmod 0755 "$dest"
  ok "web chat app built"
}

# --- Bring-up ------------------------------------------------------------------------

# wait_health <service> <wanted-state> <timeout-seconds>
wait_health() {
  local svc="$1" want="$2" timeout="$3" start state
  start=$(date +%s)
  while true; do
    state="$(container_health "$svc")"
    [[ "$state" == "$want" ]] && return 0
    if [[ "$state" == "exited" || "$state" == "unhealthy" ]] && (($(date +%s) - start > 30)); then
      return 1
    fi
    (($(date +%s) - start > timeout)) && return 1
    sleep 3
  done
}

reconcile_db_roles() {
  run compose exec -T postgres sh /docker-entrypoint-initdb.d/10-lumen-roles.sh \
    || die "Could not reconcile database roles. See $_log_file"
}

start_database() {
  local recreate=()
  [[ "${LUMEN_FORCE_RECREATE:-0}" == 1 ]] && recreate=(--force-recreate)
  run compose up -d "${recreate[@]}" postgres || die "Could not start PostgreSQL. See $_log_file"
  wait_health postgres healthy 180 || {
    compose logs --tail 50 postgres >>"$_log_file" 2>&1 || true
    die "PostgreSQL did not become healthy. See $_log_file"
  }
  reconcile_db_roles
  ok "PostgreSQL healthy; roles and databases in place"
}

run_migrations() {
  run compose run --rm migrate || die "Database migrations failed. See $_log_file"
  ok "portal database migrated and bootstrapped"
}

start_services() {
  local svc=(synapse portal ops worker caddy)
  truthy "$(conf_get VOIP_ENABLED false)" && svc+=(coturn)
  local recreate=()
  [[ "${LUMEN_FORCE_RECREATE:-0}" == 1 ]] && recreate=(--force-recreate)
  run compose up -d --remove-orphans "${recreate[@]}" "${svc[@]}" || die "Could not start services. See $_log_file"
  local s
  for s in synapse portal ops; do
    if ! wait_health "$s" healthy 300; then
      compose logs --tail 80 "$s" >>"$_log_file" 2>&1 || true
      die "Service '$s' did not become healthy (state: $(container_health "$s")). See $_log_file"
    fi
    ok "$s healthy"
  done
  if ! wait_health caddy running 60; then
    compose logs --tail 80 caddy >>"$_log_file" 2>&1 || true
    die "Caddy is not running. See $_log_file"
  fi
  ok "caddy running"
}

# bootstrap_synapse_admin — create the homeserver service account used by the
# console/worker (once) and store its access token. Uses the shared-secret
# registration endpoint, reachable only inside the internal network.
bootstrap_synapse_admin() {
  local token_file="$LUMEN_SECRETS_DIR/synapse_admin_token"
  if [[ -s "$token_file" ]]; then
    if compose exec -T synapse curl -fsS -o /dev/null -H "Authorization: Bearer $(cat "$token_file")" \
      http://localhost:8008/_synapse/admin/v1/server_version >/dev/null 2>&1; then
      ok "homeserver admin token valid"
      return 0
    fi
    warn "stored homeserver admin token is not valid; creating a new service account token"
  fi
  local out
  out="$(compose exec -T synapse python - <<'PY'
import hashlib, hmac, json, secrets, sys, urllib.request
base = "http://localhost:8008/_synapse/admin/v1/register"
shared = open("/run/secrets/synapse_registration_secret").read().strip().encode()
nonce = json.load(urllib.request.urlopen(base, timeout=10))["nonce"]
user = "lumen-ops-" + secrets.token_hex(3)
password = secrets.token_urlsafe(48)  # never used again; the account logs in via its token only
mac = hmac.new(shared, digestmod=hashlib.sha1)
for part in (nonce, user, password, "admin"):
    mac.update(part.encode()); mac.update(b"\x00") if part != "admin" else None
body = json.dumps({"nonce": nonce, "username": user, "displayname": "Lumen operations (service account)",
                   "password": password, "admin": True, "mac": mac.hexdigest()}).encode()
req = urllib.request.Request(base, data=body, headers={"Content-Type": "application/json"})
resp = json.load(urllib.request.urlopen(req, timeout=15))
sys.stdout.write(resp["access_token"])
PY
)" || die "Could not create the homeserver service account. See $_log_file"
  [[ -n "$out" ]] || die "Homeserver returned no access token"
  (umask 077 && printf '%s' "$out" >"$token_file")
  chown "root:$GID_SECRETS" "$token_file"; chmod 0440 "$token_file"
  ok "homeserver service account created; token stored in $token_file"
  run compose up -d --force-recreate ops worker
}

# --- Internal CA (TLS_MODE=internal: test/staging environments only) ---------------

internal_ca_bundle_path() { printf '%s' "$LUMEN_CONFIG_DIR/ca/bundle.crt"; }

ensure_ca_bundle_file() {
  [[ "$(conf_get TLS_MODE acme)" == internal ]] || return 0
  install -d -m 0755 "$LUMEN_CONFIG_DIR/ca"
  local bundle; bundle="$(internal_ca_bundle_path)"
  [[ -s "$bundle" ]] || cat /etc/ssl/certs/ca-certificates.crt >"$bundle"
  chmod 0644 "$bundle"
}

# Rewrites the bundle *in place* (same inode, so bind mounts see it) once Caddy
# has created its local CA, then restarts the services that make TLS calls.
refresh_internal_ca_bundle() {
  [[ "$(conf_get TLS_MODE acme)" == internal ]] || return 0
  local data root bundle
  data="$(conf_get LUMEN_DATA_DIR /var/lib/lumen)"
  root="$data/caddy/data/caddy/pki/authorities/local/root.crt"
  bundle="$(internal_ca_bundle_path)"
  wait_for 60 "caddy local CA" test -s "$root" || die "Caddy did not create its local CA ($root)"
  if ! grep -qF "$(sed -n 2p "$root")" "$bundle" 2>/dev/null; then
    cat /etc/ssl/certs/ca-certificates.crt "$root" >"$bundle.new"
    cat "$bundle.new" >"$bundle" && rm -f "$bundle.new"
    install -m 0644 "$root" "$LUMEN_CONFIG_DIR/ca/caddy-local-root.crt"
    run compose restart synapse worker
    wait_health synapse healthy 180 || die "homeserver did not recover after CA refresh"
    warn "TLS_MODE=internal: browsers must trust $LUMEN_CONFIG_DIR/ca/caddy-local-root.crt (testing only)"
  fi
  ok "internal CA bundle in place"
}
