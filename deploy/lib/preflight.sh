#!/usr/bin/env bash
# shellcheck disable=SC2154,SC1090  # _log_file/colours come from common.sh; env files are generated
# Pre-installation checks. Read-only: nothing here changes the system.
# Each check records a result; preflight_report prints them and decides.

PF_ERRORS=()
PF_WARNINGS=()

pf_error() { PF_ERRORS+=("$1"); fail "$1"; }
pf_warn() { PF_WARNINGS+=("$1"); warn "$1"; }

check_os() {
  local id="" ver="" pretty=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && echo "${ID:-}")"; ver="$(. /etc/os-release && echo "${VERSION_ID:-}")"; pretty="$(. /etc/os-release && echo "${PRETTY_NAME:-}")"
  fi
  if [[ "$id" == ubuntu && "$ver" == 24.04 ]]; then
    ok "operating system: $pretty"
  elif [[ "${LUMEN_ALLOW_UNSUPPORTED_OS:-0}" == 1 ]]; then
    pf_warn "operating system '$pretty' is not Ubuntu 24.04 LTS; continuing because LUMEN_ALLOW_UNSUPPORTED_OS=1 (untested)"
  else
    pf_error "unsupported operating system '${pretty:-unknown}'. Lumen is built and tested for Ubuntu Server 24.04 LTS. (Override at your own risk with LUMEN_ALLOW_UNSUPPORTED_OS=1.)"
  fi
}

check_arch() {
  local arch; arch="$(uname -m)"
  case "$arch" in
    x86_64 | aarch64) ok "CPU architecture: $arch" ;;
    *) pf_error "unsupported CPU architecture '$arch' (need x86_64 or aarch64)" ;;
  esac
  local cpus; cpus="$(nproc 2>/dev/null || echo 1)"
  if ((cpus < 2)); then pf_warn "only $cpus CPU core; 2+ recommended"; else ok "CPU cores: $cpus"; fi
}

check_systemd() {
  if has_systemd; then
    ok "systemd is running"
  elif [[ "${LUMEN_NO_SYSTEMD:-0}" == 1 ]]; then
    pf_warn "systemd not running (LUMEN_NO_SYSTEMD=1): timers, host agent and automatic start at boot will be skipped"
  else
    pf_error "systemd is not running as PID 1. Lumen needs systemd for backups, health timers, the host agent and start at boot. (For container-based testing only: LUMEN_NO_SYSTEMD=1.)"
  fi
}

check_memory() {
  local mem_mb; mem_mb=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024))
  if ((mem_mb < 1800)); then
    pf_error "only ${mem_mb} MB RAM. Lumen needs at least 2 GB of RAM (4 GB recommended); swap does not count toward this. Resize the server and retry."
  elif ((mem_mb < 3800)); then
    pf_warn "${mem_mb} MB RAM: fine for a small community; 4 GB+ recommended for federation-heavy use"
  else
    ok "memory: ${mem_mb} MB"
  fi
  local swap_mb; swap_mb=$(($(awk '/SwapTotal/ {print $2}' /proc/meminfo) / 1024))
  if ((mem_mb < 3800 && swap_mb == 0)); then pf_warn "no swap configured; consider adding 2 GB of swap on small servers"; fi
}

check_disk() {
  local target free_gb
  for target in /var/lib /var/backups; do
    mkdir -p "$target" 2>/dev/null || true
    free_gb=$(($(df -Pk "$target" | awk 'NR==2 {print $4}') / 1024 / 1024))
    if ((free_gb < 10)); then
      pf_error "only ${free_gb} GB free on $target. Lumen needs at least 10 GB (40 GB+ recommended for media and backups)."
    elif ((free_gb < 25)); then
      pf_warn "${free_gb} GB free on $target; media uploads and backups grow over time (40 GB+ recommended)"
    else
      ok "disk: ${free_gb} GB free on $target"
    fi
  done
}

check_internet() {
  local url failed=()
  for url in https://download.docker.com https://registry-1.docker.io/v2/ https://ghcr.io/v2/ https://registry.npmjs.org/ https://pypi.org/simple/; do
    if ! curl -sS -o /dev/null --max-time 10 "$url" 2>/dev/null; then failed+=("$url"); fi
  done
  if ((${#failed[@]})); then
    pf_error "cannot reach: ${failed[*]}. The installer downloads Docker, container images and build dependencies; check outbound HTTPS/DNS."
  else
    ok "internet access to package registries"
  fi
}

port_owner() {
  # port_owner <proto tcp|udp> <port> -> process name or empty
  local proto="$1" port="$2" flag="-ltnp"
  [[ "$proto" == udp ]] && flag="-lunp"
  ss "$flag" 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print $NF}' | head -n1
}

lumen_livekit_running() { # the SFU on the calls ports is Lumen's own container (host network)
  command -v docker >/dev/null 2>&1 && [[ -n "$(docker ps -q --filter label=com.docker.compose.project=lumen --filter label=com.docker.compose.service=livekit 2>/dev/null)" ]]
}

check_ports() {
  local spec proto port owner ours
  local specs=("tcp:80" "tcp:443" "udp:443" "tcp:$(conf_get LUMEN_OPS_PORT 8443)")
  if calls_enabled; then
    local lo hi udp; udp="$(conf_get CALLS_UDP_PORTS 7882-7889)"; lo="${udp%-*}"; hi="${udp#*-}"
    specs+=("udp:$lo" "udp:$hi" "tcp:$(conf_get CALLS_TCP_PORT 7881)" "udp:$(conf_get CALLS_TURN_UDP_PORT 3478)")
  fi
  truthy "$(conf_get WIREGUARD_ENABLED false)" && specs+=("udp:$(conf_get WG_PORT 51820)")
  for spec in "${specs[@]}"; do
    proto="${spec%%:*}"; port="${spec#*:}"
    owner="$(port_owner "$proto" "$port")"
    if [[ -z "$owner" ]]; then
      ok "port $port/$proto is free"
    else
      ours=0
      # turnserver: coturn from Lumen releases before the LiveKit SFU (replaced on install).
      [[ "$owner" == *caddy* || "$owner" == *turnserver* || "$owner" == *wireguard* ]] && ours=1
      [[ "$owner" == *livekit-server* ]] && lumen_livekit_running && ours=1
      if ((ours)) && [[ -f "$LUMEN_STATE_FILE" ]]; then
        ok "port $port/$proto is used by Lumen ($owner)"
      else
        pf_error "port $port/$proto is already in use by: $owner. Stop or reconfigure that service first (Lumen will not stop it for you)."
      fi
    fi
  done
}

check_conflicting_services() {
  local svc
  for svc in apache2 nginx lighttpd haproxy traefik caddy; do
    if has_systemd && systemctl is-active --quiet "$svc" 2>/dev/null; then
      pf_error "host service '$svc' is running and would conflict with Lumen's reverse proxy on ports 80/443. Disable it (systemctl disable --now $svc) or use a dedicated server."
    fi
  done
}

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    info "Docker is not installed; it will be installed from Docker's official repository"
    return
  fi
  local ver pkg
  ver="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  if [[ -z "$ver" ]]; then
    pf_warn "Docker is installed but the daemon is not reachable; the installer will try to start it"
    return
  fi
  pkg="$(dpkg-query -W -f='${Package}' docker-ce 2>/dev/null || true)"
  if [[ -z "$pkg" ]] && dpkg-query -W docker.io >/dev/null 2>&1; then
    pf_warn "Docker comes from Ubuntu's docker.io package (version $ver). It works if Compose v2 is present; Docker's official packages are recommended."
  fi
  if [[ "${ver%%.*}" -lt 24 ]]; then
    pf_error "Docker $ver is too old (need 24+). Upgrade Docker or remove it so the installer can install a current version."
  else
    ok "Docker $ver"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    pf_error "Docker Compose v2 plugin missing (docker compose). Install docker-compose-plugin."
  fi
  local others
  others="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -v -E "^$(conf_get LUMEN_PROJECT lumen)-" | head -n5 | tr '\n' ' ' || true)"
  if [[ -n "$others" ]]; then
    pf_warn "other containers are running on this host ($others). Lumen won't touch them, but a dedicated server is recommended."
  fi
}

check_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ok "UFW is active; Lumen will add its rules without resetting existing ones"
  elif has_systemd && systemctl is-active --quiet firewalld 2>/dev/null; then
    pf_warn "firewalld is active; Lumen won't change it. Open 80/tcp, 443/tcp, 443/udp yourself (see the summary)."
  elif command -v nft >/dev/null 2>&1 && [[ "$(nft list ruleset 2>/dev/null | grep -c 'hook input' || true)" -gt 0 ]] && ! command -v ufw >/dev/null 2>&1; then
    pf_warn "custom nftables rules are present; Lumen won't change them. Make sure 80/tcp and 443/tcp/udp are open."
  else
    info "no active host firewall; Lumen will enable UFW (allowing SSH first)"
  fi
}

check_time_sync() {
  if has_systemd && command -v timedatectl >/dev/null 2>&1; then
    if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
      ok "system clock synchronised (needed for TLS and two-factor codes)"
    else
      pf_warn "system clock is not NTP-synchronised; two-factor codes and certificates depend on accurate time (timedatectl set-ntp true)"
    fi
  fi
}

# DNS: each public hostname must resolve to this server before ACME can work.
check_dns() {
  local mode; mode="$(conf_get TLS_MODE acme)"
  if [[ "$mode" == internal ]]; then
    pf_warn "TLS_MODE=internal: using a private test CA; browsers and other Matrix servers will NOT trust this server. Testing only."
    return
  fi
  if [[ "${LUMEN_SKIP_DNS_CHECK:-0}" == 1 ]]; then
    pf_warn "DNS check skipped (LUMEN_SKIP_DNS_CHECK=1); certificate issuance will fail if records are wrong"
    return
  fi
  local pub4 pub6 host addrs ok_any
  pub4="$(public_ip)"
  pub6="$(curl -6 -fsS --max-time 5 https://api64.ipify.org 2>/dev/null || true)"
  [[ -n "$pub4" ]] && info "this server's public IPv4: $pub4"
  [[ -n "$pub6" && "$pub6" == *:* ]] && info "this server's public IPv6: $pub6"
  local p; p="$(conf_get LUMEN_PRIMARY_DOMAIN)"
  for host in "$p" "$(conf_get LUMEN_APP_DOMAIN "app.$p")" "$(conf_get LUMEN_MATRIX_DOMAIN "matrix.$p")" "$(conf_get LUMEN_OPS_DOMAIN "ops.$p")"; do
    addrs="$(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
    if [[ -z "$addrs" ]]; then
      pf_error "DNS: $host does not resolve. Create an A record ($host → ${pub4:-<server IPv4>}) and wait for it to propagate."
      continue
    fi
    ok_any=0
    for a in $addrs; do
      [[ "$a" == "$pub4" || ( -n "$pub6" && "$a" == "$pub6" ) ]] && ok_any=1
    done
    if ((ok_any)); then
      ok "DNS: $host → $addrs"
    else
      pf_error "DNS: $host resolves to $addrs, not to this server (${pub4:-unknown}). Fix the record; Let's Encrypt validation would fail."
    fi
  done
}

check_existing_install() {
  if [[ -f "$LUMEN_STATE_FILE" ]]; then
    local status version phase
    status="$(state_get install_status)"; version="$(state_get version)"; phase="$(state_get phase)"
    if [[ "$status" == complete ]]; then
      info "existing Lumen installation found (version ${version:-unknown}); re-running reconciles configuration and preserves all data"
    else
      pf_warn "a previous installation attempt stopped during phase '${phase:-unknown}'; it will be resumed (all steps are idempotent, data is preserved)"
    fi
  elif [[ -d "$(conf_get LUMEN_DATA_DIR /var/lib/lumen)/postgres/pgdata" ]]; then
    pf_warn "found existing Lumen data in $(conf_get LUMEN_DATA_DIR /var/lib/lumen) without installer state; it will be reused, not overwritten"
  fi
}

# The Matrix server name is part of every user ID, room and signature; Synapse refuses to start
# on existing data under another name. Moving to a new name (e.g. from a test setup to a real
# domain) is a new installation.
check_server_name() {
  local was now
  was="$(state_get server_name)"
  [[ -n "$was" ]] || return 0
  now="$(conf_get MATRIX_SERVER_NAME "$(conf_get LUMEN_PRIMARY_DOMAIN)")"
  [[ "$was" == "$now" ]] && return 0
  pf_error "the Matrix server name would change from $was to $now. That is not possible on an existing installation (it is part of every user ID). Keep $was, or install $now on a fresh server (or here after 'sudo ./uninstall.sh --purge-data', which deletes all accounts and messages)."
}

run_preflight() {
  PF_ERRORS=(); PF_WARNINGS=()
  check_os
  check_arch
  check_systemd
  check_memory
  check_disk
  check_time_sync
  check_internet
  check_existing_install
  check_server_name
  check_conflicting_services
  check_ports
  check_docker
  check_firewall
  check_dns
}

preflight_report() {
  if ((${#PF_ERRORS[@]})); then
    printf '\n%sPreflight found %d problem(s) that must be fixed before installing:%s\n' "$C_RED$C_BOLD" "${#PF_ERRORS[@]}" "$C_RESET" >&2
    local e
    for e in "${PF_ERRORS[@]}"; do printf '  • %s\n' "$e" >&2; done
    printf '\nNothing has been changed on this server. Fix the items above and run install.sh again.\n' >&2
    exit 2
  fi
  if ((${#PF_WARNINGS[@]})); then
    info "${#PF_WARNINGS[@]} warning(s); continuing"
  fi
}
