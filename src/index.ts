import { runSync, vapidFrom } from "./sync";
import { sendPush } from "./push";
import { addDays, londonToday } from "./scrape/util";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

const isDate = (s: string | null): s is string => s !== null && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Shows still worth displaying: listed now, or dropped off the listing only after they finished. */
const VISIBLE = "(s.removed_at IS NULL OR s.end_date < substr(s.removed_at, 1, 10))";

const SHOW_COLUMNS = `s.id, s.source, s.venue, s.title, s.url, s.booking_url, s.image, s.genre, s.summary, s.date_text,
  s.start_date, s.end_date, s.status, s.status_text, s.on_sale_at, s.presale_at, s.price_text, s.times_text,
  s.is_baseline, s.first_seen`;

/** Push services used by Chrome, Edge, Firefox and Safari. Anything else is refused. */
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;

/** Every performance between two dates, with the shows they belong to. */
async function calendar(env: Env, url: URL): Promise<Response> {
  const today = londonToday(new Date());
  const from = isDate(url.searchParams.get("from")) ? url.searchParams.get("from")! : today;
  let to = isDate(url.searchParams.get("to")) ? url.searchParams.get("to")! : addDays(from, 62);
  if (to < from || to > addDays(from, 400)) to = addDays(from, 400);

  const [performances, shows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.show_id, p.date, p.time, p.kind, p.booking_url, p.note
       FROM performances p JOIN shows s ON s.id = p.show_id
       WHERE p.date BETWEEN ?1 AND ?2 AND ${VISIBLE}
       ORDER BY p.date, p.time IS NULL, p.time, s.title`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT ${SHOW_COLUMNS} FROM shows s
       WHERE ${VISIBLE} AND s.id IN (SELECT show_id FROM performances WHERE date BETWEEN ?1 AND ?2)`,
    ).bind(from, to),
  ]);
  return json({ from, to, today, performances: performances!.results, shows: shows!.results });
}

/** What's new: recent events, shows going on sale soon, and when the venues were last checked. */
async function feed(env: Env): Promise<Response> {
  const today = londonToday(new Date());
  const [events, comingSoon, lastSync] = await env.DB.batch([
    env.DB.prepare(
      `SELECT e.id AS event_id, e.type, e.created_at, ${SHOW_COLUMNS}
       FROM events e JOIN shows s ON s.id = e.show_id
       WHERE ${VISIBLE} AND (s.end_date IS NULL OR s.end_date >= ?1)
       ORDER BY e.id DESC LIMIT 60`,
    ).bind(today),
    env.DB.prepare(
      `SELECT ${SHOW_COLUMNS} FROM shows s
       WHERE s.status = 'coming_soon' AND s.removed_at IS NULL
       ORDER BY s.on_sale_at IS NULL, s.on_sale_at, s.start_date`,
    ),
    env.DB.prepare("SELECT value FROM meta WHERE key = 'last_sync'"),
  ]);
  const sync = (lastSync!.results[0] as { value: string } | undefined)?.value;
  return json({ today, events: events!.results, comingSoon: comingSoon!.results, lastSync: sync ? JSON.parse(sync) : null });
}

async function subscribe(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") return json({ error: "bad subscription" }, 400);
  let host: string;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || !PUSH_HOSTS.test(u.hostname)) throw new Error("not a push service");
    host = u.host;
  } catch {
    return json({ error: "bad endpoint" }, 400);
  }
  if (endpoint.length > 2000 || p256dh.length > 200 || auth.length > 100) return json({ error: "bad subscription" }, 400);

  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  ).bind(endpoint, p256dh, auth, new Date().toISOString()).run();

  // Confirm straight away so you know it works on this device.
  const vapid = vapidFrom(env);
  const result = vapid
    ? await sendPush({ endpoint, p256dh, auth }, {
        title: "Notifications are on",
        body: "You'll hear when a new show is announced or goes on sale.",
        url: "/",
        tag: "welcome",
      }, vapid)
    : "failed";
  return json({ ok: true, test: result, host });
}

async function unsubscribe(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== "string") return json({ error: "bad request" }, 400);
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(body.endpoint).run();
  return json({ ok: true });
}

/** Compare a supplied token with the secret without leaking how much of it matched. */
async function tokenMatches(supplied: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(supplied)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case "GET /api/calendar":
      return calendar(env, url);
    case "GET /api/feed":
      return feed(env);
    case "GET /api/push/key":
      return json({ key: env.VAPID_PUBLIC_KEY || null });
    case "POST /api/push/subscribe":
      return subscribe(env, request);
    case "POST /api/push/unsubscribe":
      return unsubscribe(env, request);
    case "POST /api/admin/sync": {
      const supplied = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!(await tokenMatches(supplied, env.ADMIN_TOKEN))) return json({ error: "unauthorised" }, 401);
      return json(await runSync(env));
    }
    default:
      return json({ error: "not found" }, 404);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      console.error(JSON.stringify({ message: "request failed", path: url.pathname, error: e instanceof Error ? e.message : String(e) }));
      return json({ error: "something went wrong" }, 500);
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runSync(env).catch((e: unknown) => {
        console.error(JSON.stringify({ message: "sync failed", error: e instanceof Error ? e.message : String(e) }));
        throw e;
      }),
    );
  },
} satisfies ExportedHandler<Env>;
