#!/usr/bin/env bash
# shellcheck disable=SC2154,SC1090,SC2034  # _log_file/colours come from common.sh; WG_REASON is read by lumenctl
# WireGuard: private operator access to the console port. On by default and configured by the
# installer (subnet, endpoint, wg0, first device profile). Never used for chat or federation
# traffic and never required: when this host can't run it, the installer says why, carries on,
# and the SSH tunnel remains.

WG_CONF_FILE=/etc/wireguard/wg0.conf
WG_FIRST_PROFILE="$LUMEN_CONFIG_DIR/wireguard/first-device.conf"
WG_REASON=""   # set when WireGuard is unavailable on this host
WG_HOW=""      # kernel | userspace (wireguard-go)

_wg_agent() {
  LUMEN_CONF="$LUMEN_CONF" LUMEN_STATE="$LUMEN_STATE_FILE" LUMEN_WG_DIR="$LUMEN_CONFIG_DIR/wireguard" \
    LUMEN_WG_CONF="$WG_CONF_FILE" python3 "$LUMEN_REPO_DIR/deploy/host-agent/lumen_agent.py" "$@"
}

# wireguard_default_on — a lumen.conf without WIREGUARD_ENABLED gets the default (true) written
# explicitly, so every component reads the same value. An explicit setting is never changed.
wireguard_default_on() {
  [[ -n "$(conf_get WIREGUARD_ENABLED)" ]] && return 0
  conf_set WIREGUARD_ENABLED true
  info "WireGuard is on by default (WIREGUARD_ENABLED=true written to $LUMEN_CONF)"
}

# The hint itself ("WireGuard is off; turn it on with: ...") is printed once, in the summary.
wireguard_off_note() { info "off (WIREGUARD_ENABLED=false in $LUMEN_CONF)"; }

_wg_unavailable() { # reason — record and explain; the caller returns 1
  WG_REASON="$1"
  state_set wireguard unavailable
  state_set wireguard_reason "$1"
  warn "WireGuard unavailable: $1"
  warn "the operator console stays reachable through an SSH tunnel (see the summary); retry later with: sudo ./lumenctl wireguard enable"
}

# _wg_support — can this host create a WireGuard interface? Prints how (or why not).
_wg_support() {
  modprobe wireguard >/dev/null 2>&1 || true
  if ip link add lumen-wgprobe type wireguard >/dev/null 2>&1; then
    ip link del lumen-wgprobe >/dev/null 2>&1 || true
    printf 'kernel'; return 0
  fi
  # No kernel module (containers, LXC): wg-quick falls back to the userspace implementation by
  # itself when one is installed and a TUN device exists. Ubuntu packages wireguard-go.
  local impl="${WG_QUICK_USERSPACE_IMPLEMENTATION:-wireguard-go}"
  if [[ -c /dev/net/tun ]]; then
    if ! command -v "$impl" >/dev/null 2>&1 && [[ "$impl" == wireguard-go ]]; then
      DEBIAN_FRONTEND=noninteractive run apt-get install -y -q --no-install-recommends wireguard-go || true
    fi
    if command -v "$impl" >/dev/null 2>&1; then
      printf 'userspace %s: this kernel has no WireGuard module' "$impl"; return 0
    fi
  fi
  printf 'this kernel has no WireGuard support and there is no TUN device for the userspace implementation (usual in unprivileged containers and LXC; the kernel of an Ubuntu 24.04 VM or server has it)'
  return 1
}

_wg_packages() {
  command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1 && command -v qrencode >/dev/null 2>&1 && return 0
  local pkgs=(wireguard-tools qrencode)
  DEBIAN_FRONTEND=noninteractive run apt-get install -y -q --no-install-recommends "${pkgs[@]}" && return 0
  run apt-get update -q && DEBIAN_FRONTEND=noninteractive run apt-get install -y -q --no-install-recommends "${pkgs[@]}"
}

# _wg_up — start (or refresh) wg0 from Lumen's wg0.conf.
_wg_up() {
  if ip link show wg0 >/dev/null 2>&1; then
    # Already up (Lumen's): apply the configuration without dropping sessions.
    run bash -c 'wg syncconf wg0 <(wg-quick strip wg0)' || return 1
  elif has_systemd; then
    if ! run systemctl start wg-quick@wg0.service; then
      systemctl stop wg-quick@wg0.service >/dev/null 2>&1 || true
      systemctl reset-failed wg-quick@wg0.service >/dev/null 2>&1 || true
      return 1
    fi
  else
    run wg-quick up wg0 || return 1
  fi
  if has_systemd && ! systemctl is-enabled --quiet wg-quick@wg0.service 2>/dev/null; then
    run systemctl enable wg-quick@wg0.service || warn "could not enable wg-quick@wg0 at boot"
  fi
  ip link show wg0 >/dev/null 2>&1
}

# wireguard_enable — bring up private operator access, idempotently:
#   a free subnet, the endpoint devices dial, the server key, wg0, and (once) a first device.
# Returns 1 after recording state "unavailable" and explaining why when this host can't run
# WireGuard; it never overwrites, starts or stops a WireGuard setup that Lumen did not create.
# Firewall rules come from configure_firewall (run it afterwards).
wireguard_enable() {
  WG_REASON=""; WG_HOW=""
  wireguard_wanted || return 0
  local port; port="$(conf_get WG_PORT 51820)"
  _wg_packages || { _wg_unavailable "could not install wireguard-tools and qrencode (apt-get failed; see $_log_file)"; return 1; }

  # 1. Look before touching anything: a WireGuard setup that isn't Lumen's, subnet, endpoint.
  local pub="" plan k v foreign="" subnet="" subnet_note="" endpoint="" endpoint_note=""
  [[ -z "$(conf_get WG_ENDPOINT)" ]] && pub="$(public_ip)"
  if ! plan="$(_wg_agent wg-plan --public-ip "$pub" --lan-ip "$(lan_ipv4)" 2>>"$_log_file")"; then
    _wg_unavailable "could not choose a WireGuard subnet: $(tail -n1 "$_log_file" | sed 's/^error: //')"; return 1
  fi
  while IFS='=' read -r k v; do
    case "$k" in
      FOREIGN) foreign="$v" ;; SUBNET) subnet="$v" ;; SUBNET_NOTE) subnet_note="$v" ;;
      ENDPOINT) endpoint="$v" ;; ENDPOINT_NOTE) endpoint_note="$v" ;;
    esac
  done <<<"$plan"
  # The subnet is written even when WireGuard can't run here: the console's allow-list must
  # never cover a network this host already uses (e.g. a foreign wg0's).
  if [[ -n "$subnet" && "$subnet" != "$(conf_get WG_SUBNET 10.77.0.0/24)" ]]; then
    conf_set WG_SUBNET "$subnet"
    info "WG_SUBNET=$subnet${subnet_note:+ ($subnet_note)}"
  fi
  [[ -z "$foreign" ]] || { _wg_unavailable "$foreign"; return 1; }
  if [[ -z "$(conf_get WG_ENDPOINT)" ]]; then
    if [[ -n "$endpoint" ]]; then
      conf_set WG_ENDPOINT "$endpoint"
      info "WG_ENDPOINT=$endpoint ($endpoint_note; change it in $LUMEN_CONF if devices reach this server another way)"
    else
      warn "could not tell which address devices use to reach this server: set WG_ENDPOINT in $LUMEN_CONF"
    fi
  fi

  # 2. Kernel support (or wireguard-go) and a free port, unless Lumen's wg0 already runs.
  if ! ip link show wg0 >/dev/null 2>&1; then
    WG_HOW="$(_wg_support)" || { _wg_unavailable "$WG_HOW"; return 1; }
    if [[ -n "$(ss -Hlun "sport = :$port" 2>/dev/null)" ]]; then
      _wg_unavailable "UDP port $port is already in use on this host (set WG_PORT to a free port in $LUMEN_CONF)"; return 1
    fi
  else
    WG_HOW="already running"
  fi

  # 3. Server key (generated here, never printed) and wg0.conf, then the interface.
  _wg_agent init-wireguard >/dev/null 2>>"$_log_file" \
    || { _wg_unavailable "could not write the WireGuard server configuration (see $_log_file)"; return 1; }
  _wg_up || { _wg_unavailable "wg-quick could not start wg0 (see $_log_file$(has_systemd && echo " and journalctl -u wg-quick@wg0"))"; return 1; }
  state_set wireguard enabled
  state_set wireguard_reason ""
  ok "WireGuard up on wg0 ($(conf_get WG_SUBNET 10.77.0.0/24), UDP $port${WG_HOW:+, $WG_HOW}); devices dial $(conf_get WG_ENDPOINT "<WG_ENDPOINT>"):$port"

  # 4. The first operator device: once. Re-runs never add another or generate new keys.
  local opuser name out
  opuser="$(conf_get OPERATOR_USERNAME operator)"; name="${opuser:0:25}-device"
  if out="$(_wg_agent wg-first-peer --name "$name" --out "$WG_FIRST_PROFILE" 2>>"$_log_file")"; then
    case "$out" in
      created*) ok "first device '$name' added ($(awk '{print $3}' <<<"$out")); profile: $WG_FIRST_PROFILE (root only)" ;;
      exists*) ok "first device '$(awk '{print $2}' <<<"$out")' already registered (keys unchanged)$([[ -f "$WG_FIRST_PROFILE" ]] && echo "; profile still stored: $WG_FIRST_PROFILE")" ;;
      *) ok "devices already registered; no first device added" ;;
    esac
  else
    warn "could not create the first device profile (see $_log_file); add one with: sudo ./lumenctl wireguard add-peer <name>"
  fi
  return 0
}

wireguard_disable() {
  if [[ -e "$WG_CONF_FILE" ]] && ! head -n 3 "$WG_CONF_FILE" | grep -qF '# Managed by Lumen (lumen-agent)'; then
    ok "WireGuard off in Lumen; the existing non-Lumen $WG_CONF_FILE and its wg0 were left untouched"
    return 0
  fi
  if has_systemd; then
    systemctl disable --now wg-quick@wg0.service >/dev/null 2>&1 || true
  else
    wg-quick down wg0 >/dev/null 2>&1 || true
  fi
  state_set wireguard "disabled"
  ok "WireGuard stopped (keys kept in $LUMEN_CONFIG_DIR/wireguard; delete them to revoke everything)"
}

# wireguard_summary_lines — the WireGuard part of the install summary (paths only, never keys).
wireguard_summary_lines() {
  local port subnet ops opsport srv
  port="$(conf_get WG_PORT 51820)"; subnet="$(conf_get WG_SUBNET 10.77.0.0/24)"
  ops="$(conf_get LUMEN_OPS_DOMAIN "ops.$(conf_get LUMEN_PRIMARY_DOMAIN)")"; opsport="$(conf_get LUMEN_OPS_PORT 8443)"
  if ! wireguard_wanted; then
    printf 'WireGuard:          off; turn it on with: sudo ./lumenctl wireguard enable\n'
  elif wireguard_active; then
    srv="$(python3 -c 'import ipaddress,sys; print(next(ipaddress.ip_network(sys.argv[1]).hosts()))' "$subnet")"
    if [[ -f "$WG_FIRST_PROFILE" ]]; then
      printf 'WireGuard:          on (wg0, %s, UDP %s); first device profile: %s — show as QR: sudo ./lumenctl wireguard show-profile\n' "$subnet" "$port" "$WG_FIRST_PROFILE"
    else
      printf 'WireGuard:          on (wg0, %s, UDP %s); add devices in the console (WireGuard page) or: sudo ./lumenctl wireguard add-peer <name>\n' "$subnet" "$port"
    fi
    printf '                    console via WireGuard: https://%s:%s/  (hosts file on the device: %s %s)\n' "$ops" "$opsport" "$srv" "$ops"
    printf '                    devices dial %s:%s. If your provider has its own firewall (security group), allow UDP %s there.\n' "$(conf_get WG_ENDPOINT "<WG_ENDPOINT>")" "$port" "$port"
  else
    printf 'WireGuard:          unavailable — %s\n' "$(state_get wireguard_reason)"
    printf '                    use the SSH tunnel below; retry with: sudo ./lumenctl wireguard enable\n'
  fi
}
