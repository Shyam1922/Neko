// What Neko knows about the user: facts they stated themselves ("I prefer short answers").
// Stored apart from conversations, in <data>/profile/facts.json, so the user can see, edit and
// delete every fact. One fact per key: a newer statement replaces the older one.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProfileFact {
  id: string;
  key: string; // snake_case label: "name", "team_size", "currency", ...
  value: string;
  quote: string; // the user's exact words that stated it
  conversationId: string;
  messageId: string;
  statedAt: string;
  updatedAt: string;
}

export const MAX_FACTS = 40;

export class ProfileStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private dir: string, private now: () => Date = () => new Date()) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private file() {
    // A subfolder, so the conversation store (which scans data/*.json) never mistakes it for a chat.
    return path.join(this.dir, "profile", "facts.json");
  }

  private async read(): Promise<ProfileFact[]> {
    try {
      const facts = JSON.parse(await readFile(this.file(), "utf8"));
      return Array.isArray(facts) ? facts : [];
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
  }

  private async write(facts: ProfileFact[]) {
    await mkdir(path.dirname(this.file()), { recursive: true });
    const tmp = `${this.file()}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(facts, null, 2));
    await rename(tmp, this.file()); // atomic
  }

  list(): Promise<ProfileFact[]> {
    return this.serial(() => this.read());
  }

  /** Saves a fact, replacing any earlier one with the same key. Returns null if the profile is full. */
  upsert(
    c: { key: string; value: string; quote: string },
    source: { conversationId: string; messageId: string },
  ): Promise<{ fact: ProfileFact; previous?: string } | null> {
    return this.serial(async () => {
      const facts = await this.read();
      const at = this.now().toISOString();
      const i = facts.findIndex((f) => f.key === c.key);
      if (i === -1 && facts.length >= MAX_FACTS) return null;
      const fact: ProfileFact = {
        id: i === -1 ? randomUUID() : facts[i].id,
        key: c.key,
        value: c.value,
        quote: c.quote,
        ...source,
        statedAt: i === -1 ? at : facts[i].statedAt,
        updatedAt: at,
      };
      const previous = i === -1 ? undefined : facts[i].value;
      if (i === -1) facts.push(fact);
      else facts[i] = fact;
      await this.write(facts);
      return { fact, previous };
    });
  }

  /** The user edits a value by hand in the panel. */
  update(id: string, value: string): Promise<ProfileFact | null> {
    return this.serial(async () => {
      const facts = await this.read();
      const f = facts.find((x) => x.id === id);
      if (!f) return null;
      f.value = value;
      f.updatedAt = this.now().toISOString();
      await this.write(facts);
      return f;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const facts = await this.read();
      const next = facts.filter((f) => f.id !== id);
      if (next.length === facts.length) return false;
      await this.write(next);
      return true;
    });
  }

  clear(): Promise<void> {
    return this.serial(() => this.write([]));
  }
}
