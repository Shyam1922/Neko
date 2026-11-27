// One small interface over two Postgres engines:
//   - real Postgres (node-postgres) when DATABASE_URL is set: Docker, Render, Railway, ...
//   - PGlite (Postgres compiled to WebAssembly, in-process) otherwise: local dev and tests need no server.
// Both speak the same SQL, so the stores above never know which one they are talking to.

import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import pg from "pg";
import { MIGRATIONS } from "./schema.ts";

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Runs fn in one transaction: all of it commits, or none of it does. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite";
}

class PgliteDb implements Db {
  readonly kind = "pglite";
  constructor(private lite: PGlite) {}
  query<T>(sql: string, params: unknown[] = []) {
    return this.lite.query<T>(sql, params);
  }
  // PGlite is a single connection; its transaction() holds a lock, so transactions never interleave.
  tx<T>(fn: (q: Queryable) => Promise<T>) {
    return this.lite.transaction((t) => fn({ query: <R>(sql: string, params: unknown[] = []) => t.query<R>(sql, params) }));
  }
  close() {
    return this.lite.close();
  }
}

class PostgresDb implements Db {
  readonly kind = "postgres";
  constructor(private pool: pg.Pool) {}
  query<T>(sql: string, params: unknown[] = []) {
    return this.pool.query(sql, params) as unknown as Promise<{ rows: T[] }>;
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn({ query: (sql, params = []) => client.query(sql, params) as any });
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  close() {
    return this.pool.end();
  }
}

/**
 * Applies every migration not yet recorded in schema_migrations, in order. One transaction (Postgres DDL is
 * transactional) under an advisory lock, so two app instances starting at once cannot both apply a migration.
 */
export async function migrate(db: Db): Promise<void> {
  await db.tx(async (q) => {
    await q.query("SELECT pg_advisory_xact_lock(7262356)"); // any constant; "neko" on a phone keypad
    await q.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await q.query<{ version: number }>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => Number(r.version)));
    for (const [i, sql] of MIGRATIONS.entries()) {
      const version = i + 1;
      if (done.has(version)) continue;
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await q.query(stmt);
      await q.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    }
  });
}

/**
 * Opens the database and brings its schema up to date.
 * databaseUrl → real Postgres. Otherwise PGlite: stored in dataDir, or in memory when dataDir is omitted (tests).
 */
export async function openDb(opts: { databaseUrl?: string; dataDir?: string } = {}): Promise<Db> {
  let db: Db;
  if (opts.databaseUrl) {
    const ssl = /sslmode=(require|verify)/.test(opts.databaseUrl) ? { rejectUnauthorized: false } : undefined;
    db = new PostgresDb(new pg.Pool({ connectionString: opts.databaseUrl, ssl, max: 10 }));
  } else {
    if (opts.dataDir) await mkdir(opts.dataDir, { recursive: true });
    db = new PgliteDb(await PGlite.create(opts.dataDir, { extensions: { vector } })); // pgvector, as on the server
  }
  await migrate(db);
  return db;
}
