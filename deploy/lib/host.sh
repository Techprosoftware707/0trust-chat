#!/usr/bin/env bash
# shellcheck disable=SC2154,SC1090  # _log_file/colours come from common.sh; env files are generated
# Host-level setup: packages, Docker, firewall, automatic updates, systemd units.

apt_install() {
  DEBIAN_FRONTEND=noninteractive run apt-get install -y -q --no-install-recommends "$@" \
    || die "apt-get install $* failed. See $_log_file"
}

install_packages() {
  run apt-get update -q || die "apt-get update failed (check DNS / mirror access). See $_log_file"
  local pkgs=(ca-certificates curl gnupg jq age openssl python3 rsync iproute2 util-linux unattended-upgrades update-notifier-common)
  command -v ufw >/dev/null 2>&1 || { [[ "$(conf_get FIREWALL_MANAGE auto)" != no ]] && pkgs+=(ufw); }
  truthy "$(conf_get WIREGUARD_ENABLED false)" && pkgs+=(wireguard-tools qrencode)
  apt_install "${pkgs[@]}"
  ok "host packages installed: ${pkgs[*]}"
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    if ! docker info >/dev/null 2>&1; then
      has_systemd && run systemctl enable --now docker
    fi
    docker info >/dev/null 2>&1 || die "Docker is installed but its daemon is not running."
    ok "Docker already installed ($(docker version --format '{{.Server.Version}}'))"
    return
  fi
  info "installing Docker Engine from download.docker.com"
  install -d -m 0755 /etc/apt/keyrings
  run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    || die "Could not download Docker's signing key"
  chmod a+r /etc/apt/keyrings/docker.asc
  local codename arch
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  arch="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$codename" \
    >/etc/apt/sources.list.d/docker.list
  run apt-get update -q || die "apt-get update (Docker repository) failed"
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  if [[ ! -f /etc/docker/daemon.json ]]; then
    install -d -m 0755 /etc/docker
    cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
JSON
  fi
  if has_systemd; then
    run systemctl enable --now docker containerd || die "Could not start Docker"
  fi
  docker info >/dev/null 2>&1 || die "Docker was installed but the daemon is not running"
  ok "Docker installed ($(docker version --format '{{.Server.Version}}'))"
}

ensure_groups() {
  getent group "$GID_SECRETS" >/dev/null || run groupadd --system -g "$GID_SECRETS" lumen-secrets
  getent group "$GID_SOCKETS" >/dev/null || run groupadd --system -g "$GID_SOCKETS" lumen-sockets
}

sshd_ports() {
  local ports
  ports="$(ss -ltnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u | tr '\n' ' ')"
  [[ -z "$ports" ]] && ports="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/ {print $2}' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sort -u | tr '\n' ' ')"
  [[ -z "$ports" ]] && ports=22
  printf '%s' "$ports"
}

# configure_firewall — additive UFW rules; never resets an existing policy.
configure_firewall() {
  local manage; manage="$(conf_get FIREWALL_MANAGE auto)"
  if [[ "$manage" == no ]]; then
    warn "firewall management disabled (FIREWALL_MANAGE=no); open 80/tcp, 443/tcp, 443/udp yourself"
    return
  fi
  if ! command -v ufw >/dev/null 2>&1; then
    warn "ufw not available; skipping firewall configuration"
    return
  fi
  if has_systemd && systemctl is-active --quiet firewalld 2>/dev/null; then
    warn "firewalld is active; not touching it. Required: 80/tcp, 443/tcp, 443/udp$(truthy "$(conf_get VOIP_ENABLED false)" && echo ", 3478/udp+tcp, $(conf_get TURN_MIN_PORT 49160)-$(conf_get TURN_MAX_PORT 49200)/udp")"
    return
  fi
  local port added=()
  for port in $(sshd_ports); do
    run ufw allow "$port/tcp" comment 'lumen: ssh (kept open)' && added+=("$port/tcp")
  done
  run ufw allow 80/tcp comment 'lumen: http (ACME + redirect)' && added+=(80/tcp)
  run ufw allow 443/tcp comment 'lumen: https' && added+=(443/tcp)
  run ufw allow 443/udp comment 'lumen: http3' && added+=(443/udp)
  if truthy "$(conf_get VOIP_ENABLED false)"; then
    run ufw allow 3478/udp comment 'lumen: turn' && added+=(3478/udp)
    run ufw allow 3478/tcp comment 'lumen: turn' && added+=(3478/tcp)
    run ufw allow "$(conf_get TURN_MIN_PORT 49160):$(conf_get TURN_MAX_PORT 49200)/udp" comment 'lumen: turn relay' && added+=("turn-relay/udp")
  fi
  local ops_port wg_if; ops_port="$(conf_get LUMEN_OPS_PORT 8443)"
  if truthy "$(conf_get WIREGUARD_ENABLED false)"; then
    run ufw allow "$(conf_get WG_PORT 51820)/udp" comment 'lumen: wireguard' && added+=("$(conf_get WG_PORT 51820)/udp")
    wg_if=wg0
    run ufw allow in on "$wg_if" to any port "$ops_port" proto tcp comment 'lumen: operator console via wireguard' && added+=("$ops_port/tcp on $wg_if")
  fi
  local cidr
  for cidr in $(conf_get ADMIN_ALLOWED_CIDRS | tr ',' ' '); do
    run ufw allow from "$cidr" to any port "$ops_port" proto tcp comment 'lumen: operator console allow-list' && added+=("$ops_port/tcp from $cidr")
  done
  if ! ufw status | grep -q "Status: active"; then
    run ufw default deny incoming
    run ufw default allow outgoing
    run ufw --force enable || die "Could not enable UFW"
    ok "UFW enabled (default deny incoming; SSH kept open on: $(sshd_ports))"
  fi
  state_set firewall_rules "${added[*]}"
  ok "firewall rules ensured: ${added[*]}"
}

configure_unattended_upgrades() {
  if [[ "$(conf_get UNATTENDED_UPGRADES yes)" == no ]]; then
    warn "automatic security updates left unchanged (UNATTENDED_UPGRADES=no)"
    return
  fi
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
  # Security updates only; never reboot automatically (operator decides).
  cat >/etc/apt/apt.conf.d/52lumen-unattended <<'EOF'
// Managed by Lumen.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
// Docker packages are updated deliberately by the operator (update.sh), not automatically.
Unattended-Upgrade::Package-Blacklist { "docker-ce"; "docker-ce-cli"; "containerd.io"; "docker-compose-plugin"; "docker-buildx-plugin"; };
EOF
  if has_systemd; then run systemctl enable --now unattended-upgrades.service || true; fi
  ok "automatic security updates enabled (no automatic reboots)"
}

install_systemd_units() {
  if ! has_systemd; then
    warn "systemd not available: skipping lumen-agent, backup and health timers"
    return
  fi
  local repo="$LUMEN_REPO_DIR"
  install -d -m 0755 /usr/local/lib/lumen
  install -m 0755 "$repo/deploy/host-agent/lumen_agent.py" /usr/local/lib/lumen/lumen_agent.py
  local unit
  for unit in "$repo"/deploy/systemd/*.service "$repo"/deploy/systemd/*.timer; do
    sed -e "s|@LUMEN_REPO_DIR@|$repo|g" "$unit" >"/etc/systemd/system/$(basename "$unit")"
    chmod 0644 "/etc/systemd/system/$(basename "$unit")"
  done
  local backup_time; backup_time="$(conf_get BACKUP_SCHEDULE 03:17)"
  install -d -m 0755 /etc/systemd/system/lumen-backup.timer.d
  printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* %s:00\n' "$backup_time" >/etc/systemd/system/lumen-backup.timer.d/schedule.conf
  # Docker must start Lumen's containers after the agent's runtime dir exists.
  install -d -m 0755 /etc/systemd/system/docker.service.d
  cat >/etc/systemd/system/docker.service.d/lumen.conf <<'EOF'
[Unit]
Wants=lumen-agent.service
EOF
  if truthy "$(conf_get WIREGUARD_ENABLED false)"; then
    printf '[Unit]\nAfter=wg-quick@wg0.service\nWants=wg-quick@wg0.service\n' >>/etc/systemd/system/docker.service.d/lumen.conf
  fi
  run systemctl daemon-reload
  run systemctl enable --now lumen-agent.service || die "lumen-agent failed to start; see journalctl -u lumen-agent"
  run systemctl enable --now lumen-backup.timer lumen-healthcheck.timer lumen-backup-verify.timer
  ok "systemd units installed: lumen-agent, lumen-backup.timer ($backup_time daily), lumen-healthcheck.timer"
}

ensure_backup_keys() {
  local dir="$LUMEN_CONFIG_DIR/backup"
  install -d -m 0700 "$dir"
  if [[ ! -s "$dir/identity.txt" ]]; then
    (umask 077 && age-keygen -o "$dir/identity.txt" 2>/dev/null)
    grep -o 'age1[0-9a-z]*' "$dir/identity.txt" >"$dir/recipients.txt"
    chmod 0600 "$dir/identity.txt" "$dir/recipients.txt"
    state_set backup_identity_created "$(date -u +%FT%TZ)"
    ok "backup encryption key created ($dir/identity.txt) — copy it somewhere safe, off this server"
  else
    ok "backup encryption key present"
  fi
  install -d -m 0700 "$(conf_get BACKUP_DIR /var/backups/lumen)"
}
