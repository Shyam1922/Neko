// Per-user settings and the optional email, for one anonymous account.
//
// Email is earned, not demanded: nobody needs one to use Neko. A user who watches a fact may ask to be
// emailed when it changes; we send a magic link, and only when they open it from the same browser is the
// address stored on their account. Opening a link for an address that already belongs to an account signs
// this browser in to that account instead, which is how the same watches are reached from another device.
//
// Tokens: 32 random bytes, sent only in the email; the database keeps a SHA-256 hash. Single use, 30 minutes.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/db.ts";

export const TOKEN_TTL_MS = 30 * 60_000;
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const isEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s.trim());

export interface Account {
  memoryOn: boolean;
  email: string | null;
  emailNotify: boolean;
}

export async function getAccount(db: Db, userId: string): Promise<Account> {
  const { rows } = await db.query("SELECT memory_on, email, email_notify FROM users WHERE id = $1", [userId]);
  const r = rows[0];
  return { memoryOn: r ? r.memory_on !== false : true, email: r?.email ?? null, emailNotify: Boolean(r?.email && r.email_notify) };
}

export async function setMemory(db: Db, userId: string, on: boolean): Promise<void> {
  await db.query("UPDATE users SET memory_on = $2 WHERE id = $1", [userId, on]);
}

export async function setEmailNotify(db: Db, userId: string, on: boolean): Promise<void> {
  await db.query("UPDATE users SET email_notify = $2 WHERE id = $1 AND email IS NOT NULL", [userId, on]);
}

/** Starts confirming an address: returns the raw token to put in the link. Nothing is stored on the user yet. */
export async function startEmail(db: Db, userId: string, email: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    "INSERT INTO email_tokens (token_hash, user_id, email, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [hashToken(token), userId, email.trim(), now.toISOString(), new Date(now.getTime() + TOKEN_TTL_MS).toISOString()],
  );
  return token;
}

export type ConfirmResult =
  | { ok: true; userId: string; email: string; signedIn: boolean } // signedIn: this browser now uses an existing account
  | { ok: false; reason: "invalid" | "used" | "expired" | "other_browser" };

/**
 * Uses a token once. `browserUserId` is the account in the cookie of the browser that opened the link.
 *  - The address already belongs to another account: sign this browser in to that account.
 *  - Otherwise the address is attached to the account that asked, but only if that same browser opened the link.
 *    (Otherwise someone could send you a link that quietly ties your address to *their* account.)
 */
export async function confirmEmail(db: Db, token: string, browserUserId: string | null, now: Date): Promise<ConfirmResult> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return { ok: false, reason: "invalid" };
  return db.tx(async (q) => {
    const { rows } = await q.query("SELECT user_id, email, expires_at, used_at FROM email_tokens WHERE token_hash = $1 FOR UPDATE", [hashToken(token)]);
    const t = rows[0];
    if (!t) return { ok: false, reason: "invalid" };
    if (t.used_at) return { ok: false, reason: "used" };
    if (new Date(t.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };

    const owner = await q.query("SELECT id FROM users WHERE lower(email) = lower($1)", [t.email]);
    const ownerId: string | undefined = owner.rows[0]?.id;
    if (ownerId && ownerId !== t.user_id) {
      await q.query("UPDATE email_tokens SET used_at = $2 WHERE token_hash = $1", [hashToken(token), now.toISOString()]);
      return { ok: true, userId: ownerId, email: t.email, signedIn: true };
    }
    if (browserUserId !== t.user_id) return { ok: false, reason: "other_browser" }; // not used up: the right browser can still open it
    await q.query(
      "UPDATE users SET email = $2, email_notify = true, unsubscribe_token = coalesce(unsubscribe_token, $3) WHERE id = $1",
      [t.user_id, t.email, randomBytes(24).toString("base64url")],
    );
    await q.query("UPDATE email_tokens SET used_at = $2 WHERE token_hash = $1", [hashToken(token), now.toISOString()]);
    return { ok: true, userId: t.user_id, email: t.email, signedIn: false };
  });
}

/** Removes the address and any pending links. Used by "Remove email" and by "Forget everything". */
export async function removeEmail(db: Db, userId: string): Promise<void> {
  await db.query("UPDATE users SET email = NULL, email_notify = false, unsubscribe_token = NULL WHERE id = $1", [userId]);
  await db.query("DELETE FROM email_tokens WHERE user_id = $1", [userId]);
}

/** One-click unsubscribe from the link in an email: stops change emails, keeps the address for signing in. */
export async function unsubscribe(db: Db, token: string): Promise<boolean> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return false;
  const { rows } = await db.query("UPDATE users SET email_notify = false WHERE unsubscribe_token = $1 RETURNING id", [token]);
  return rows.length > 0;
}

/** Where to send change emails for a user, or null when they have no address or turned emails off. */
export async function notifyTarget(db: Db, userId: string): Promise<{ email: string; unsubscribeToken: string } | null> {
  const { rows } = await db.query("SELECT email, email_notify, unsubscribe_token FROM users WHERE id = $1", [userId]);
  const r = rows[0];
  return r?.email && r.email_notify && r.unsubscribe_token ? { email: r.email, unsubscribeToken: r.unsubscribe_token } : null;
}
