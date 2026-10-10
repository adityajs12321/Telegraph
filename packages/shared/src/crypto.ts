// Identity keys, end-to-end encryption and request signing.
// Uses WebCrypto, so the same code runs in the browser and on the server (Node 22+).

import type { ChatMessage, Envelope, PublicKeys } from "./protocol.js";

export interface Identity extends PublicKeys {
  signPriv: string; // base64 PKCS8 DER
  boxPriv: string; // base64 PKCS8 DER
}

const subtle = globalThis.crypto.subtle;
const ED25519 = { name: "Ed25519" };
const X25519 = { name: "X25519" };

const utf8 = (s: string) => new TextEncoder().encode(s);

function b64(data: ArrayBuffer | Uint8Array): string {
  let s = "";
  for (const byte of new Uint8Array(data)) s += String.fromCharCode(byte);
  return btoa(s);
}

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const importPub = (k: string, alg: typeof ED25519 | typeof X25519) =>
  subtle.importKey("spki", unb64(k), alg, true, alg === ED25519 ? ["verify"] : []);
const importPriv = (k: string, alg: typeof ED25519 | typeof X25519) =>
  subtle.importKey("pkcs8", unb64(k), alg, false, alg === ED25519 ? ["sign"] : ["deriveBits"]);
const exportPub = async (k: CryptoKey) => b64(await subtle.exportKey("spki", k));
const exportPriv = async (k: CryptoKey) => b64(await subtle.exportKey("pkcs8", k));

const generate = (alg: typeof ED25519 | typeof X25519) =>
  subtle.generateKey(alg, true, alg === ED25519 ? ["sign", "verify"] : ["deriveBits"]) as Promise<CryptoKeyPair>;

export async function generateIdentity(): Promise<Identity> {
  const s = await generate(ED25519);
  const b = await generate(X25519);
  return {
    signPub: await exportPub(s.publicKey),
    signPriv: await exportPriv(s.privateKey),
    boxPub: await exportPub(b.publicKey),
    boxPriv: await exportPriv(b.privateKey),
  };
}

export async function signData(data: string, signPriv: string): Promise<string> {
  return b64(await subtle.sign(ED25519, await importPriv(signPriv, ED25519), utf8(data)));
}

export async function verifyData(data: string, signature: string, signPub: string): Promise<boolean> {
  try {
    return await subtle.verify(ED25519, await importPub(signPub, ED25519), unb64(signature), utf8(data));
  } catch {
    return false;
  }
}

// ---- Request signing ----

export async function requestDigest(method: string, path: string, timestamp: string, body: string): Promise<string> {
  const hash = new Uint8Array(await subtle.digest("SHA-256", utf8(body)));
  const bodyHash = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
}

// ---- End-to-end encryption ----

const TAG_BYTES = 16;

async function deriveKey(privateKey: CryptoKey, publicKey: CryptoKey, epk: string, recipientBoxPub: string) {
  const shared = await subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const info = utf8(`telegraph-v1|${epk}|${recipientBoxPub}`);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const aad = (e: Pick<Envelope, "id" | "from" | "to">) => utf8(`${e.id}|${e.from}|${e.to}`);

// Encrypts and signs a message
export async function seal(msg: ChatMessage, sender: Identity, recipientBoxPub: string): Promise<Envelope> {
  const payload = JSON.stringify({ message: msg, sig: await signData(JSON.stringify(msg), sender.signPriv) });

  const eph = await generate(X25519);
  const epk = await exportPub(eph.publicKey);
  const key = await deriveKey(eph.privateKey, await importPub(recipientBoxPub, X25519), epk, recipientBoxPub);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const head = { id: msg.id, from: msg.from, to: msg.to };
  // WebCrypto appends the GCM tag to the ciphertext; the envelope carries it separately.
  const sealed = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(head) }, key, utf8(payload))
  );

  return {
    ...head,
    toKey: recipientBoxPub,
    epk,
    iv: b64(iv),
    ciphertext: b64(sealed.subarray(0, -TAG_BYTES)),
    tag: b64(sealed.subarray(-TAG_BYTES)),
  };
}

// Decrypts an envelope and checks the sender's signature
export async function open(env: Envelope, me: Identity, senderSignPub: string): Promise<ChatMessage> {
  const key = await deriveKey(await importPriv(me.boxPriv, X25519), await importPub(env.epk, X25519), env.epk, me.boxPub);

  const ciphertext = unb64(env.ciphertext);
  const tag = unb64(env.tag);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv), additionalData: aad(env) }, key, sealed);

  const { message, sig } = JSON.parse(new TextDecoder().decode(plain)) as { message: ChatMessage; sig: string };
  if (!(await verifyData(JSON.stringify(message), sig, senderSignPub))) throw new Error("bad signature");
  if (message.id !== env.id || message.from !== env.from || message.to !== env.to) {
    throw new Error("envelope/message mismatch");
  }
  return message;
}
