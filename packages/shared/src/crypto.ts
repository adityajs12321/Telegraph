// Identity keys, end-to-end encryption and request signing.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { ChatMessage, Envelope, PublicKeys } from "./protocol.js";

export interface Identity extends PublicKeys {
  signPriv: string; // base64 PKCS8 DER
  boxPriv: string; // base64 PKCS8 DER
}

const b64 = (b: Buffer) => b.toString("base64");
const pub = (k: string) => createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" });
const priv = (k: string) => createPrivateKey({ key: Buffer.from(k, "base64"), format: "der", type: "pkcs8" });
const exportPub = (k: KeyObject) => b64(k.export({ format: "der", type: "spki" }));
const exportPriv = (k: KeyObject) => b64(k.export({ format: "der", type: "pkcs8" }));

export function generateIdentity(): Identity {
  const s = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("x25519");
  return {
    signPub: exportPub(s.publicKey),
    signPriv: exportPriv(s.privateKey),
    boxPub: exportPub(b.publicKey),
    boxPriv: exportPriv(b.privateKey),
  };
}

export function signData(data: string | Buffer, signPriv: string): string {
  return b64(sign(null, Buffer.from(data), priv(signPriv)));
}

export function verifyData(data: string | Buffer, signature: string, signPub: string): boolean {
  try {
    return verify(null, Buffer.from(data), pub(signPub), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// ---- Request signing ----

export function requestDigest(method: string, path: string, timestamp: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
}

// ---- End-to-end encryption ----

function deriveKey(shared: Buffer, epk: string, recipientBoxPub: string): Buffer {
  const info = Buffer.from(`telegraph-v1|${epk}|${recipientBoxPub}`);
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), info, 32));
}

const aad = (e: Pick<Envelope, "id" | "from" | "to">) => Buffer.from(`${e.id}|${e.from}|${e.to}`);

// Encrypts and signs a message
export function seal(msg: ChatMessage, sender: Identity, recipientBoxPub: string): Envelope {
  const payload = JSON.stringify({ message: msg, sig: signData(JSON.stringify(msg), sender.signPriv) });

  const eph = generateKeyPairSync("x25519");
  const epk = exportPub(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub(recipientBoxPub) });
  const key = deriveKey(shared, epk, recipientBoxPub);

  const iv = randomBytes(12);
  const head = { id: msg.id, from: msg.from, to: msg.to };
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(head));
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);

  return {
    ...head,
    toKey: recipientBoxPub,
    epk,
    iv: b64(iv),
    ciphertext: b64(ciphertext),
    tag: b64(cipher.getAuthTag()),
  };
}

// Decrypts an envelope and checks the sender's signature
export function open(env: Envelope, me: Identity, senderSignPub: string): ChatMessage {
  const shared = diffieHellman({ privateKey: priv(me.boxPriv), publicKey: pub(env.epk) });
  const key = deriveKey(shared, env.epk, me.boxPub);

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAAD(aad(env));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, "base64")), decipher.final()]);

  const { message, sig } = JSON.parse(plain.toString("utf8")) as { message: ChatMessage; sig: string };
  if (!verifyData(JSON.stringify(message), sig, senderSignPub)) throw new Error("bad signature");
  if (message.id !== env.id || message.from !== env.from || message.to !== env.to) {
    throw new Error("envelope/message mismatch");
  }
  return message;
}
