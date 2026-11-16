import { describe, expect, it } from "vitest";
import { b64urlDecode, b64urlEncode, encryptPayload, vapidAuthorization } from "../src/push";

const enc = new TextEncoder();
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) => {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
};

describe("web push", () => {
  it("encrypts a message the browser can decrypt (RFC 8291)", async () => {
    // Play the browser: make a subscription key pair and auth secret.
    const browser = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const browserPublic = new Uint8Array(await crypto.subtle.exportKey("raw", browser.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const message = JSON.stringify({ title: "New at Regent Theatre: Six", body: "Tue 28 Sep - Sat 2 Oct 2027" });

    const body = await encryptPayload({ endpoint: "https://push.example/abc", p256dh: b64urlEncode(browserPublic), auth: b64urlEncode(auth) }, message);

    // Decrypt as the browser would.
    const salt = body.slice(0, 16);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
    const idLength = body[20]!;
    expect(idLength).toBe(65);
    const serverPublic = body.slice(21, 21 + idLength);
    const ciphertext = body.slice(21 + idLength);

    const serverKey = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, browser.privateKey, 256));
    const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...browserPublic, ...serverPublic]);
    const ikm = await hkdf(auth, shared, info, 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext));

    expect(plain[plain.length - 1]).toBe(2);
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(message);
  });

  it("signs a VAPID token the push service can verify", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const privateKey = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/xyz", { publicKey, privateKey, subject: "mailto:me@example.com" }, 1_800_000_000_000);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(match[4]).toBe(publicKey);
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(match[2]!)));
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_800_000_000 + 43_200, sub: "mailto:me@example.com" });
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, b64urlDecode(match[3]!), enc.encode(`${match[1]}.${match[2]}`));
    expect(valid).toBe(true);
  });
});
