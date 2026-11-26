// One JSON object per line: hosting platforms (Render, Railway, Fly) index fields from it, and
// `grep '"event":"turn"'` still works locally.
//
// Never log a raw user id: it is the value of the login cookie, so anyone reading logs could act as that
// user. Log userTag() instead, a short one-way hash that still groups one person's turns together.

import { createHash } from "node:crypto";

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

export const userTag = (userId: string) => createHash("sha256").update(userId).digest("hex").slice(0, 10);
