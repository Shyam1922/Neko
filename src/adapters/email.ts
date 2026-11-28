// Sending email, optional. With RESEND_API_KEY and EMAIL_FROM set, mail goes through Resend's HTTP API
// (free tier); without them there is no mailer at all, and the app never offers email.

export interface Email {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>; // e.g. List-Unsubscribe
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string, private fetchFn: typeof fetch = fetch) {}

  async send(email: Email): Promise<void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text, headers: email.headers }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Email not sent: Resend answered ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

/**
 * Local development only (EMAIL_LOG=1, and only when Resend is not configured): prints each email, sign-in
 * links included, to the server log so the flow can be tried without an email account. Never set it on a
 * deployed server: anyone who can read its logs could use the links.
 */
export class ConsoleMailer implements Mailer {
  async send(email: Email) {
    console.log(`
--- email to ${email.to}
Subject: ${email.subject}
${email.text}
---
`);
  }
}

/** Collects emails instead of sending them: for tests and `npm run recheck -- --print-email`. */
export class MemoryMailer implements Mailer {
  sent: Email[] = [];
  async send(email: Email) {
    this.sent.push(email);
  }
}
