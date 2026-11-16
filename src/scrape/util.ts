const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", pound: "£", eacute: "é", egrave: "è",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Visible text of an HTML fragment, with whitespace collapsed. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** 1-12 for "Nov" or "November", otherwise null. */
export function monthNumber(name: string): number | null {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
}

/** 0 (Monday) to 6 (Sunday) for "Tue" or "Tuesday", otherwise null. */
export function weekdayNumber(name: string): number | null {
  const i = DAYS.indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? null : i;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD, or null if the day does not exist (31 Feb). */
export function ymd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const toUtc = (date: string) => new Date(`${date}T00:00:00Z`);

export function addDays(date: string, n: number): string {
  const dt = toUtc(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** 0 (Monday) to 6 (Sunday). */
export function weekdayOf(date: string): number {
  return (toUtc(date).getUTCDay() + 6) % 7;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

/** Every date from start to end inclusive, capped so a bad range cannot run away. */
export function eachDate(start: string, end: string, cap = 400): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < cap; d = addDays(d, 1)) out.push(d);
  return out;
}

const londonFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** UK local date and time for an instant. */
export function londonParts(instant: Date): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of londonFormat.formatToParts(instant)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function londonToday(now: Date): string {
  return londonParts(now).date;
}

export function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(decodeEntities(href), base).toString();
  } catch {
    return href;
  }
}
