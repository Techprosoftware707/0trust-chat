# Disaster recovery

How to get a Lumen server back after something goes wrong, from "a migration
failed" to "the server is gone". Read it **before** you need it, and keep a copy
of this page and of the backup key off the server.

## What a backup contains

`backup.sh` (daily via `lumen-backup.timer`, before every update and before every
restore) writes `BACKUP_DIR/lumen-<host>-<UTC time>[-tag].tar.age`:

| Part | Why it matters |
|---|---|
| `db/lumen.dump` | portal: accounts, MFA, workspaces, plans, subscriptions, audit log |
| `db/synapse.dump` | homeserver: users, rooms, (encrypted) events, device and cross-signing public keys, users' encrypted key backups |
| `synapse/signing.key` | **the server's federation identity**; other servers trust events signed with it |
| `synapse/media.tar` | uploaded files (ciphertext for encrypted rooms) |
| `config/` | `lumen.conf`, `secrets/`, `branding/`, `wireguard/` |
| `caddy/data.tar` | TLS certificates and ACME account (saves re-issuance) |
| `manifest.json` | versions, server name, signing key ID, SHA-256 of every file |

The archive is encrypted with **age** to the key in
`/etc/lumen/backup/recipients.txt`; plaintext is only ever staged in a root-only
temporary directory. The matching private key is `/etc/lumen/backup/identity.txt`.

> **Without `identity.txt` the backups cannot be decrypted.** Copy it to a
> password manager or offline medium as soon as the server is installed. It is not
> inside the backups (that would defeat the encryption).

Retention: 7 daily + 4 weekly (`BACKUP_KEEP_DAILY`, `BACKUP_KEEP_WEEKLY`).
Off-site: set `BACKUP_REMOTE=user@host:/path` (rsync over SSH, key in
`/etc/lumen/backup/ssh_key`). A weekly timer (`lumen-backup-verify.timer`) and
every manual `restore.sh --verify-only` decrypt the latest archive, check every
file against the manifest and restore both databases into a throw-away
PostgreSQL container **without network access**, then run sanity queries. The
console's **Backups & updates** page shows the last backup and last verification.

**Targets** with defaults: recovery point (RPO) ≤ 24 h (daily backups; run
`backup.sh` more often via the timer if you need less), recovery time (RTO)
about 30–60 minutes for a full rebuild on a new server, mostly installer time.

## What a backup cannot bring back

* **Message keys.** They live on users' devices and in their encrypted key
  backups (which *are* in the database). Restoring the server never decrypts
  anything; users read history again with their devices or recovery keys.
* Events received after the backup was taken. Other servers will re-send recent
  federated events when they retry, but local messages written after the backup
  are lost (their senders' devices may still show them).
* Device sign-ins after the backup: those devices must sign in again.

## Scenario 1 — an update went wrong

`update.sh` rolls back configuration, images and the chat build automatically
when verification fails. If a **database migration** already ran, restore the
pre-update backup it printed:

```bash
sudo ./restore.sh /var/backups/lumen/lumen-<host>-<time>-pre-update.tar.age
```

## Scenario 2 — data damaged on a working server

(Accidental deletion, corrupt database, bad manual change.)

```bash
sudo ./restore.sh --verify-only latest            # or a specific archive
sudo ./restore.sh /var/backups/lumen/<archive>.tar.age
```

You type the server name to confirm. `restore.sh` takes a **safety backup**
(tag `pre-restore`) first, stops the services, drops and restores both
databases, restores the signing key and media (previous media kept as
`media_store.pre-restore-<ts>`), re-renders configuration, runs migrations,
starts everything and checks health. Then run `sudo ./healthcheck.sh` and look
at the console.

## Scenario 3 — the server is lost (rebuild on a new machine)

You need: the latest backup archive (from `BACKUP_REMOTE` or wherever you copied
it), `identity.txt`, and your `lumen.conf` (also inside the backup).

1. Provision a new Ubuntu 24.04 server. Keep the **same domain names**; you will
   point DNS at the new IP in step 6.
2. Install Lumen with the same configuration:
   ```bash
   git clone <your Lumen repository> lumen && cd lumen
   sudo bash install.sh --config lumen.conf --yes
   ```
   (With `TLS_MODE=acme` and DNS still pointing at the old address, certificate
   issuance fails; either move DNS first or accept that the installer reports the
   TLS checks as failed until step 6.)
3. Copy the archive and key in:
   ```bash
   sudo install -m 0600 identity.txt /root/identity.txt
   sudo cp lumen-<host>-<time>.tar.age /var/backups/lumen/
   ```
4. Verify, then restore **with configuration** (secrets, branding, WireGuard):
   ```bash
   cd /opt/lumen
   sudo ./restore.sh --verify-only /var/backups/lumen/<archive>.tar.age --identity /root/identity.txt
   sudo ./restore.sh /var/backups/lumen/<archive>.tar.age --with-config --identity /root/identity.txt
   ```
5. Keep using the original backup key so old and new backups share one key:
   ```bash
   sudo install -m 0600 /root/identity.txt /etc/lumen/backup/identity.txt
   sudo sh -c 'age-keygen -y /etc/lumen/backup/identity.txt > /etc/lumen/backup/recipients.txt'
   sudo shred -u /root/identity.txt
   ```
6. Point DNS at the new server, wait for propagation, then
   `sudo bash install.sh --config /etc/lumen/lumen.conf --yes` once more (issues
   certificates if needed and re-verifies everything) and `sudo ./healthcheck.sh`.
7. Federation resumes on its own: the server name and signing key are the same,
   so other servers accept it. If you had WireGuard peers, their profiles still
   work (the server keys were restored) when `WG_ENDPOINT` is a name that now
   points at the new server; if it was the old server's IP address, set
   `WG_ENDPOINT` to the new one and change `Endpoint` in each device's profile.
   The replacement server's own installation created a first device profile
   before the restore; that device is no longer registered, so delete the file
   unless the backup brought back your old one: `sudo ./lumenctl wireguard
   status` lists the registered devices, `sudo ./lumenctl wireguard
   forget-profile` deletes `/etc/lumen/wireguard/first-device.conf`.

## Scenario 4 — backup key lost

Existing backups are unreadable; that cannot be fixed. Immediately create a new
key and a fresh backup on the running server:

```bash
sudo mv /etc/lumen/backup/identity.txt /etc/lumen/backup/identity.txt.lost-$(date +%F)
sudo bash install.sh --config /etc/lumen/lumen.conf --yes   # generates a new key pair if missing
sudo ./backup.sh && sudo ./restore.sh --verify-only latest
```

Copy the new `identity.txt` off the server.

## Scenario 5 — operators locked out of the console

From a root shell on the server:

```bash
sudo ./lumenctl operator-link <username>     # new one-time link; password + MFA set up again
sudo ./lumenctl create-operator <new-user> <email> owner
```

Both are audit-logged. There is no other back door, by design.

## Scenario 6 — suspected compromise

1. Take the server off the network or restrict it to SSH from your address.
2. Preserve evidence: `sudo ./diagnose.sh > diag.txt`, copy `/var/log/lumen`,
   the Caddy and Synapse logs (`lumenctl logs <service>`), and verify the audit
   chain in the console (**Audit log → Verify chain**).
3. Rotate every internal secret (`lumenctl rotate ops-gateway`, `internal-api`,
   `synapse-admin`, `oidc-client`, `db-passwords`, `django`), external secrets
   at their providers (SMTP, Stripe) and then `lumenctl set-secret`.
4. If host root was compromised, rebuild on a clean machine (scenario 3) from a
   backup taken **before** the compromise, and treat that backup's secrets as
   exposed: rotate them after restore.
5. Tell users. Their messages were never on the server in plaintext, but they
   should check their device list (Settings → Sessions), remove unknown devices,
   and re-verify contacts whose identity shows as changed.
6. The homeserver signing key: if you believe it was stolen, it can be
   replaced, but other servers will treat it as a key change; old events remain
   verifiable via the old key ID. Plan this with the Matrix community's guidance
   — it is rarely necessary.

## Practice

Run a restore drill at least quarterly: build a scratch server, follow scenario 3
with the latest off-site backup, confirm that a test account can sign in and
read its history with its recovery key, then destroy the scratch server. The
repository's `tests/installer/dr.sh` automates the server-side part of this drill.
