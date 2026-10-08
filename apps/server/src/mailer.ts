// Sends login codes. Uses Resend (api key disabled for now, most likely wont use it)

export interface Mailer {
  sendLoginCode(email: string, code: string): Promise<void>;
}

export function createMailer(env = process.env): Mailer {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[server] RESEND_API_KEY not set");
    return {
      async sendLoginCode(email, code) {
        console.log(`[mail] login code for ${email}: ${code}`);
      },
    };
  }

  const from = env.EMAIL_FROM || "Telegraph <onboarding@resend.dev>";
  return {
    async sendLoginCode(email, code) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: email,
          subject: `Your Telegraph code: ${code}`,
          text: `Your Telegraph login code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for it, ignore this email.`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend returned ${res.status}: ${await res.text()}`);
    },
  };
}
