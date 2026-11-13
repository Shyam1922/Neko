// Google hides the useful part of a 429 inside a JSON string in the error message.
// This pulls out which limit was hit, for which model, and how long to wait,
// so the user sees a real reason instead of "rate limited".

export interface RateLimitInfo {
  limit?: string; // e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
  model?: string;
  retryDelaySec?: number;
  message: string;
}

export class RateLimitError extends Error {
  constructor(public readonly info: RateLimitInfo) {
    super(describeRateLimit(info));
    this.name = "RateLimitError";
  }
}

function tryParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseRateLimit(err: unknown): RateLimitInfo | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: number; code?: number; message?: string };
  const message = String(e.message ?? "");
  const is429 = e.status === 429 || e.code === 429 || /RESOURCE_EXHAUSTED|\b429\b/.test(message);
  if (!is429) return null;

  const info: RateLimitInfo = { message };
  const body = tryParse(message);
  const details: any[] = body?.error?.details ?? [];
  for (const d of details) {
    if (typeof d?.retryDelay === "string") {
      const secs = parseFloat(d.retryDelay);
      if (!Number.isNaN(secs)) info.retryDelaySec = secs;
    }
    const violation = d?.violations?.[0];
    if (violation) {
      info.limit = violation.quotaId ?? violation.quotaMetric ?? info.limit;
      info.model = violation.quotaDimensions?.model ?? info.model;
    }
  }
  if (info.retryDelaySec === undefined) {
    const m = message.match(/retry in ([\d.]+)s/i);
    if (m) info.retryDelaySec = parseFloat(m[1]);
  }
  return info;
}

/** The configured model doesn't exist for this key (a retired name, or one the key can't use). */
export function isModelNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: number; code?: number; message?: string };
  return e.status === 404 || e.code === 404 || /NOT_FOUND|is not found|no longer available/i.test(String(e.message ?? ""));
}

/** Google's temporary "high demand" errors (HTTP 503 / UNAVAILABLE). Worth a short retry. */
export function isOverloaded(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: number; code?: number; message?: string };
  const message = String(e.message ?? "");
  return e.status === 503 || e.code === 503 || /UNAVAILABLE|high demand/i.test(message);
}

/** How long to wait before retrying this error, or null if it should not be retried. */
export function retryDelayMs(err: unknown, attempt: number): number | null {
  const rl = parseRateLimit(err);
  if (rl) return (rl.retryDelaySec ?? 5) * 1000 + 250 * (attempt + 1);
  if (isOverloaded(err)) return 2000 * (attempt + 1);
  return null;
}

/** What the user sees when a model call fails: the reason in words, not Google's raw JSON. */
export function friendlyMessage(err: unknown): string {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "Something went wrong.");
  const body = tryParse(msg);
  const details: any[] = body?.error?.details ?? [];
  if (details.some((d) => d?.reason === "API_KEY_INVALID")) {
    return "Google rejected the API key. Check GEMINI_API_KEY in .env, then restart the server.";
  }
  return typeof body?.error?.message === "string" ? body.error.message : msg;
}

export function describeRateLimit(info: RateLimitInfo): string {
  const parts = ["The model's rate limit was hit"];
  if (info.model) parts.push(`for ${info.model}`);
  if (info.limit) parts.push(`(${info.limit})`);
  let text = parts.join(" ") + ".";
  if (info.retryDelaySec !== undefined) text += ` Google says to retry in about ${Math.ceil(info.retryDelaySec)}s.`;
  if (/PerDay|limit['"]?:?\s*0\b/.test(`${info.limit ?? ""} ${info.message}`)) {
    text += " This may be a daily quota, or a model with no free quota on your key; check your limits at ai.dev/rate-limit.";
  }
  return text;
}
