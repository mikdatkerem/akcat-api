import type { ReportQuery } from "./schemas";
const zone = "Europe/Istanbul" as const;
const local = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function parts(date: Date) { return Object.fromEntries(local.formatToParts(date).map(part => [part.type, part.value])); }
function dateOnly(date: Date) { const p = parts(date); return `${p.year}-${p.month}-${p.day}`; }
function shift(day: string, amount: number) { const date = new Date(day + "T00:00:00.000Z"); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); }
// Resolve local midnight through the actual IANA zone, including historical offset changes.
function midnight(day: string) {
  const expected = Date.parse(day + "T00:00:00.000Z"); let candidate = expected;
  for (let i = 0; i < 4; i++) {
    const p = parts(new Date(candidate));
    const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`);
    const next = candidate + expected - shown;
    if (candidate === next) break;
    candidate = next;
  }
  return new Date(candidate).toISOString();
}
export function reportRange(query: ReportQuery, now = new Date()) {
  const today = dateOnly(now);
  const start = query.period === "custom" ? query.from! : query.period === "yesterday" ? shift(today, -1)
    : query.period === "last7" ? shift(today, -6) : query.period === "month" ? today.slice(0, 7) + "-01" : today;
  const end = query.period === "custom" ? query.to! : query.period === "yesterday" ? shift(today, -1) : today;
  return { period: query.period, start_date: start, end_date: end, from: midnight(start), to: midnight(shift(end, 1)), time_zone: zone, generated_at: now.toISOString() };
}
export type ReportRange = ReturnType<typeof reportRange>;
