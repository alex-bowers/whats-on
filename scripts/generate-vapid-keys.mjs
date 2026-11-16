// Prints a new VAPID key pair for web push. Run once: npm run vapid
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const publicKey = Buffer.from(raw).toString("base64url");
const privateKey = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

console.log("VAPID_PUBLIC_KEY (safe to share):\n" + publicKey + "\n");
console.log("VAPID_PRIVATE_KEY (keep secret):\n" + privateKey + "\n");
console.log("Local development: put both in .dev.vars as NAME=value");
console.log("Production: npx wrangler secret put VAPID_PUBLIC_KEY, then npx wrangler secret put VAPID_PRIVATE_KEY");
