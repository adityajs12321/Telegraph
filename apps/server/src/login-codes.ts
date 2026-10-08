// One-time email codes that prove someone owns an email address.

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { HttpError } from "./auth.js";
import type { Mailer } from "./mailer.js";
import type { Store } from "./store.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 30 * 1000;
const MAX_ATTEMPTS = 5; // max retries

const hash = (code: string) => createHash("sha256").update(code).digest();

export class LoginCodes {
  constructor(private store: Store, private mailer: Mailer) {}

  async send(email: string) {
    const sentAt = await this.store.loginCodeSentAt(email);
    if (sentAt && Date.now() - sentAt.getTime() < RESEND_AFTER_MS) {
      throw new HttpError(429, "a code was just sent; wait 30 seconds before asking for another");
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.store.saveLoginCode(email, hash(code).toString("hex"), new Date(Date.now() + CODE_TTL_MS));
    try {
      await this.mailer.sendLoginCode(email, code);
    } catch (err) {
      await this.store.deleteLoginCode(email);
      console.error(`[server] couldn't email ${email}:`, err);
      throw new HttpError(502, "couldn't send the email; try again later");
    }
  }

  async check(email: string, code: string) {
    const codeHash = await this.store.takeLoginAttempt(email, MAX_ATTEMPTS);
    if (!codeHash) throw new HttpError(401, "code expired or too many wrong tries; ask for a new one");
    if (!/^\d{6}$/.test(code) || !timingSafeEqual(hash(code), Buffer.from(codeHash, "hex"))) {
      throw new HttpError(401, "wrong code");
    }
  }

  async consume(email: string) {
    await this.store.deleteLoginCode(email);
  }
}
