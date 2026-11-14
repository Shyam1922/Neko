import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { isModelNotFound, parseRateLimit, RateLimitError, retryDelayMs } from "./errors.ts";
import { withTimeout } from "./timeout.ts";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  raw?: unknown; // provider's original part; Gemini 3 needs it echoed back (thought signature)
}

// One entry of the conversation as the model sees it.
export type Turn =
  | { role: "user" | "model"; text: string }
  | { role: "tool_call"; call: ToolCall } // the model asked for a tool
  | { role: "tool_result"; name: string; result: unknown }; // what the tool returned

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface StreamRequest {
  system: string;
  history: Turn[];
  tools?: ToolSpec[]; // omit to forbid tool use
  signal?: AbortSignal;
}

export type LlmEvent = { type: "text"; text: string } | { type: "tool_call"; call: ToolCall };

// The only thing the rest of the app knows about the model. Swap providers by
// writing another class that implements this.
export interface JsonRequest {
  system: string;
  prompt: string;
  schema: Record<string, unknown>; // JSON schema the reply must follow
  signal?: AbortSignal;
}

export interface Llm {
  stream(req: StreamRequest): AsyncIterable<LlmEvent>;
  // One-shot structured output. Returns parsed JSON; callers must still validate it.
  generateJson(req: JsonRequest): Promise<unknown>;
}

const FIRST_TOKEN_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * When the configured model doesn't exist for this key, choose another one the key can use:
 * the newest "flash-lite" (fast and cheap on a free tier), else the newest "flash". Text models only.
 */
export function pickFallbackModel(models: { name: string; supportedActions?: string[] }[], failed: string): string | null {
  const notText = /image|tts|audio|live|embed|robotic|computer|nano|banana|omni|deep|antigravity|argon|carbon|hydrogen|gemma|imagen|veo/i;
  const version = (id: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  const bare = (n: string) => n.replace(/^models\//, "");
  const candidates = models
    .map((m) => ({ id: bare(m.name), actions: m.supportedActions ?? [] }))
    .filter((m) => m.actions.includes("generateContent") && /^gemini-.*flash/.test(m.id) && !notText.test(m.id) && m.id !== bare(failed));
  candidates.sort((a, b) => Number(/flash-lite/.test(b.id)) - Number(/flash-lite/.test(a.id)) || version(b.id) - version(a.id));
  return candidates[0]?.id ?? null;
}

// Out of retries: rate limits become a readable RateLimitError; other errors pass through.
function explain(err: unknown): unknown {
  const rl = parseRateLimit(err);
  return rl ? new RateLimitError(rl) : err;
}

// Gemini wants parallel tool calls in ONE model turn and their results in ONE user turn,
// so neighbouring entries with the same role are merged into a single Content.
export function toContents(history: Turn[]): Content[] {
  const out: Content[] = [];
  for (const t of history) {
    let role: "user" | "model";
    let part: Part;
    if (t.role === "tool_call") {
      role = "model";
      part = (t.call.raw as Part | undefined) ?? { functionCall: { name: t.call.name, args: t.call.args } };
    } else if (t.role === "tool_result") {
      role = "user";
      part = { functionResponse: { name: t.name, response: { result: t.result } } };
    } else {
      role = t.role;
      part = { text: t.text };
    }
    const last = out[out.length - 1];
    if (last?.role === role) last.parts!.push(part);
    else out.push({ role, parts: [part] });
  }
  return out;
}

export class GeminiLlm implements Llm {
  private ai: GoogleGenAI;
  private triedFallback = false;
  constructor(apiKey: string, private model: string, private firstTokenTimeoutMs = FIRST_TOKEN_TIMEOUT_MS) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  // First 404 "model not found": look at what this key can use and switch, once, loudly.
  private async switchModel(): Promise<boolean> {
    if (this.triedFallback) return false;
    this.triedFallback = true;
    const models: { name: string; supportedActions?: string[] }[] = [];
    for await (const m of await this.ai.models.list()) models.push({ name: m.name ?? "", supportedActions: m.supportedActions });
    const next = pickFallbackModel(models, this.model);
    if (!next) return false;
    console.warn(`[llm] model "${this.model}" is not available for this key; using "${next}". Set GEMINI_MODEL to choose one (npm run check:models lists them).`);
    this.model = next;
    return true;
  }

  async *stream(req: StreamRequest): AsyncIterable<LlmEvent> {
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const ev of this.once(req)) {
          yielded = true;
          yield ev;
        }
        return;
      } catch (err) {
        if (!yielded && isModelNotFound(err) && (await this.switchModel())) {
          attempt--; // switching models doesn't use up a retry
          continue;
        }
        // Only retry if nothing reached the caller yet and the wait is short.
        const waitMs = retryDelayMs(err, attempt);
        if (waitMs === null) throw err;
        if (yielded || attempt >= MAX_RETRIES || waitMs > MAX_RETRY_WAIT_MS) throw explain(err);
        await sleep(waitMs);
      }
    }
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await withTimeout(
          this.ai.models.generateContent({
            model: this.model,
            contents: [{ role: "user", parts: [{ text: req.prompt }] }],
            config: {
              systemInstruction: req.system,
              abortSignal: req.signal,
              responseMimeType: "application/json",
              responseJsonSchema: req.schema,
            },
          }),
          this.firstTokenTimeoutMs,
          "the model's structured reply",
        );
        return JSON.parse(res.text ?? "");
      } catch (err) {
        if (isModelNotFound(err) && (await this.switchModel())) {
          attempt--;
          continue;
        }
        const waitMs = retryDelayMs(err, attempt);
        if (waitMs === null) throw err;
        if (attempt >= MAX_RETRIES || waitMs > MAX_RETRY_WAIT_MS) throw explain(err);
        await sleep(waitMs);
      }
    }
  }

  private async *once(req: StreamRequest): AsyncIterable<LlmEvent> {
    const stream = await withTimeout(
      this.ai.models.generateContentStream({
        model: this.model,
        contents: toContents(req.history),
        config: {
          systemInstruction: req.system,
          abortSignal: req.signal,
          tools: req.tools?.length
            ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }]
            : undefined,
        },
      }),
      this.firstTokenTimeoutMs,
      "the model to start responding",
    );
    const it = stream[Symbol.asyncIterator]();
    let first = true;
    while (true) {
      const ms = first ? this.firstTokenTimeoutMs : IDLE_TIMEOUT_MS;
      const next = await withTimeout(it.next(), ms, first ? "the first token" : "the next token");
      if (next.done) return;
      first = false;
      for (const part of next.value.candidates?.[0]?.content?.parts ?? []) {
        if (part.functionCall?.name) {
          yield { type: "tool_call", call: { name: part.functionCall.name, args: part.functionCall.args ?? {}, raw: part } };
        } else if (part.text && !part.thought) {
          yield { type: "text", text: part.text };
        }
      }
    }
  }
}
