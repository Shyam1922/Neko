// One database per test file, migrated once. Each test makes its own user, so tests never see each
// other's rows: the same isolation that keeps real users apart.
//
// By default that is an in-memory PGlite. Set TEST_DATABASE_URL to run the same tests against a real
// Postgres server instead (rows are left behind, under throwaway users, so use a scratch database).

import type { Db } from "../src/db/db.ts";
import { openDb } from "../src/db/db.ts";
import { createUser } from "../src/memory/users.ts";
import { after } from "node:test";

let shared: Promise<Db> | undefined;
export const testDb = () => {
  const url = process.env.TEST_DATABASE_URL?.trim();
  return (shared ??= openDb(url ? { databaseUrl: url } : {}));
};
// Registered at load time, so it runs once after the whole file (a pg pool would otherwise keep it alive).
after(async () => (shared ? (await shared).close() : undefined));
export const newUser = async () => createUser(await testDb());
