# DNS examples

Replace `example.com` and the addresses with yours. All names point at the one
Lumen server. Create the records **before** running the installer with
`TLS_MODE=acme`: Let's Encrypt validates each name over HTTP/TLS-ALPN on ports
80/443.

## Required

```dns
; Website, customer portal, OIDC issuer and Matrix server name (@user:example.com)
example.com.          3600  IN  A     203.0.113.10
example.com.          3600  IN  AAAA  2001:db8::10      ; if the server has IPv6

; Web chat app
app.example.com.      3600  IN  A     203.0.113.10
app.example.com.      3600  IN  AAAA  2001:db8::10

; Homeserver: client API and federation (on port 443, delegated by .well-known)
matrix.example.com.   3600  IN  A     203.0.113.10
matrix.example.com.   3600  IN  AAAA  2001:db8::10

; Voice/video calls: SFU signalling (wss://rtc.example.com) and the TURN/TLS
; certificate name (LUMEN_RTC_DOMAIN). Media then flows to the same address on
; 7882-7889/udp, 7881/tcp, 3478/udp and 5349/tcp, so it must be the server's real
; public address (no CDN or HTTP proxy in front of this name).
rtc.example.com.      3600  IN  A     203.0.113.10
rtc.example.com.      3600  IN  AAAA  2001:db8::10

; Operator console certificate name. The console itself only accepts
; connections from the SSH tunnel or WireGuard, so this record only matters
; for issuing its certificate (ACME HTTP-01 on port 80).
ops.example.com.      3600  IN  A     203.0.113.10
```

Only add an `AAAA` record if IPv6 actually reaches the server; a broken IPv6
path makes ACME and federation fail for clients that prefer IPv6.

## Federation discovery

No SRV record is needed. Lumen serves
`https://example.com/.well-known/matrix/server` →
`{"m.server": "matrix.example.com:443"}` and
`/.well-known/matrix/client` for clients. Do **not** also publish
`_matrix-fed._tcp` SRV records pointing elsewhere; if old ones exist from a
previous Matrix server, remove them.

If the primary domain's website is hosted somewhere else (not on the Lumen
server), that host must serve the two `.well-known` files with the content
above (and `Access-Control-Allow-Origin: *` on the client file), or set
`MATRIX_SERVER_NAME` to a name that does point at Lumen before the first user
exists.

## CAA (recommended)

```dns
example.com.  3600  IN  CAA  0 issue "letsencrypt.org"
example.com.  3600  IN  CAA  0 iodef "mailto:security@example.com"
```

## Email (only if `SMTP_*` is configured)

Lumen sends through your SMTP provider. Follow the provider's SPF, DKIM and DMARC
instructions for the `SMTP_FROM` domain, e.g.:

```dns
example.com.          3600  IN  TXT  "v=spf1 include:_spf.your-provider.example ~all"
_dmarc.example.com.   3600  IN  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"
```

## Checking

```bash
dig +short A example.com app.example.com matrix.example.com ops.example.com
curl -s https://example.com/.well-known/matrix/server
sudo ./diagnose.sh          # on the server: checks DNS, TLS, discovery and federation
```

The public federation tester at `https://federationtester.matrix.org/` should
report success for `example.com` once the server is installed.
