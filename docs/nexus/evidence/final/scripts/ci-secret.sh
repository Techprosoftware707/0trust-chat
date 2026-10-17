#!/usr/bin/env bash
# Copied from .github/workflows/ci.yml "No private keys or live tokens committed"
if git grep -lIE -- '-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----|sk_live_[0-9a-zA-Z]{10,}|whsec_[0-9a-zA-Z]{20,}|ghp_[0-9A-Za-z]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}' -- ':!tests/security/scan.sh' ':!.github/workflows/ci.yml'; then
  echo "::error::secret-like value committed"; exit 1
fi
if git ls-files | grep -E '\.(jks|keystore|p12|pfx|mobileprovision|p8)$|google-services\.json$|GoogleService-Info\.plist$'; then
  echo "::error::signing or credential file committed"; exit 1
fi
echo "no private keys, live tokens or signing/credential files committed"
