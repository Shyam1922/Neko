// Deterministic date resolution. The model never does date arithmetic: code turns a
// phrase like "last Tuesday" into ranked candidate days, and the clock is injectable
// so tests can pin "today". A "day" always means a calendar day in the given timezone.

export const DEFAULT_TZ = "Asia/Kolkata";

export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== "string" || !tz) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

// from/to are inclusive civil dates (YYYY-MM-DD). A single day has from === to.
export interface DayCandidate {
  from: string;
  to: string;
  label: string; // human text for the "Taking that as ..." line
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (isoDate: string, n: number) => iso(new Date(parse(isoDate).getTime() + n * 86_400_000));

/** The calendar day an instant falls on in a timezone, e.g. "2026-11-12". */
export function dayOf(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: safeTimeZone(tz), year: "numeric", month: "2-digit", day: "2-digit" }).format(
    typeof at === "string" ? new Date(at) : at,
  );
}

function dayLabel(isoDate: string): string {
  const d = parse(isoDate);
  return `${DAY_ABBR[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]}`;
}

const single = (isoDate: string): DayCandidate => ({ from: isoDate, to: isoDate, label: dayLabel(isoDate) });

/** Past occurrences of a weekday, strictly before today, most recent first. */
function pastWeekdays(today: string, weekday: number, count: number): DayCandidate[] {
  const out: DayCandidate[] = [];
  let cursor = addDays(today, -1);
  while (out.length < count) {
    if (parse(cursor).getUTCDay() === weekday) out.push(single(cursor));
    cursor = addDays(cursor, -1);
  }
  return out;
}

function monthIndex(word: string): number {
  if (word.length < 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(word)); // "nov", "sept", "november"
}

/**
 * Turns a time phrase into ranked candidate days (best guess first), or [] if the
 * phrase is not understood. Never returns a single forced guess when it is ambiguous:
 * "last Tuesday" gives the two most recent past Tuesdays so retrieval can try both.
 */
export function resolveTimePhrase(phrase: string, now: Date, tz: string): DayCandidate[] {
  const today = dayOf(now, tz);
  const text = phrase.toLowerCase().trim().replace(/[.,]/g, "").replace(/\s+/g, " ");

  if (/^(today|earlier|earlier today|this (morning|afternoon|evening)|tonight)$/.test(text)) return [single(today)];
  if (text === "yesterday") return [single(addDays(today, -1))];

  const ago = text.match(/^(\d{1,3}) days? ago$/);
  if (ago) return [single(addDays(today, -Number(ago[1])))];

  if (text === "last week") {
    const dow = parse(today).getUTCDay(); // 0 = Sunday
    const thisMonday = addDays(today, -((dow + 6) % 7));
    const from = addDays(thisMonday, -7);
    const to = addDays(thisMonday, -1);
    return [{ from, to, label: `${dayLabel(from)} to ${dayLabel(to)}` }];
  }

  const wd = text.match(/^(?:on |last |on last )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (wd) return pastWeekdays(today, WEEKDAYS.indexOf(wd[1]), 2);

  const dm = text.match(/^(?:on )?(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]+)$/) ?? undefined;
  const md = text.match(/^(?:on )?([a-z]+) (\d{1,2})(?:st|nd|rd|th)?$/) ?? undefined;
  const parts = dm ? { day: Number(dm[1]), word: dm[2] } : md ? { day: Number(md[2]), word: md[1] } : undefined;
  if (parts) {
    const month = monthIndex(parts.word);
    if (month < 0) return [];
    const [ty] = today.split("-").map(Number);
    for (const year of [ty, ty - 1]) {
      const d = new Date(Date.UTC(year, month, parts.day));
      if (d.getUTCMonth() !== month) continue; // e.g. 31 November does not exist
      if (iso(d) <= today) return [single(iso(d))]; // latest occurrence that is not in the future
    }
  }
  return [];
}
