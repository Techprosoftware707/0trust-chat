#!/usr/bin/env bash
# shellcheck disable=SC2154,SC1090  # _log_file/colours come from common.sh; env files are generated
# Optional WireGuard: private operator access to the console port. Never used for
# chat or federation traffic, never required.

wireguard_enable() {
  truthy "$(conf_get WIREGUARD_ENABLED false)" || return 0
  command -v wg >/dev/null 2>&1 || apt_install wireguard-tools qrencode
  local pub
  pub="$(LUMEN_CONF="$LUMEN_CONF" python3 "$LUMEN_REPO_DIR/deploy/host-agent/lumen_agent.py" init-wireguard)" \
    || die "Could not initialise the WireGuard server key"
  if has_systemd; then
    run systemctl enable wg-quick@wg0.service
    if ip link show wg0 >/dev/null 2>&1; then
      run systemctl reload-or-restart wg-quick@wg0.service || run systemctl restart wg-quick@wg0.service
    else
      run systemctl start wg-quick@wg0.service || die "WireGuard interface failed to start (journalctl -u wg-quick@wg0)"
    fi
  else
    ip link show wg0 >/dev/null 2>&1 || run wg-quick up wg0 || die "wg-quick up wg0 failed"
  fi
  ip link show wg0 >/dev/null 2>&1 || die "wg0 is not up after starting WireGuard"
  state_set wireguard "enabled"
  ok "WireGuard up on wg0 ($(conf_get WG_SUBNET 10.77.0.0/24), UDP $(conf_get WG_PORT 51820)); server key ${pub:0:12}…"
}

wireguard_disable() {
  if has_systemd; then
    systemctl disable --now wg-quick@wg0.service >/dev/null 2>&1 || true
  else
    wg-quick down wg0 >/dev/null 2>&1 || true
  fi
  state_set wireguard "disabled"
  ok "WireGuard stopped (keys kept in $LUMEN_CONFIG_DIR/wireguard; delete them to revoke everything)"
}
