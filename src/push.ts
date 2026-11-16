// Web Push, implemented directly on Web Crypto so the Worker needs no dependencies.
//   - Message encryption: RFC 8291 with the aes128gcm content encoding (RFC 8188)
//   - Sender identification: VAPID (RFC 8292), an ES256-signed JWT

export interface PushSubscription {
  endpoint: string;
  p256dh: string; // base64url, the browser's P-256 public key (65 bytes uncompressed)
  auth: string; // base64url, 16-byte shared secret
}

export interface VapidKeys {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateKey: string; // JSON Web Key as a string, as printed by `npm run vapid`
  subject: string; // mailto: or https: contact
}

const encoder = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** Encrypt a payload for one subscription. Returns the request body for the push service. */
export async function encryptPayload(sub: PushSubscription, payload: string): Promise<Uint8Array> {
  const clientPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  if (clientPublic.length !== 65 || authSecret.length !== 16) throw new Error("malformed push subscription keys");

  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const localPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  // The generated Workers types name this field "$public"; the runtime takes the standard "public".
  const ecdh: SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey } = { name: "ECDH", public: clientKey };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), clientPublic, localPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  // A single record: the payload followed by the 0x02 "last record" delimiter.
  const plaintext = concat(encoder.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  // Header: salt (16) | record size (4, big endian) | key id length (1) | key id (our public key)
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = localPublic.length;
  return concat(header, localPublic, ciphertext);
}

export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): Promise<string> {
  const jwk = JSON.parse(vapid.privateKey) as JsonWebKey;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: object) => b64urlEncode(encoder.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: vapid.subject,
  })}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${b64urlEncode(new Uint8Array(signature))}, k=${vapid.publicKey}`;
}

export type PushResult = "sent" | "gone" | "failed";

/** Send one notification. "gone" means the subscription has expired and should be deleted. */
export async function sendPush(sub: PushSubscription, payload: object, vapid: VapidKeys): Promise<PushResult> {
  try {
    const body = await encryptPayload(sub, JSON.stringify(payload));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(sub.endpoint, vapid),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal",
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) {
      console.error(JSON.stringify({ message: "push rejected", status: res.status, host: new URL(sub.endpoint).host }));
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error(JSON.stringify({ message: "push failed", error: e instanceof Error ? e.message : String(e) }));
    return "failed";
  }
}
