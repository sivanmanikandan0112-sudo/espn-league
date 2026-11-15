// Web Push, using only the built-in WebCrypto: payload encryption (RFC 8291, aes128gcm) and the VAPID signature
// (RFC 8292) that proves the alerts come from this worker. The signing key is one secret, VAPID_PRIVATE: a P-256
// private key as a JWK. Its public half (x, y) is what browsers subscribe with, so nothing else needs storing.

const enc = new TextEncoder();

export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function unb64u(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// The browser's subscription keys (p256dh, auth) -> one aes128gcm record holding the payload.
export async function encryptPayload(keys, payload) {
  const ua = unb64u(keys.p256dh), auth = unb64u(keys.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = concat(enc.encode(payload), new Uint8Array([2])); // 2 = last (and only) record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, body));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPub.length;
  return concat(head, asPub, ct);
}

function vapidJwk(env) {
  if (!env.VAPID_PRIVATE) return null;
  try { return JSON.parse(env.VAPID_PRIVATE); } catch (_) { return null; }
}

// The public key browsers subscribe with (uncompressed P-256 point, base64url), or null until the secret is set.
export function vapidPublic(env) {
  const jwk = vapidJwk(env);
  return jwk ? b64u(concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y))) : null;
}

let signer = null; // [jwk.x, CryptoKey]
async function vapidHeader(env, endpoint) {
  const jwk = vapidJwk(env);
  if (!signer || signer[0] !== jwk.x) {
    signer = [jwk.x, await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])];
  }
  const part = o => b64u(enc.encode(JSON.stringify(o)));
  const unsigned = part({ typ: "JWT", alg: "ES256" }) + "." + part({ aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "https://sivanmanikandan0112-sudo.github.io/espn-league/" });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer[1], enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapidPublic(env)}`;
}

// Send one alert to one browser. Returns the push service's status: 201 = delivered to the service, 404/410 = the
// subscription is gone (the browser unsubscribed or was reset) and should be forgotten.
export async function sendPush(env, sub, msg, { ttl = 3600, urgency = "high", topic } = {}) {
  const body = await encryptPayload(sub.keys, JSON.stringify(msg));
  const headers = { Authorization: await vapidHeader(env, sub.endpoint), "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: urgency };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const r = await fetch(sub.endpoint, { method: "POST", headers, body });
  return r.status;
}
