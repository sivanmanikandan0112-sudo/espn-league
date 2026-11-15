#!/bin/sh
# Makes the signing key for game-day alerts and stores it on the League HQ live worker as the VAPID_PRIVATE secret.
# The key is generated and piped straight into wrangler; it is never printed or saved to a file.
# Run it once. Running it again makes a new key, and every device then has to turn alerts off and on again.
set -e
cd "$(dirname "$0")"
node -e 'crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign"]).then(k=>crypto.subtle.exportKey("jwk",k.privateKey)).then(j=>process.stdout.write(JSON.stringify({kty:j.kty,crv:j.crv,x:j.x,y:j.y,d:j.d})))' \
  | npx wrangler secret put VAPID_PRIVATE
echo "Done. Alerts are switched on; turn them on per device in Settings → Alerts."
