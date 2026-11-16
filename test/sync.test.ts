// A whole sync run against a real local D1 database, with the three venues served from fake pages.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import worker from "../src/index";
import { runSync } from "../src/sync";
import { atgDetail, atgPage, newVicPage, newVicProduction, type FakeAtgShow, type FakeProduction } from "./helpers";

let proxy: PlatformProxy<Env>;
let env: Env;

interface World {
  regent: FakeAtgShow[];
  regentFound?: number;
  victoria: FakeAtgShow[];
  newvic: FakeProduction[];
  details: Record<string, unknown>;
  productions: Record<string, string[]>;
  requests: string[];
}

/** Serve the fake venues. ATG pages hold two shows each, New Vic pages one production each. */
function fetcherFor(world: World) {
  return async (url: string): Promise<Response> => {
    world.requests.push(url);
    const u = new URL(url);
    const atg = /^\/venues\/(regent-theatre|victoria-hall)\/whats-on\/$/.exec(u.pathname);
    if (u.host === "www.atgtickets.com" && atg) {
      const all = atg[1] === "regent-theatre" ? world.regent : world.victoria;
      const found = atg[1] === "regent-theatre" ? (world.regentFound ?? all.length) : all.length;
      const n = Number(u.searchParams.get("page"));
      return new Response(atgPage(all.slice((n - 1) * 2, n * 2), found));
    }
    if (u.host === "boltapi.atgtickets.com") {
      const detail = world.details[u.pathname.replace("/shows/", "")];
      return detail ? Response.json(detail) : new Response("", { status: 404 });
    }
    if (u.host === "www.newvictheatre.org.uk") {
      const listing = /^\/whats-on\/(?:page\/(\d+)\/)?$/.exec(u.pathname);
      if (listing) {
        const n = Number(listing[1] ?? 1);
        const next = n < world.newvic.length ? `https://www.newvictheatre.org.uk/whats-on/page/${n + 1}/` : null;
        return new Response(newVicPage(world.newvic.slice(n - 1, n), next));
      }
      const slug = /^\/productions\/([^/]+)\/$/.exec(u.pathname)?.[1];
      if (slug && world.productions[slug]) return new Response(newVicProduction(world.productions[slug]));
    }
    return new Response("", { status: 404 });
  };
}

const all = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).all<T>().then((r) => r.results);

beforeAll(async () => {
  proxy = await getPlatformProxy<Env>({ persist: false });
  env = proxy.env;
  const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
  for (const statement of schema.split(";").map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
});
afterAll(() => proxy.dispose());

describe("sync", () => {
  const world: World = {
    regent: [
      { path: "legally-blonde/regent-theatre", title: "Legally Blonde", dates: "Tue 17 Nov - Sat 21 Nov 2026", genre: "Musicals" },
      { path: "pink-floyd/regent-theatre", title: "Pink Floyd Tribute", dates: "Mon 30 Nov 2026" },
      { path: "panto/regent-theatre", title: "Snow White", dates: "Fri 11 Dec 2026 - Sun 3 Jan 2027", genre: "Pantomime" },
    ],
    victoria: [
      { path: "massaoke/victoria-hall", title: "Massaoke", dates: "Sat 15 May 2027", venue: "Victoria Hall, Stoke-on-Trent", infoBar: "On sale Wed 18 Nov 2026", buy: false },
    ],
    newvic: [
      { slug: "the-borrowers", title: "The Borrowers.", dates: "Fri 13 Nov–Sat 23 Jan" },
      { slug: "the-manfreds", title: "The Manfreds", dates: "Wed 18 Nov" },
    ],
    details: {
      "legally-blonde/regent-theatre": atgDetail({ first: "2026-11-17T19:30:00.000Z", showTimes: ["Tue - Sat at 19:30", "Wed, Thu and Sat at 14:30"] }),
      "pink-floyd/regent-theatre": atgDetail({ first: "2026-11-30T19:00:00.000Z", min: 37.95 }),
      "panto/regent-theatre": atgDetail({ first: "2026-12-11T13:00:00.000Z", showTimes: ["Please check the calendar for full performance information."] }),
      "massaoke/victoria-hall": atgDetail({ first: "2027-05-15T18:30:00.000Z", onSaleStart: "2026-11-18T10:00:00.000Z", preSale: "2026-11-17T10:00:00.000Z" }),
    },
    productions: {
      "the-borrowers": ["Friday 13 November 2026, 19:30", "Saturday 21 November 2026, 14:15", "Saturday 21 November 2026, 19:30", "Saturday 23 January 2027, 19:30"],
      "the-manfreds": ["Wednesday 18 November 2026, 19:30"],
    },
    requests: [],
  };

  it("first run: loads every show from every page and treats them as the starting point, not news", async () => {
    const report = await runSync(env, new Date("2026-11-16T09:00:00Z"), fetcherFor(world));

    expect(report.sources.map((s) => [s.source, s.complete, s.listed, s.pages, s.added])).toEqual([
      ["regent", true, 3, 2, 3],
      ["victoria-hall", true, 1, 1, 1],
      ["newvic", true, 2, 2, 2],
    ]);
    expect(report.details).toEqual({ refreshed: 6, failed: 0 });

    const shows = await all<{ id: string; is_baseline: number; status: string; on_sale_at: string | null; price_text: string | null }>(
      "SELECT id, is_baseline, status, on_sale_at, price_text FROM shows ORDER BY id");
    expect(shows).toHaveLength(6);
    expect(shows.every((s) => s.is_baseline === 1)).toBe(true);
    expect(shows.find((s) => s.id === "atg:massaoke/victoria-hall")).toMatchObject({ status: "coming_soon", on_sale_at: "2026-11-18T10:00:00.000Z" });
    expect(shows.find((s) => s.id === "newvic:the-borrowers")!.price_text).toBe("£20 – £30");
    expect(await all("SELECT id FROM events")).toHaveLength(0);

    const count = async (id: string) => (await all<{ kind: string; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM performances WHERE show_id = ?1 GROUP BY kind ORDER BY kind", id)).map((r) => `${r.kind}:${r.n}`).join(",");
    expect(await count("atg:legally-blonde/regent-theatre")).toBe("exact:1,pattern:7");
    expect(await count("atg:pink-floyd/regent-theatre")).toBe("exact:1");
    expect(await count("atg:panto/regent-theatre")).toBe("run:24");
    expect(await count("newvic:the-borrowers")).toBe("exact:4");
    const floyd = await all<{ date: string; time: string }>("SELECT date, time FROM performances WHERE show_id = 'atg:pink-floyd/regent-theatre'");
    expect(floyd).toEqual([{ date: "2026-11-30", time: "19:00" }]);
  });

  it("second run with nothing changed: no writes to shows, no events, no show pages re-read", async () => {
    world.requests.length = 0;
    const report = await runSync(env, new Date("2026-11-16T09:30:00Z"), fetcherFor(world));
    expect(report.sources.every((s) => s.added === 0 && s.changed === 0 && s.complete)).toBe(true);
    expect(report.details).toEqual({ refreshed: 0, failed: 0 });
    expect(world.requests.filter((u) => u.includes("boltapi") || u.includes("/productions/"))).toHaveLength(0);
    expect(await all("SELECT id FROM events")).toHaveLength(0);
  });

  it("later run: a new show, a sell-out, tickets going on sale and a cancellation are all recorded", async () => {
    world.regent.push({ path: "six/regent-theatre", title: "Six", dates: "Tue 28 Sep - Sat 2 Oct 2027", genre: "Musicals" });
    world.details["six/regent-theatre"] = atgDetail({ first: "2027-09-28T19:00:00.000Z", showTimes: ["Tue - Sat at 20:00"] });
    world.regent[1] = { ...world.regent[1]!, infoBar: "Sold out", buy: false };
    world.victoria[0] = { ...world.victoria[0]!, infoBar: "", buy: true };
    world.newvic.pop(); // The Manfreds disappears before its date

    const report = await runSync(env, new Date("2026-11-18T10:30:00Z"), fetcherFor(world));
    expect(report.sources.find((s) => s.source === "regent")).toMatchObject({ added: 1, changed: 1, listed: 4, pages: 2 });

    const events = await all<{ type: string; show_id: string; notified: number }>("SELECT type, show_id, notified FROM events ORDER BY id");
    expect(events.map((e) => `${e.type} ${e.show_id}`).sort()).toEqual([
      "new_show atg:six/regent-theatre",
      "on_sale atg:massaoke/victoria-hall",
      "sold_out atg:pink-floyd/regent-theatre",
    ]);
    // No push keys are configured in tests, so nothing is sent, but events are not left queued forever.
    expect(events.every((e) => e.notified === 1)).toBe(true);
    expect(report.notifications).toEqual({ events: 2, sent: 0 });

    const six = await all<{ is_baseline: number; first_seen: string }>("SELECT is_baseline, first_seen FROM shows WHERE id = 'atg:six/regent-theatre'");
    expect(six).toEqual([{ is_baseline: 0, first_seen: "2026-11-18T10:30:00.000Z" }]);
    const removed = await all<{ id: string }>("SELECT id FROM shows WHERE removed_at IS NOT NULL");
    expect(removed).toEqual([{ id: "newvic:the-manfreds" }]);
  });

  it("an incomplete listing never removes shows", async () => {
    world.regentFound = 40; // the venue says 40 shows but only 4 can be read
    const report = await runSync(env, new Date("2026-11-18T11:00:00Z"), fetcherFor({ ...world, regent: world.regent.slice(0, 2) }));
    const regent = report.sources.find((s) => s.source === "regent")!;
    expect(regent.complete).toBe(false);
    expect(regent.problem).toContain("reports 40");
    expect(await all("SELECT id FROM shows WHERE source = 'regent' AND removed_at IS NOT NULL")).toHaveLength(0);
    world.regentFound = undefined;
  });

  it("a show that comes back is restored", async () => {
    world.newvic.push({ slug: "the-manfreds", title: "The Manfreds", dates: "Wed 18 Nov" });
    await runSync(env, new Date("2026-11-18T11:30:00Z"), fetcherFor(world));
    expect(await all("SELECT id FROM shows WHERE removed_at IS NOT NULL")).toHaveLength(0);
  });

  it("serves the calendar and the feed", async () => {
    const call = async (path: string) => {
      const res = await worker.fetch(new Request(`https://app.example${path}`) as never, env);
      expect(res.status).toBe(200);
      return res.json() as Promise<Record<string, any>>;
    };
    const cal = await call("/api/calendar?from=2026-11-16&to=2026-11-30");
    const onThe21st = cal.performances.filter((p: any) => p.date === "2026-11-21").map((p: any) => `${p.time} ${p.show_id}`);
    expect(onThe21st).toEqual([
      "14:15 newvic:the-borrowers",
      "14:30 atg:legally-blonde/regent-theatre",
      "19:30 atg:legally-blonde/regent-theatre",
      "19:30 newvic:the-borrowers",
    ]);
    expect(cal.shows.map((s: any) => s.id).sort()).toEqual([
      "atg:legally-blonde/regent-theatre", "atg:pink-floyd/regent-theatre", "newvic:the-borrowers", "newvic:the-manfreds",
    ]);

    const feed = await call("/api/feed");
    expect(feed.events.map((e: any) => e.type).sort()).toEqual(["new_show", "on_sale", "sold_out"]);
    expect(feed.lastSync.sources).toHaveLength(3);
  });

  it("only accepts subscriptions for real push services", async () => {
    const res = await worker.fetch(new Request("https://app.example/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint: "https://internal.example/hook", keys: { p256dh: "x", auth: "y" } }),
    }) as never, env);
    expect(res.status).toBe(400);
    expect(await all("SELECT endpoint FROM push_subscriptions")).toHaveLength(0);
  });

  it("keeps the manual sync endpoint locked", async () => {
    const res = await worker.fetch(new Request("https://app.example/api/admin/sync", { method: "POST" }) as never, env);
    expect(res.status).toBe(401);
  });
});
