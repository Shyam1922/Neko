// Anonymous users. A visitor gets a random id (kept in a cookie by the HTTP layer); every conversation
// and profile fact hangs off it, so two people using the same server never see each other's memory.

import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.ts";

export async function createUser(db: Db): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO users (id) VALUES ($1)", [id]);
  return id;
}

/** True if the id belongs to a user; also records that they were seen. */
export async function touchUser(db: Db, id: string): Promise<boolean> {
  const { rows } = await db.query("UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}
