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
# DNS inside the tunnel: dnsmasq (Ubuntu's dnsmasq-base: a binary, no system service) on the
# tunnel address only. It answers the console's name with that address and forwards the rest.
WG_DNS_UNIT=lumen-wg-dns.service
WG_DNS_CONF="$LUMEN_CONFIG_DIR/wireguard/dnsmasq.conf"
WG_DNS_PIDFILE=/run/lumen-wg-dns.pid   # without systemd only
WG_DNS_REASON=""

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

# _wg_dns_pid — the forwarder's main process ('' when it isn't running).
_wg_dns_pid() {
  local pid=""
  if has_systemd; then
    pid="$(systemctl show -p MainPID --value "$WG_DNS_UNIT" 2>/dev/null || true)"
  elif [[ -s "$WG_DNS_PIDFILE" ]]; then
    pid="$(cat "$WG_DNS_PIDFILE" 2>/dev/null || true)"
  fi
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && [[ "$(cat "/proc/$pid/comm" 2>/dev/null)" == dnsmasq ]]; then printf '%s' "$pid"; fi
  return 0
}

# _wg_dns_port_taken ADDR — another program (not Lumen's forwarder) would receive DNS queries for
# ADDR:53 (bound to ADDR or to a wildcard address): prints its name and returns 0.
_wg_dns_port_taken() {
  local addr="$1" ours line local_addr users
  ours="$(_wg_dns_pid)"
  while read -r line; do
    [[ -n "$line" ]] || continue
    local_addr="$(awk '{print $4}' <<<"$line")"
    case "$local_addr" in "$addr:53" | "0.0.0.0:53" | "*:53" | "[::]:53") ;; *) continue ;; esac
    users="$(grep -o 'users:(.*' <<<"$line" || true)"
    [[ -n "$ours" && "$users" == *"pid=$ours,"* ]] && continue
    users="$(grep -oE '"[^"]+"' <<<"$users" | head -n1 | tr -d '"')"
    printf '%s' "${users:-another program}"
    return 0
  done < <(ss -Hlnup 'sport = :53' 2>/dev/null; ss -Hlntp 'sport = :53' 2>/dev/null)
  return 1
}

# _wg_dns_install_unit — install lumen-wg-dns.service; returns 0 when the unit file changed.
_wg_dns_install_unit() {
  local dst="/etc/systemd/system/$WG_DNS_UNIT" tmp
  tmp="$(mktemp)"
  sed -e "s|@LUMEN_REPO_DIR@|$LUMEN_REPO_DIR|g" -e "s|@LUMEN_CONFIG_DIR@|$LUMEN_CONFIG_DIR|g" \
    "$LUMEN_REPO_DIR/deploy/systemd/$WG_DNS_UNIT" >"$tmp"
  if cmp -s "$tmp" "$dst"; then rm -f "$tmp"; return 1; fi
  install -m 0644 "$tmp" "$dst"; rm -f "$tmp"
  run systemctl daemon-reload
  return 0
}

# _wg_dns_stop — stop Lumen's forwarder (never any other DNS server).
_wg_dns_stop() {
  local pid
  if has_systemd; then
    [[ -e "/etc/systemd/system/$WG_DNS_UNIT" ]] && { systemctl disable --now "$WG_DNS_UNIT" >/dev/null 2>&1 || true; }
  else
    pid="$(_wg_dns_pid)"
    [[ -n "$pid" ]] && { kill "$pid" 2>/dev/null || true; }
    rm -f "$WG_DNS_PIDFILE"
  fi
  return 0
}

_wg_dns_unavailable() { # reason — record and explain; the caller returns 1
  WG_DNS_REASON="$1"
  _wg_dns_stop
  state_set wireguard_dns unavailable
  state_set wireguard_dns_reason "$1"
  warn "DNS in the tunnel unavailable: $1"
  warn "new device profiles get no DNS line; on each device the hosts-file line $(wg_server_ip) $(conf_get LUMEN_OPS_DOMAIN "ops.$(conf_get LUMEN_PRIMARY_DOMAIN)") points the console's name into the tunnel"
}

# _wg_dns_up — DNS inside the tunnel, idempotently: dnsmasq-base, its configuration, the service
# on the tunnel address only, then a real query. Only after Lumen's wg0 is up. Never fails
# WireGuard: without it, profiles get no DNS line and the hosts-file line works as before.
_wg_dns_up() {
  WG_DNS_REASON=""
  local out k v listen="" name="" changed=0 upstreams="" upnote="" owner pid
  if ! command -v dnsmasq >/dev/null 2>&1; then
    { DEBIAN_FRONTEND=noninteractive run apt-get install -y -q --no-install-recommends dnsmasq-base \
      || { run apt-get update -q && DEBIAN_FRONTEND=noninteractive run apt-get install -y -q --no-install-recommends dnsmasq-base; }; } \
      || { _wg_dns_unavailable "could not install dnsmasq-base (apt-get failed; see $_log_file)"; return 1; }
  fi
  if ! out="$(_wg_agent wg-dns-setup 2>>"$_log_file")"; then
    _wg_dns_unavailable "could not write $WG_DNS_CONF: $(tail -n1 "$_log_file" | sed 's/^error: //')"; return 1
  fi
  while IFS='=' read -r k v; do
    case "$k" in
      LISTEN) listen="$v" ;; NAME) name="$v" ;; CHANGED) changed="$v" ;; UPSTREAMS) upstreams="$v" ;; UPSTREAM_NOTE) upnote="$v" ;;
    esac
  done <<<"$out"
  if owner="$(_wg_dns_port_taken "$listen")"; then
    _wg_dns_unavailable "port 53 on $listen is already served by $owner (left untouched)"; return 1
  fi
  if has_systemd; then
    _wg_dns_install_unit && changed=1
    systemctl is-enabled --quiet "$WG_DNS_UNIT" 2>/dev/null || run systemctl enable "$WG_DNS_UNIT" || warn "could not enable $WG_DNS_UNIT at boot"
    if [[ "$changed" == 1 ]] || ! systemctl is-active --quiet "$WG_DNS_UNIT"; then
      run systemctl restart "$WG_DNS_UNIT" || { _wg_dns_unavailable "$WG_DNS_UNIT did not start (journalctl -u $WG_DNS_UNIT)"; return 1; }
    fi
  else
    # No systemd (as wg-quick without its unit): a daemon with a pid file, not started at boot.
    pid="$(_wg_dns_pid)"
    if [[ -n "$pid" && "$changed" == 1 ]]; then kill "$pid" 2>/dev/null || true; sleep 1; pid=""; fi
    if [[ -z "$pid" ]]; then
      run dnsmasq --conf-file="$WG_DNS_CONF" --pid-file="$WG_DNS_PIDFILE" || { _wg_dns_unavailable "dnsmasq did not start (see $_log_file)"; return 1; }
    fi
  fi
  if ! _wg_agent wg-dns-check --wait 15 >>"$_log_file" 2>&1; then
    _wg_dns_unavailable "the forwarder on $listen:53 did not answer (see $_log_file$(has_systemd && echo " and journalctl -u $WG_DNS_UNIT"))"; return 1
  fi
  state_set wireguard_dns enabled
  state_set wireguard_dns_reason ""
  ok "DNS in the tunnel on $listen:53 (wg0 only): $name -> $listen, other names forwarded to $upstreams ($upnote)"
}

# wireguard_enable — bring up private operator access, idempotently:
#   a free subnet, the endpoint devices dial, the server key, wg0, DNS inside the tunnel, and
#   (once) a first device.
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

  # 4. DNS inside the tunnel, before the first device: its profile gets the DNS line only when
  #    the forwarder answers. Firewall rules (53 on wg0 only) come from configure_firewall.
  _wg_dns_up || true

  # 5. The first operator device: once. Re-runs never add another or generate new keys.
  local opuser name out
  opuser="$(conf_get OPERATOR_USERNAME operator)"; name="${opuser:0:25}-device"
  if out="$(_wg_agent wg-first-peer --name "$name" --out "$WG_FIRST_PROFILE" 2>>"$_log_file")"; then
    case "$out" in
      created*) ok "first device '$name' added ($(awk '{print $3}' <<<"$out")); profile: $WG_FIRST_PROFILE (root only)" ;;
      exists*) ok "first device '$(awk '{print $2}' <<<"$out")' already registered (keys unchanged)$([[ -f "$WG_FIRST_PROFILE" ]] && echo "; profile still stored: $WG_FIRST_PROFILE")" ;;
      *) ok "devices already registered; no first device added" ;;
    esac
  else
    warn "could not create the first device profile (see $_log_file); add one with: sudo ./lumenctl wireguard add-device <name>"
  fi
  return 0
}

wireguard_disable() {
  if [[ -e "$WG_CONF_FILE" ]] && ! head -n 3 "$WG_CONF_FILE" | grep -qF '# Managed by Lumen (lumen-agent)'; then
    ok "WireGuard off in Lumen; the existing non-Lumen $WG_CONF_FILE and its wg0 were left untouched"
    return 0
  fi
  _wg_dns_stop
  if has_systemd; then
    systemctl disable --now wg-quick@wg0.service >/dev/null 2>&1 || true
  else
    wg-quick down wg0 >/dev/null 2>&1 || true
  fi
  state_set wireguard "disabled"
  state_set wireguard_dns "disabled"
  ok "WireGuard stopped, with its DNS in the tunnel (keys kept in $LUMEN_CONFIG_DIR/wireguard; delete them to revoke everything)"
}

# wireguard_dns_hint PREFIX — for devices whose profiles predate DNS in the tunnel: the two ways to
# give them the DNS line (nothing printed when every profile has it).
wireguard_dns_hint() {
  local without srv
  without="$(_wg_agent wg-dns-info 2>/dev/null | sed -n 's/^WITHOUT_DNS=//p')"
  [[ -n "$without" ]] || return 0
  srv="$(wg_server_ip)"
  printf '%sprofiles without the DNS line: %s. Add it in the WireGuard app (edit the tunnel, DNS servers: %s)\n' "$1" "${without//,/, }" "$srv"
  printf '%sor give the device a new profile: sudo ./lumenctl wireguard add-device <name>, then show-profile <name>\n' "$1"
}

# wireguard_summary_lines — the WireGuard part of the install summary (paths only, never keys).
wireguard_summary_lines() {
  local port subnet ops opsport srv
  port="$(conf_get WG_PORT 51820)"; subnet="$(conf_get WG_SUBNET 10.77.0.0/24)"
  ops="$(conf_get LUMEN_OPS_DOMAIN "ops.$(conf_get LUMEN_PRIMARY_DOMAIN)")"; opsport="$(conf_get LUMEN_OPS_PORT 8443)"
  if ! wireguard_wanted; then
    printf 'WireGuard:          off; turn it on with: sudo ./lumenctl wireguard enable\n'
  elif wireguard_active; then
    srv="$(wg_server_ip)"
    if [[ -f "$WG_FIRST_PROFILE" ]]; then
      printf 'WireGuard:          on (wg0, %s, UDP %s); first device profile: %s — show as QR: sudo ./lumenctl wireguard show-profile\n' "$subnet" "$port" "$WG_FIRST_PROFILE"
    else
      printf 'WireGuard:          on (wg0, %s, UDP %s); add a device (QR): sudo ./lumenctl wireguard add-device <name>, or in the console (WireGuard page)\n' "$subnet" "$port"
    fi
    if wireguard_dns_active; then
      printf '                    console via WireGuard: https://%s:%s/  (profiles set DNS = %s, which points the name into the tunnel: no hosts file)\n' "$ops" "$opsport" "$srv"
      wireguard_dns_hint '                    '
    else
      printf '                    console via WireGuard: https://%s:%s/  (hosts file on the device: %s %s%s)\n' "$ops" "$opsport" "$srv" "$ops" \
        "$( [[ -n "$(state_get wireguard_dns_reason)" ]] && echo "; DNS in the tunnel unavailable: $(state_get wireguard_dns_reason)")"
    fi
    printf '                    devices dial %s:%s. If your provider has its own firewall (security group), allow UDP %s there.\n' "$(conf_get WG_ENDPOINT "<WG_ENDPOINT>")" "$port" "$port"
  else
    printf 'WireGuard:          unavailable — %s\n' "$(state_get wireguard_reason)"
    printf '                    use the SSH tunnel below; retry with: sudo ./lumenctl wireguard enable\n'
  fi
}
