// New Vic Theatre. A WordPress site with plain server-rendered HTML.
//
// The listing (/whats-on/, /whats-on/page/2/, ...) gives each production's title, date range (without
// a year), image and summary. Each production page lists every performance with its full date, time
// and a booking link, so the calendar is exact for this venue. Availability is not published.

import type { PageFetcher, ListedShow, ListingResult, Performance, ShowDetail } from "../types";
import { absoluteUrl, daysBetween, monthNumber, textOf, weekdayNumber, weekdayOf, ymd } from "./util";

const SITE = "https://www.newvictheatre.org.uk";
const MAX_PAGES = 30;

// ---------- dates ----------

/** The year in which day/month falls on the given weekday, nearest to today. */
function inferDate(day: number, month: number, weekday: number | null, today: string): string | null {
  const thisYear = Number(today.slice(0, 4));
  let best: string | null = null;
  for (let y = thisYear - 1; y <= thisYear + 2; y++) {
    const d = ymd(y, month, day);
    if (!d || (weekday !== null && weekdayOf(d) !== weekday)) continue;
    if (best === null || Math.abs(daysBetween(today, d)) < Math.abs(daysBetween(today, best))) best = d;
  }
  return best;
}

/**
 * "Wed 18 Nov", "Fri 13 Nov–Sat 23 Jan", "Wed 9–Thu 24 Dec". The site gives no year, so the weekday
 * is used to find it. The production page later replaces these with exact dates.
 */
export function parseNewVicDates(text: string, today: string): { start: string; end: string } | null {
  const parts = text.split(/\s*[–—-]\s*/).map((p) => /([A-Za-z]{3,})?\s*(\d{1,2})(?:\s+([A-Za-z]{3,}))?/.exec(p.trim()));
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last || parts.length > 2) return null;

  const endMonth = last[3] ? monthNumber(last[3]) : null;
  if (!endMonth) return null;
  const startMonth = first[3] ? monthNumber(first[3]) : endMonth;
  if (!startMonth) return null;

  const weekday = (name: string | undefined) => (name ? weekdayNumber(name) : null);
  const start = inferDate(Number(first[2]), startMonth, weekday(first[1]), today)
    ?? inferDate(Number(first[2]), startMonth, null, today);
  if (!start) return null;
  if (parts.length === 1) return { start, end: start };

  const startYear = Number(start.slice(0, 4));
  for (const y of [startYear, startYear + 1]) {
    const end = ymd(y, endMonth, Number(last[2]));
    if (end && end >= start) return { start, end };
  }
  return null;
}

// ---------- listing ----------

export function parseNewVicListingPage(html: string, today: string): { shows: ListedShow[]; next: string | null } {
  const shows: ListedShow[] = [];
  for (const block of html.split(/<figure class="feature"/).slice(1)) {
    const contentAt = block.indexOf("feature__content");
    if (contentAt < 0) continue;
    const content = block.slice(contentAt);
    const slug = /href="[^"]*\/productions\/([^"/#]+)\/?[^"]*"/.exec(content)?.[1];
    const title = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(content);
    const date = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(content);
    if (!slug || !title || !date) continue;

    const dateText = textOf(date[1]!);
    const range = parseNewVicDates(dateText, today);
    const image = /<img[^>]+src="([^"]+)"/.exec(block.slice(0, contentAt))?.[1];
    const summary = /<p[^>]*>([\s\S]*?)<\/p>/.exec(content);
    const label = /<h[456][^>]*>([\s\S]*?)<\/h[456]>/.exec(content);
    shows.push({
      id: `newvic:${slug}`,
      source: "newvic",
      venue: "New Vic Theatre",
      title: textOf(title[1]!).replace(/\.$/, ""),
      url: `${SITE}/productions/${slug}/`,
      bookingUrl: `${SITE}/productions/${slug}/#modal1`,
      image: image ? absoluteUrl(image, SITE) : null,
      genre: label ? textOf(label[1]!) || null : null,
      summary: summary ? textOf(summary[1]!) || null : null,
      dateText,
      startDate: range?.start ?? null,
      endDate: range?.end ?? null,
      status: "unknown",
      statusText: null,
    });
  }
  const next = /<a[^>]*class="next page-numbers"[^>]*href="([^"]+)"/.exec(html)
    ?? /<a[^>]*href="([^"]+)"[^>]*class="next page-numbers"/.exec(html);
  return { shows, next: next ? absoluteUrl(next[1]!, SITE) : null };
}

/** Follow the "Next" link from page to page until there isn't one. */
export async function listNewVic(fetcher: PageFetcher, today: string): Promise<ListingResult> {
  const byId = new Map<string, ListedShow>();
  const visited = new Set<string>();
  let url: string | null = `${SITE}/whats-on/`;
  let pages = 0;
  let problem: string | null = null;

  while (url && pages < MAX_PAGES && !visited.has(url)) {
    visited.add(url);
    const res = await fetcher(url);
    if (!res.ok) {
      problem = `page ${pages + 1} returned HTTP ${res.status}`;
      break;
    }
    const page = parseNewVicListingPage(await res.text(), today);
    pages++;
    if (page.shows.length === 0) {
      problem = `page ${pages} had no shows on it`;
      break;
    }
    for (const s of page.shows) if (!byId.has(s.id)) byId.set(s.id, s);
    url = page.next;
  }
  if (!problem && url) problem = `stopped after ${pages} pages with more remaining`;
  return { shows: [...byId.values()], complete: problem === null, pages, reportedTotal: null, problem };
}

// ---------- production page ----------

export function parseNewVicDetail(html: string): ShowDetail {
  const performances: Performance[] = [];
  const blocks = html.matchAll(/<div class="timeWrapper">([\s\S]*?)(?=<div class="timeWrapper">|<\/section>)/g);
  for (const [, block] of blocks) {
    const split = block!.indexOf('class="rightSide"');
    // Cut at the tag that opens the right-hand side, so no half tag is left behind.
    const left = textOf(split < 0 ? block! : block!.slice(0, block!.lastIndexOf("<", split)));
    const rightHtml = split < 0 ? "" : block!.slice(split + 'class="rightSide"'.length + 1);
    const when = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),?\s+(\d{1,2})[:.](\d{2})/.exec(left);
    const month = when ? monthNumber(when[2]!) : null;
    const date = when && month ? ymd(Number(when[3]), month, Number(when[1])) : null;
    if (!when || !date) continue;

    const href = /href="([^"]*EventInstanceId=\d+[^"]*)"/.exec(rightHtml)?.[1] ?? null;
    // Text after the date is an access tag (BSL, AD, CAP, RP). Text on the right that is not the
    // booking button is a status such as "Sold out".
    const tags = left.slice(left.indexOf(when[0]) + when[0].length).trim();
    const rightText = textOf(rightHtml).replace(/book tickets/i, "").trim();
    const note = [tags, rightText || (href ? "" : "Not bookable online")].filter(Boolean).join(" · ");
    performances.push({
      date,
      time: `${when[4]!.padStart(2, "0")}:${when[5]}`,
      kind: "exact",
      bookingUrl: href ? absoluteUrl(href, SITE) : null,
      note: note || null,
    });
  }
  performances.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const price = /<b>\s*Tickets:\s*<\/b>([^<]+)/i.exec(html);
  const first = performances[0];
  const last = performances[performances.length - 1];
  return {
    startDate: first?.date ?? null,
    endDate: last?.date ?? null,
    onSaleAt: null,
    presaleAt: null,
    priceText: price ? tidyPrice(textOf(price[1]!)) : null,
    timesText: null,
    summary: null,
    performances,
  };
}

/** "£16.00 - £16.00" becomes "£16", "£17.50 - £43.50" stays a range. */
function tidyPrice(text: string): string | null {
  const [low, high] = text.split(/\s*[-–]\s*/).map((p) => p.trim().replace(/\.00$/, ""));
  if (!low) return null;
  return high && high !== low ? `${low} – ${high}` : low;
}

export async function fetchNewVicDetail(show: ListedShow, fetcher: PageFetcher): Promise<ShowDetail> {
  const res = await fetcher(show.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseNewVicDetail(await res.text());
}
