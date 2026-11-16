// Regent Theatre and Victoria Hall, both run by ATG and sharing one website.
//
// Listing pages (/venues/<venue>/whats-on/?page=N) are server-rendered. Each page carries the show
// cards twice: as HTML, and as JSON inside the Next.js page data together with the venue's total
// show count. We read the JSON because it has clean fields, and fall back to the HTML cards.
//
// Individual show pages are filled in by JavaScript from a JSON feed (boltapi.atgtickets.com), which
// gives the first performance time, the weekly pattern of show times, and on-sale dates. It does not
// give a list of every performance, so multi-night runs are worked out from the weekly pattern.

import type { PageFetcher, ListedShow, ListingResult, Performance, ShowDetail, ShowStatus, SourceId } from "../types";
import { absoluteUrl, eachDate, londonParts, monthNumber, textOf, weekdayNumber, weekdayOf, ymd } from "./util";

const SITE = "https://www.atgtickets.com";
const DETAIL_API = "https://boltapi.atgtickets.com/shows/";
const MAX_PAGES = 20;

export const ATG_VENUES: Record<"regent" | "victoria-hall", { slug: string; name: string }> = {
  regent: { slug: "regent-theatre", name: "Regent Theatre" },
  "victoria-hall": { slug: "victoria-hall", name: "Victoria Hall" },
};

// ---------- dates ----------

/** "Mon 30 Nov 2026", "Tue 17 Nov - Sat 21 Nov 2026", "Fri 11 Dec 2026 - Sun 3 Jan 2027". */
export function parseAtgDates(text: string): { start: string; end: string } | null {
  const parts = text.split(/\s+[-–]\s+/).map((p) => /(\d{1,2})\s+([A-Za-z]{3,})(?:\s+(\d{4}))?/.exec(p));
  const last = parts[parts.length - 1];
  const first = parts[0];
  if (!first || !last || parts.length > 2) return null;

  const endMonth = monthNumber(last[2]!);
  const endYear = last[3] ? Number(last[3]) : NaN;
  if (!endMonth || !Number.isFinite(endYear)) return null;
  const end = ymd(endYear, endMonth, Number(last[1]));
  if (!end) return null;
  if (parts.length === 1) return { start: end, end };

  const startMonth = monthNumber(first[2]!);
  if (!startMonth) return null;
  // A start with no year is in the end year, unless the run crosses New Year.
  const startYear = first[3] ? Number(first[3]) : startMonth > endMonth ? endYear - 1 : endYear;
  const start = ymd(startYear, startMonth, Number(first[1]));
  return start && start <= end ? { start, end } : null;
}

// ---------- listing ----------

interface AtgCard {
  id?: unknown;
  title?: unknown;
  dates?: unknown;
  genre?: unknown;
  venueInfo?: unknown;
  infoBarText?: unknown;
  moreInfo?: { url?: unknown } | string | null;
  buyTickets?: { url?: unknown } | string | null;
  titleImage?: { images?: Record<string, { "1x"?: unknown }> } | string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" && !v.startsWith("$") ? v : null);

function linkUrl(v: AtgCard["moreInfo"]): string | null {
  return v && typeof v === "object" ? str(v.url) : null;
}

/** Pull `"found":N,"cards":[...]` out of the Next.js page data embedded in the HTML. */
export function extractAtgCards(html: string): { found: number | null; cards: AtgCard[] } | null {
  let data = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      data += JSON.parse(m[1]!) as string;
    } catch {
      // A chunk we cannot decode is skipped; the cards chunk is checked below.
    }
  }
  const key = data.indexOf('"cards":[');
  if (key < 0) return null;

  const start = key + '"cards":'.length;
  let depth = 0;
  let inString = false;
  let end = -1;
  for (let i = start; i < data.length; i++) {
    const ch = data[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;

  let cards: unknown;
  try {
    cards = JSON.parse(data.slice(start, end));
  } catch {
    return null;
  }
  if (!Array.isArray(cards)) return null;

  const near = data.slice(Math.max(0, key - 200), key + 20);
  const found = /"found":(\d+)/.exec(near) ?? /"found":(\d+)/.exec(data);
  return { found: found ? Number(found[1]) : null, cards: cards as AtgCard[] };
}

function statusFrom(infoBar: string | null, hasBuyLink: boolean): { status: ShowStatus; statusText: string | null } {
  if (infoBar && /sold\s*out/i.test(infoBar)) return { status: "sold_out", statusText: infoBar };
  if (infoBar && /on\s*sale/i.test(infoBar)) return { status: "coming_soon", statusText: infoBar };
  if (hasBuyLink) return { status: "on_sale", statusText: infoBar };
  return { status: "unknown", statusText: infoBar };
}

function toShow(
  source: SourceId,
  f: { path: string; title: string; dates: string; venue: string | null; genre: string | null;
       infoBar: string | null; buyUrl: string | null; image: string | null },
): ListedShow | null {
  const m = /^\/shows\/([^/]+\/[^/]+)\/?$/.exec(f.path);
  if (!m || !f.title) return null;
  const range = parseAtgDates(f.dates);
  return {
    id: `atg:${m[1]}`,
    source,
    venue: f.venue ?? ATG_VENUES[source as "regent" | "victoria-hall"].name,
    title: f.title,
    url: `${SITE}/shows/${m[1]}/`,
    bookingUrl: f.buyUrl ? absoluteUrl(f.buyUrl, SITE) : null,
    image: f.image,
    genre: f.genre,
    summary: null,
    dateText: f.dates,
    startDate: range?.start ?? null,
    endDate: range?.end ?? null,
    ...statusFrom(f.infoBar, f.buyUrl !== null),
  };
}

function cardToShow(source: SourceId, card: AtgCard): ListedShow | null {
  const path = linkUrl(card.moreInfo);
  const title = str(card.title);
  if (!path || !title) return null;
  const images = card.titleImage && typeof card.titleImage === "object" ? card.titleImage.images : undefined;
  const image = images ? str((images["786"] ?? Object.values(images)[0])?.["1x"]) : null;
  const genre = Array.isArray(card.genre) ? card.genre.filter((g) => typeof g === "string").join(", ") : null;
  return toShow(source, {
    path, title, image,
    dates: str(card.dates) ?? "",
    venue: str(card.venueInfo),
    genre: genre || null,
    infoBar: str(card.infoBarText),
    buyUrl: linkUrl(card.buyTickets),
  });
}

/** Fallback: read the visible HTML cards. Used if the embedded page data changes shape. */
export function parseAtgCardsFromHtml(source: SourceId, html: string): ListedShow[] {
  const shows: ListedShow[] = [];
  for (const block of html.split('data-testid="showCard"').slice(1)) {
    const path = /href="(\/shows\/[^"/]+\/[^"/]+\/)"/.exec(block)?.[1];
    const title = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(block);
    if (!path || !title) continue;
    const paragraphs = [...block.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((m) => textOf(m[1]!)).filter(Boolean);
    const dateIndex = paragraphs.findIndex((p) => /\d{1,2}\s+[A-Za-z]{3}\s+\d{4}$/.test(p) && !/sale/i.test(p));
    const buy = /href="(\/shows\/[^"]+\/calendar\/)"/.exec(block)?.[1] ?? null;
    const show = toShow(source, {
      path,
      title: textOf(title[1]!),
      dates: dateIndex >= 0 ? paragraphs[dateIndex]! : "",
      venue: dateIndex >= 1 ? paragraphs[dateIndex - 1]! : null,
      genre: dateIndex >= 2 ? paragraphs.slice(0, dateIndex - 1).join(", ") : null,
      infoBar: paragraphs.find((p) => /^(sold\s*out|on\s*sale\b)/i.test(p)) ?? null,
      buyUrl: buy,
      image: /srcSet="(https:\/\/[^" ]+)/.exec(block)?.[1] ?? null,
    });
    if (show) shows.push(show);
  }
  return shows;
}

export function parseAtgListingPage(source: SourceId, html: string): { shows: ListedShow[]; found: number | null } {
  const data = extractAtgCards(html);
  if (data) {
    const shows = data.cards.map((c) => cardToShow(source, c)).filter((s): s is ListedShow => s !== null);
    if (shows.length > 0 || data.cards.length === 0) return { shows, found: data.found };
  }
  const found = /(\d+)\s+shows?\b/i.exec(textOf(html.replace(/<script[\s\S]*?<\/script>/g, "")));
  return { shows: parseAtgCardsFromHtml(source, html), found: found ? Number(found[1]) : null };
}

/** Walk every page of a venue's listing until all the shows the venue reports are collected. */
export async function listAtgVenue(source: "regent" | "victoria-hall", fetcher: PageFetcher): Promise<ListingResult> {
  const byId = new Map<string, ListedShow>();
  let reportedTotal: number | null = null;
  let pages = 0;
  let problem: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetcher(`${SITE}/venues/${ATG_VENUES[source].slug}/whats-on/?page=${page}`);
    if (!res.ok) {
      problem = `page ${page} returned HTTP ${res.status}`;
      break;
    }
    const { shows, found } = parseAtgListingPage(source, await res.text());
    pages = page;
    if (found !== null) reportedTotal = found;
    const before = byId.size;
    for (const s of shows) byId.set(s.id, s);
    // Stop on an empty page, a page with nothing new, or once we have everything the venue reports.
    if (shows.length === 0 || byId.size === before) break;
    if (reportedTotal !== null && byId.size >= reportedTotal) break;
  }

  if (!problem && reportedTotal === null) problem = "could not read the venue's total show count";
  if (!problem && byId.size !== reportedTotal) problem = `collected ${byId.size} shows but the venue reports ${reportedTotal}`;
  return { shows: [...byId.values()], complete: problem === null, pages, reportedTotal, problem };
}

// ---------- show details ----------

export interface ShowTimePattern {
  /** Weekdays this applies to, 0 = Monday. */
  days: number[];
  /** One-off dates this applies to, such as "Fri 31 Dec". */
  dates: { day: number; month: number }[];
  times: string[];
}

/**
 * Reads one line of a show's weekly pattern, for example:
 *   "Tue - Sat at 19:30", "Wed, Thu and Sat at 14:30", "Fri at 17:00 and 20:30", "Fri 31 Dec at 19:00"
 * Returns null for anything else, such as "Please check the calendar".
 */
export function parseShowTime(text: string): ShowTimePattern | null {
  const m = /^(.+?)\s+at\s+(\d{1,2}[:.]\d{2}(?:\s*(?:,|&|\band\b)\s*\d{1,2}[:.]\d{2})*)$/i.exec(text.trim());
  if (!m) return null;
  const times = [...m[2]!.matchAll(/(\d{1,2})[:.](\d{2})/g)].map((t) => `${t[1]!.padStart(2, "0")}:${t[2]}`);
  const days = new Set<number>();
  const dates: ShowTimePattern["dates"] = [];

  for (const token of m[1]!.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean)) {
    const range = /^([A-Za-z]+)\s*[-–]\s*([A-Za-z]+)$/.exec(token);
    const oneOff = /^(?:[A-Za-z]+\s+)?(\d{1,2})\s+([A-Za-z]{3,})$/.exec(token);
    if (range) {
      const a = weekdayNumber(range[1]!);
      const b = weekdayNumber(range[2]!);
      if (a === null || b === null) return null;
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === b) break;
      }
    } else if (oneOff) {
      const month = monthNumber(oneOff[2]!);
      if (!month) return null;
      dates.push({ day: Number(oneOff[1]), month });
    } else {
      const d = /^[A-Za-z]+$/.test(token) ? weekdayNumber(token) : null;
      if (d === null) return null;
      days.add(d);
    }
  }
  if (days.size === 0 && dates.length === 0) return null;
  return { days: [...days].sort(), dates, times };
}

/**
 * Work out the performances for an ATG show.
 *  - One date: a single performance, with the exact time if we have it.
 *  - A run with a readable weekly pattern: one performance per matching day and time ("pattern").
 *  - A run with no readable pattern: one entry per day of the run with no time ("run").
 */
export function buildAtgPerformances(
  show: Pick<ListedShow, "startDate" | "endDate" | "bookingUrl">,
  first: { date: string; time: string } | null,
  showTimes: string[],
): Performance[] {
  const { startDate, endDate, bookingUrl } = show;
  if (!startDate || !endDate) return [];
  const make = (date: string, time: string | null, kind: Performance["kind"], note: string | null): Performance =>
    ({ date, time, kind, bookingUrl, note });

  if (startDate === endDate) {
    const time = first && first.date === startDate ? first.time : (parseShowTime(showTimes[0] ?? "")?.times[0] ?? null);
    return [make(startDate, time, "exact", null)];
  }

  const patterns = showTimes.map(parseShowTime);
  const dates = eachDate(startDate, endDate);
  if (patterns.length === 0 || patterns.some((p) => p === null)) {
    const note = showTimes.length ? showTimes.join(" · ") : null;
    return dates.map((d) => make(d, null, "run", note));
  }

  const out = new Map<string, Performance>();
  for (const date of dates) {
    const day = Number(date.slice(8));
    const month = Number(date.slice(5, 7));
    for (const p of patterns as ShowTimePattern[]) {
      const applies = p.days.includes(weekdayOf(date)) || p.dates.some((d) => d.day === day && d.month === month);
      if (applies) for (const time of p.times) out.set(`${date} ${time}`, make(date, time, "pattern", null));
    }
  }
  // The first performance time is given exactly, so trust it over the pattern.
  if (first && first.date >= startDate && first.date <= endDate) {
    out.set(`${first.date} ${first.time}`, make(first.date, first.time, "exact", null));
  }
  return [...out.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

function instant(v: unknown): Date | null {
  if (typeof v !== "string" || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseAtgDetail(show: Pick<ListedShow, "startDate" | "endDate" | "bookingUrl">, json: unknown): ShowDetail {
  const j = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const firstAt = instant(j.firstPerformanceDate);
  const showTimes = Array.isArray(j.showTimes) ? j.showTimes.filter((s): s is string => typeof s === "string") : [];
  const price = j.priceInfo && typeof j.priceInfo === "object" ? (j.priceInfo as { min?: unknown }).min : null;
  return {
    startDate: show.startDate,
    endDate: show.endDate,
    onSaleAt: instant(j.onSaleStartDate)?.toISOString() ?? null,
    presaleAt: instant(j.preSaleStarts)?.toISOString() ?? null,
    priceText: typeof price === "number" && price > 0 ? `From £${price.toFixed(2).replace(/\.00$/, "")}` : null,
    timesText: showTimes.join(" · ") || null,
    summary: typeof j.overview === "string" && j.overview.trim() ? j.overview.trim() : null,
    performances: buildAtgPerformances(show, firstAt ? londonParts(firstAt) : null, showTimes),
  };
}

export async function fetchAtgDetail(show: ListedShow, fetcher: PageFetcher): Promise<ShowDetail> {
  const res = await fetcher(DETAIL_API + show.id.replace(/^atg:/, ""));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseAtgDetail(show, await res.json());
}
