#!/usr/bin/env bash
set -euo pipefail

# Generate a VAPID key pair (RFC 8292) for PWA Web Push.
#
# Output format matches what backend/Feedback.Infrastructure/Pwa/PwaPushClient.cs
# `CreateEcdsa` expects when reading the secret values:
#   - PRIVATE: 32 bytes (P-256 scalar D), base64url-encoded.
#   - PUBLIC : 65 bytes (uncompressed P-256 point Q starting with 0x04),
#              base64url-encoded.
#
# Usage:
#   deploy/k8s/scripts/generate-vapid-keys.sh
#
# Then paste the printed values into deploy/k8s/secrets.yaml under
#   PwaPush__PublicKey  / PwaPush__PrivateKey
# (or, better, into a SealedSecret / ExternalSecret store).
#
# Requirements: openssl, xxd, base64.

command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 1; }
command -v xxd     >/dev/null || { echo "xxd not found"     >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

openssl ecparam -name prime256v1 -genkey -noout -out "$TMP/private.pem" 2>/dev/null

# Extract the 32-byte private scalar D from the PEM.
# `openssl ec -text -noout` prints it under "priv:" as 0x... bytes; strip
# the leading 0x00 byte that DER inserts for positive integers if present.
PRIVATE_HEX=$(openssl ec -in "$TMP/private.pem" -text -noout 2>/dev/null \
  | awk '/priv:/{flag=1; next} /pub:/{flag=0} flag' \
  | tr -d ' :\n' \
  | sed 's/^00//')

# Extract the 65-byte uncompressed public point Q (starts with 04 || X || Y).
PUBLIC_HEX=$(openssl ec -in "$TMP/private.pem" -text -noout 2>/dev/null \
  | awk '/pub:/{flag=1; next} /ASN1 OID/{flag=0} flag' \
  | tr -d ' :\n')

b64url() {
  xxd -r -p | base64 -w0 | tr '+/' '-_' | tr -d '='
}

PRIVATE_B64URL=$(printf '%s' "$PRIVATE_HEX" | b64url)
PUBLIC_B64URL=$(printf '%s' "$PUBLIC_HEX" | b64url)

# Sanity check: lengths must match the format the dispatcher expects.
PRIV_LEN=$((${#PRIVATE_HEX} / 2))
PUB_LEN=$((${#PUBLIC_HEX} / 2))
if [[ "$PRIV_LEN" -ne 32 ]]; then
  echo "ERROR: private key is $PRIV_LEN bytes, expected 32" >&2
  exit 2
fi
if [[ "$PUB_LEN" -ne 65 ]]; then
  echo "ERROR: public key is $PUB_LEN bytes, expected 65 (uncompressed P-256)" >&2
  exit 2
fi
if [[ "${PUBLIC_HEX:0:2}" != "04" ]]; then
  echo "ERROR: public key does not start with 0x04 (uncompressed marker)" >&2
  exit 2
fi

echo "# Paste these into deploy/k8s/secrets.yaml (or your secret store)."
echo "PwaPush__PublicKey:  $PUBLIC_B64URL"
echo "PwaPush__PrivateKey: $PRIVATE_B64URL"
