// One sync run: read every listing page, record what changed, refresh a batch of show pages,
// then send notifications for anything new.
//
// Writes are done in bulk (one statement carrying a JSON array) so a run uses a small, fixed number of
// database queries however many shows there are.

import { buildAtgPerformances, fetchAtgDetail, listAtgVenue } from "./scrape/atg";
import { fetchNewVicDetail, listNewVic } from "./scrape/newvic";
import { londonToday } from "./scrape/util";
import { sendPush, type PushSubscription, type VapidKeys } from "./push";
import type { ListedShow, ListingResult, PageFetcher, Performance, ShowDetail, SourceId } from "./types";

const USER_AGENT = "whats-on-stoke/1.0 (personal theatre calendar; checks listings twice an hour)";
const SOURCES: SourceId[] = ["regent", "victoria-hall", "newvic"];
const DETAIL_CONCURRENCY = 4;
const PUSH_TYPES = new Set(["new_show", "on_sale", "back_on_sale"]);

const politeFetch: PageFetcher = (url) =>
  fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json;q=0.9" } });

interface ShowRow {
  id: string;
  source: SourceId;
  venue: string;
  title: string;
  url: string;
  booking_url: string | null;
  image: string | null;
  genre: string | null;
  date_text: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  status_text: string | null;
  perf_hash: string | null;
  removed_at: string | null;
}

export interface SourceReport {
  source: SourceId;
  complete: boolean;
  listed: number;
  pages: number;
  reportedTotal: number | null;
  added: number;
  changed: number;
  problem: string | null;
}

export interface SyncReport {
  at: string;
  sources: SourceReport[];
  details: { refreshed: number; failed: number };
  notifications: { events: number; sent: number };
}

interface NewEvent {
  type: string;
  show_id: string;
  detail: string | null;
}

interface PerfRow extends Performance {
  show_id: string;
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function listSource(source: SourceId, fetcher: PageFetcher, today: string): Promise<ListingResult> {
  return source === "newvic" ? listNewVic(fetcher, today) : listAtgVenue(source, fetcher);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const J = (path: string) => `json_extract(j.value, '$.${path}')`;

function replacePerformances(db: D1Database, showIds: string[], rows: PerfRow[]): D1PreparedStatement[] {
  if (showIds.length === 0) return [];
  const statements = [
    db.prepare("DELETE FROM performances WHERE show_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(showIds)),
  ];
  if (rows.length > 0) {
    statements.push(
      db.prepare(
        `INSERT INTO performances (show_id, date, time, kind, booking_url, note)
         SELECT ${J("show_id")}, ${J("date")}, ${J("time")}, ${J("kind")}, ${J("bookingUrl")}, ${J("note")}
         FROM json_each(?1) AS j`,
      ).bind(JSON.stringify(rows)),
    );
  }
  return statements;
}

// ---------- step 1: listings ----------

async function syncListings(env: Env, fetcher: PageFetcher, nowIso: string, today: string): Promise<SourceReport[]> {
  const listings = await Promise.all(
    SOURCES.map(async (source): Promise<ListingResult> => {
      try {
        return await listSource(source, fetcher, today);
      } catch (e) {
        return { shows: [], complete: false, pages: 0, reportedTotal: null, problem: errorText(e) };
      }
    }),
  );

  const [existingRows, metaRows] = await Promise.all([
    env.DB.prepare(
      `SELECT id, source, venue, title, url, booking_url, image, genre, date_text, start_date, end_date,
              status, status_text, perf_hash, removed_at FROM shows`,
    ).all<ShowRow>(),
    env.DB.prepare("SELECT key FROM meta WHERE key LIKE 'baseline:%'").all<{ key: string }>(),
  ]);
  const existing = new Map(existingRows.results.map((r) => [r.id, r]));
  const baselined = new Set(metaRows.results.map((r) => r.key.slice("baseline:".length)));

  const upserts: (ListedShow & { is_baseline: number })[] = [];
  const events: NewEvent[] = [];
  const perfShowIds: string[] = [];
  const perfRows: PerfRow[] = [];
  const reappeared: string[] = [];
  const listedIds: string[] = [];
  const completeSources: SourceId[] = [];
  const newBaselines: SourceId[] = [];
  const reports: SourceReport[] = [];

  SOURCES.forEach((source, i) => {
    const listing = listings[i]!;
    const isBaseline = !baselined.has(source);
    let added = 0;
    let changed = 0;

    for (const show of listing.shows) {
      listedIds.push(show.id);
      const row = existing.get(show.id);
      const datesChanged = !row || row.date_text !== show.dateText;
      if (row?.removed_at) reappeared.push(show.id);

      if (!row) {
        added++;
        upserts.push({ ...show, is_baseline: isBaseline ? 1 : 0 });
        // A show first seen after the venue's initial load is news.
        if (!isBaseline) events.push({ type: "new_show", show_id: show.id, detail: show.statusText });
      } else {
        const differs =
          datesChanged || row.title !== show.title || row.venue !== show.venue || row.url !== show.url ||
          row.booking_url !== show.bookingUrl || row.status !== show.status || row.status_text !== show.statusText ||
          (show.image !== null && row.image !== show.image) || (show.genre !== null && row.genre !== show.genre);
        if (differs) {
          changed++;
          upserts.push({ ...show, is_baseline: 0 });
        }
        if (row.status !== show.status) {
          if (show.status === "sold_out") events.push({ type: "sold_out", show_id: show.id, detail: null });
          else if (show.status === "on_sale" && row.status === "coming_soon") events.push({ type: "on_sale", show_id: show.id, detail: null });
          else if (show.status === "on_sale" && row.status === "sold_out") events.push({ type: "back_on_sale", show_id: show.id, detail: null });
        }
      }

      // Until the show's own page has been read, put it on the calendar from the listing dates alone.
      if (datesChanged) {
        perfShowIds.push(show.id);
        for (const p of buildAtgPerformances(show, null, [])) perfRows.push({ ...p, show_id: show.id });
      }
    }

    if (listing.complete && listing.shows.length > 0) {
      completeSources.push(source);
      if (isBaseline) newBaselines.push(source);
    }
    reports.push({
      source, complete: listing.complete, listed: listing.shows.length, pages: listing.pages,
      reportedTotal: listing.reportedTotal, added, changed, problem: listing.problem,
    });
  });

  const statements: D1PreparedStatement[] = [];
  if (upserts.length > 0) {
    // When the listed dates change, the show's page is re-read on the next detail pass.
    const sameDates = "shows.date_text IS excluded.date_text";
    statements.push(
      env.DB.prepare(
        `INSERT INTO shows (id, source, venue, title, url, booking_url, image, genre, summary, date_text,
                            start_date, end_date, status, status_text, is_baseline, first_seen)
         SELECT ${J("id")}, ${J("source")}, ${J("venue")}, ${J("title")}, ${J("url")}, ${J("bookingUrl")}, ${J("image")},
                ${J("genre")}, ${J("summary")}, ${J("dateText")}, ${J("startDate")}, ${J("endDate")}, ${J("status")},
                ${J("statusText")}, ${J("is_baseline")}, ?2
         FROM json_each(?1) AS j WHERE true
         ON CONFLICT (id) DO UPDATE SET
           venue = excluded.venue, title = excluded.title, url = excluded.url, booking_url = excluded.booking_url,
           image = COALESCE(excluded.image, shows.image),
           genre = COALESCE(excluded.genre, shows.genre),
           summary = COALESCE(excluded.summary, shows.summary),
           status = excluded.status, status_text = excluded.status_text,
           start_date = CASE WHEN ${sameDates} THEN shows.start_date ELSE excluded.start_date END,
           end_date = CASE WHEN ${sameDates} THEN shows.end_date ELSE excluded.end_date END,
           detail_fetched_at = CASE WHEN ${sameDates} THEN shows.detail_fetched_at ELSE NULL END,
           perf_hash = CASE WHEN ${sameDates} THEN shows.perf_hash ELSE NULL END,
           date_text = excluded.date_text`,
      ).bind(JSON.stringify(upserts), nowIso),
    );
  }
  statements.push(...replacePerformances(env.DB, perfShowIds, perfRows));
  if (events.length > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO events (type, show_id, detail, created_at)
         SELECT ${J("type")}, ${J("show_id")}, ${J("detail")}, ?2 FROM json_each(?1) AS j`,
      ).bind(JSON.stringify(events), nowIso),
    );
  }
  if (reappeared.length > 0) {
    statements.push(
      env.DB.prepare("UPDATE shows SET removed_at = NULL WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(reappeared)),
    );
  }
  if (completeSources.length > 0) {
    // A show is only marked as gone when the venue's whole listing was read successfully.
    statements.push(
      env.DB.prepare(
        `UPDATE shows SET removed_at = ?1
         WHERE removed_at IS NULL
           AND source IN (SELECT value FROM json_each(?2))
           AND id NOT IN (SELECT value FROM json_each(?3))`,
      ).bind(nowIso, JSON.stringify(completeSources), JSON.stringify(listedIds)),
    );
  }
  if (newBaselines.length > 0) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) SELECT 'baseline:' || value, ?2 FROM json_each(?1)")
        .bind(JSON.stringify(newBaselines), nowIso),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return reports;
}

// ---------- step 2: show pages ----------

interface DetailCandidate {
  id: string;
  source: SourceId;
  venue: string;
  title: string;
  url: string;
  booking_url: string | null;
  date_text: string;
  start_date: string | null;
  end_date: string | null;
  perf_hash: string | null;
}

async function syncDetails(env: Env, fetcher: PageFetcher, now: Date, today: string) {
  const budget = Math.max(0, Number(env.DETAIL_BUDGET) || 0);
  if (budget === 0) return { refreshed: 0, failed: 0 };
  const maxAgeMs = (Number(env.DETAIL_MAX_AGE_HOURS) || 24) * 3_600_000;
  const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
  const includeAtg = env.ATG_DETAILS !== "false" ? 1 : 0;

  // Shows never read come first, then the ones read longest ago.
  const candidates = await env.DB.prepare(
    `SELECT id, source, venue, title, url, booking_url, date_text, start_date, end_date, perf_hash FROM shows
     WHERE removed_at IS NULL
       AND (end_date IS NULL OR end_date >= ?1)
       AND (detail_fetched_at IS NULL OR detail_fetched_at < ?2)
       AND (?3 = 1 OR source = 'newvic')
     ORDER BY detail_fetched_at IS NOT NULL, detail_fetched_at
     LIMIT ?4`,
  ).bind(today, cutoff, includeAtg, budget).all<DetailCandidate>();

  const results = await mapLimit(candidates.results, DETAIL_CONCURRENCY, async (row) => {
    const show: ListedShow = {
      id: row.id, source: row.source, venue: row.venue, title: row.title, url: row.url, bookingUrl: row.booking_url,
      image: null, genre: null, summary: null, dateText: row.date_text, startDate: row.start_date, endDate: row.end_date,
      status: "unknown", statusText: null,
    };
    try {
      const detail = row.source === "newvic" ? await fetchNewVicDetail(show, fetcher) : await fetchAtgDetail(show, fetcher);
      return { row, detail, error: null };
    } catch (e) {
      console.error(JSON.stringify({ message: "show page failed", show: row.id, error: errorText(e) }));
      return { row, detail: null as ShowDetail | null, error: errorText(e) };
    }
  });
  if (results.length === 0) return { refreshed: 0, failed: 0 };

  const updates: object[] = [];
  const perfShowIds: string[] = [];
  const perfRows: PerfRow[] = [];
  for (const { row, detail, error } of results) {
    if (!detail) {
      updates.push({ id: row.id, ok: 0, error });
      continue;
    }
    // A page with no performances listed keeps whatever the listing gave us.
    const perfHash = detail.performances.length > 0 ? hash(JSON.stringify(detail.performances)) : row.perf_hash;
    if (perfHash !== row.perf_hash) {
      perfShowIds.push(row.id);
      for (const p of detail.performances) perfRows.push({ ...p, show_id: row.id });
    }
    updates.push({ id: row.id, ok: 1, error: null, perfHash, ...detail, performances: undefined });
  }

  const keepUnlessOk = (column: string, path: string) => `${column} = CASE WHEN ${J("ok")} = 1 THEN ${J(path)} ELSE ${column} END`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE shows SET
         detail_fetched_at = ?2,
         detail_error = ${J("error")},
         start_date = COALESCE(${J("startDate")}, start_date),
         end_date = COALESCE(${J("endDate")}, end_date),
         summary = COALESCE(${J("summary")}, summary),
         ${keepUnlessOk("on_sale_at", "onSaleAt")},
         ${keepUnlessOk("presale_at", "presaleAt")},
         ${keepUnlessOk("price_text", "priceText")},
         ${keepUnlessOk("times_text", "timesText")},
         ${keepUnlessOk("perf_hash", "perfHash")}
       FROM json_each(?1) AS j WHERE shows.id = ${J("id")}`,
    ).bind(JSON.stringify(updates), now.toISOString()),
    ...replacePerformances(env.DB, perfShowIds, perfRows),
  ]);

  const failed = results.filter((r) => r.detail === null).length;
  return { refreshed: results.length - failed, failed };
}

// ---------- step 3: notifications ----------

interface EventRow {
  id: number;
  type: string;
  title: string;
  venue: string;
  url: string;
  booking_url: string | null;
  date_text: string;
  status: string;
  status_text: string | null;
}

export function vapidFrom(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:you@example.com" };
}

export function describeEvent(e: EventRow): { title: string; body: string; url: string } {
  const ticketNote =
    e.status === "coming_soon" ? (e.status_text ?? "On sale soon")
    : e.status === "sold_out" ? "Sold out"
    : e.status === "on_sale" ? "Tickets on sale now" : "";
  const body = [e.date_text, ticketNote].filter(Boolean).join(" · ");
  const url = e.status === "on_sale" && e.booking_url ? e.booking_url : e.url;
  if (e.type === "on_sale") return { title: `On sale now: ${e.title}`, body: `${e.venue} · ${e.date_text}`, url };
  if (e.type === "back_on_sale") return { title: `Tickets available again: ${e.title}`, body: `${e.venue} · ${e.date_text}`, url };
  return { title: `New at ${e.venue}: ${e.title}`, body, url };
}

async function sendNotifications(env: Env) {
  const pending = await env.DB.prepare(
    `SELECT e.id, e.type, s.title, s.venue, s.url, s.booking_url, s.date_text, s.status, s.status_text
     FROM events e JOIN shows s ON s.id = e.show_id
     WHERE e.notified = 0 ORDER BY e.id LIMIT 100`,
  ).all<EventRow>();
  if (pending.results.length === 0) return { events: 0, sent: 0 };

  const toPush = pending.results.filter((e) => PUSH_TYPES.has(e.type));
  const vapid = vapidFrom(env);
  let sent = 0;

  if (toPush.length > 0 && vapid) {
    const subs = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions LIMIT 10").all<PushSubscription>();
    // Up to three separate notifications; beyond that, one summary so a big announcement day is not a flood.
    const messages =
      toPush.length <= 3
        ? toPush.map((e) => ({ ...describeEvent(e), tag: `event-${e.id}` }))
        : [{
            title: `${toPush.length} theatre updates`,
            body: toPush.slice(0, 4).map((e) => e.title).join(", ") + (toPush.length > 4 ? "…" : ""),
            url: "/?view=new",
            tag: `summary-${toPush[0]!.id}`,
          }];
    const gone: string[] = [];
    for (const sub of subs.results) {
      for (const message of messages) {
        const result = await sendPush(sub, message, vapid);
        if (result === "sent") sent++;
        if (result === "gone") {
          gone.push(sub.endpoint);
          break;
        }
      }
    }
    if (gone.length > 0) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint IN (SELECT value FROM json_each(?1))")
        .bind(JSON.stringify(gone)).run();
    }
  }

  const lastId = pending.results[pending.results.length - 1]!.id;
  await env.DB.prepare("UPDATE events SET notified = 1 WHERE notified = 0 AND id <= ?1").bind(lastId).run();
  return { events: toPush.length, sent };
}

// ---------- the whole run ----------

export async function runSync(env: Env, now = new Date(), fetcher: PageFetcher = politeFetch): Promise<SyncReport> {
  const nowIso = now.toISOString();
  const today = londonToday(now);
  const sources = await syncListings(env, fetcher, nowIso, today);
  const details = await syncDetails(env, fetcher, now, today);
  const notifications = await sendNotifications(env);

  const report: SyncReport = { at: nowIso, sources, details, notifications };
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_sync', ?1) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(report)).run();
  console.log(JSON.stringify({ message: "sync finished", ...report }));
  return report;
}
