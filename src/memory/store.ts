import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeTimeZone } from "./dates.ts";

export interface SearchLog {
  query: string;
  urls: string[];
  retrievedAt: string;
  error?: string; // set when the search failed; such a turn did NOT verify anything
}

// What the agent used from memory to write an answer, so a later "that's wrong" knows
// which conversation to exclude and which question to retry.
export interface RecallMeta {
  ids: string[];
  phrase?: string;
  topic?: string;
  route: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string; // UTC ISO, set by the server, never by the client
  tz: string; // timezone the user was in when it was sent
  searches: SearchLog[];
  recall?: RecallMeta;
}

// A fact an earlier answer asserted. Always tied to a message and a verbatim quote.
export interface Claim {
  id: string;
  messageId: string;
  entity: string; // "HubSpot Sales Hub"
  attribute: string; // "price per seat"
  valueText: string; // "$90"
  amount?: number; // 90
  unit?: string; // "USD/seat/month"
  qualifiers: { plan?: string; seats?: string; billing?: string };
  quote: string; // exact words from the message (verified by code)
  assertedAt: string;
  provenance: "searched" | "model_knowledge"; // from our search log, never from the model
  perishability: "volatile" | "stable";
  sources: string[];
}

export interface Conversation {
  id: string;
  startedAt: string;
  lastAt: string;
  title: string;
  messages: Message[];
  claims?: Claim[]; // extracted on demand, once
  rejected?: string[]; // past conversations the user said were the wrong ones
}

export type ConversationSummary = Omit<Conversation, "messages"> & { messageCount: number };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const isValidId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

export class JsonStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private dir: string, private now: () => Date = () => new Date()) {}

  // Writes are serialized so two quick messages cannot clobber each other.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private file(id: string) {
    if (!isValidId(id)) throw new Error("Invalid conversation id");
    return path.join(this.dir, `${id}.json`);
  }

  private async write(c: Conversation) {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(c.id);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(c, null, 2));
    await rename(tmp, target); // atomic: readers never see half a file
  }

  async get(id: string): Promise<Conversation | null> {
    if (!isValidId(id)) return null;
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as Conversation;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async list(): Promise<ConversationSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    const out: ConversationSummary[] = [];
    for (const n of names.filter((n) => n.endsWith(".json"))) {
      const c = await this.get(n.slice(0, -5));
      if (c) {
        const { messages, ...rest } = c;
        out.push({ ...rest, messageCount: messages.length });
      }
    }
    return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  // Updates derived fields (claims, rejected) without touching messages.
  patch(id: string, fields: Partial<Pick<Conversation, "claims" | "rejected">>): Promise<void> {
    return this.serial(async () => {
      const conv = await this.get(id);
      if (!conv) throw new Error("Conversation not found");
      await this.write({ ...conv, ...fields });
    });
  }

  // Every stored conversation in full; the corpus is small enough to scan.
  async getAll(): Promise<Conversation[]> {
    const all = await Promise.all((await this.list()).map((s) => this.get(s.id)));
    return all.filter((c): c is Conversation => c !== null);
  }

  // Appends a message, creating the conversation when conversationId is undefined.
  append(
    conversationId: string | undefined,
    m: { role: Message["role"]; text: string; tz?: string; searches?: SearchLog[]; recall?: RecallMeta },
  ): Promise<{ conversation: Conversation; message: Message }> {
    return this.serial(async () => {
      const at = this.now().toISOString();
      let conv = conversationId ? await this.get(conversationId) : null;
      if (conversationId && !conv) throw new Error("Conversation not found");
      if (!conv) {
        conv = {
          id: randomUUID(),
          startedAt: at,
          lastAt: at,
          title: m.text.replace(/\s+/g, " ").trim().slice(0, 60),
          messages: [],
        };
      }
      const message: Message = {
        id: randomUUID(),
        role: m.role,
        text: m.text,
        at,
        tz: safeTimeZone(m.tz),
        searches: m.searches ?? [],
        ...(m.recall ? { recall: m.recall } : {}),
      };
      conv.messages.push(message);
      conv.lastAt = at;
      await this.write(conv);
      return { conversation: conv, message };
    });
  }
}
