import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildAtgPerformances, listAtgVenue, parseAtgCardsFromHtml, parseAtgDates, parseAtgDetail, parseAtgListingPage, parseShowTime,
} from "../src/scrape/atg";
import { listNewVic, parseNewVicDates, parseNewVicDetail, parseNewVicListingPage } from "../src/scrape/newvic";
import { londonParts } from "../src/scrape/util";
import { atgDetail, atgPage, newVicPage } from "./helpers";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const page = (body: string, status = 200) => new Response(body, { status });

describe("ATG dates", () => {
  it("reads the three shapes the site uses", () => {
    expect(parseAtgDates("Mon 30 Nov 2026")).toEqual({ start: "2026-11-30", end: "2026-11-30" });
    expect(parseAtgDates("Tue 17 Nov - Sat 21 Nov 2026")).toEqual({ start: "2026-11-17", end: "2026-11-21" });
    expect(parseAtgDates("Fri 11 Dec 2026 - Sun 3 Jan 2027")).toEqual({ start: "2026-12-11", end: "2027-01-03" });
  });
  it("puts a yearless start in the previous year when the run crosses New Year", () => {
    expect(parseAtgDates("Sat 28 Dec - Sat 4 Jan 2027")).toEqual({ start: "2026-12-28", end: "2027-01-04" });
  });
  it("gives up on text that is not a date", () => {
    expect(parseAtgDates("Coming soon")).toBeNull();
  });
});

describe("ATG listing", () => {
  const shows = [
    { path: "legally-blonde/regent-theatre", title: "Legally Blonde", dates: "Tue 17 Nov - Sat 21 Nov 2026", genre: "Musicals" },
    { path: "the-australian-pink-floyd/regent-theatre", title: "The Australian Pink Floyd", dates: "Mon 30 Nov 2026", infoBar: "Sold out", buy: false },
    { path: "massaoke/victoria-hall", title: "Massaoke", dates: "Sat 15 May 2027", infoBar: "On sale Wed 18 Nov 2026", buy: false },
  ];

  it("reads cards and the venue total from the page data", () => {
    const { shows: parsed, found } = parseAtgListingPage("regent", atgPage(shows, 46));
    expect(found).toBe(46);
    expect(parsed.map((s) => [s.id, s.status, s.startDate, s.endDate])).toEqual([
      ["atg:legally-blonde/regent-theatre", "on_sale", "2026-11-17", "2026-11-21"],
      ["atg:the-australian-pink-floyd/regent-theatre", "sold_out", "2026-11-30", "2026-11-30"],
      ["atg:massaoke/victoria-hall", "coming_soon", "2027-05-15", "2027-05-15"],
    ]);
    expect(parsed[0]).toMatchObject({
      title: "Legally Blonde", genre: "Musicals", venue: "Regent Theatre, Stoke-on-Trent",
      url: "https://www.atgtickets.com/shows/legally-blonde/regent-theatre/",
      bookingUrl: "https://www.atgtickets.com/shows/legally-blonde/regent-theatre/calendar/",
      image: "https://img.example/786/legally-blonde/regent-theatre.jpg",
    });
    expect(parsed[1]!.bookingUrl).toBeNull();
    expect(parsed[2]!.statusText).toBe("On sale Wed 18 Nov 2026");
  });

  it("falls back to the HTML cards (markup captured from the live site)", () => {
    const [show] = parseAtgCardsFromHtml("victoria-hall", fixture("atg-card.html"));
    expect(show).toMatchObject({
      id: "atg:russell-watson-the-power-of-the-voice/victoria-hall",
      title: "Russell Watson: The Power of The Voice",
      genre: "Concert",
      venue: "Victoria Hall, Stoke-on-Trent",
      dateText: "Fri 22 Oct 2027",
      startDate: "2027-10-22",
      status: "on_sale",
    });
    // The same card via the public entry point, which has no page data to read here.
    expect(parseAtgListingPage("victoria-hall", fixture("atg-card.html")).shows).toHaveLength(1);
  });

  it("walks every page until it has all the shows the venue reports", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `show-${i}/regent-theatre`, title: `Show ${i}`, dates: "Mon 30 Nov 2026" }));
    const requested: string[] = [];
    const result = await listAtgVenue("regent", async (url) => {
      requested.push(url);
      const n = Number(new URL(url).searchParams.get("page"));
      return page(atgPage(many.slice((n - 1) * 2, n * 2), 5));
    });
    expect(requested).toHaveLength(3);
    expect(result).toMatchObject({ complete: true, pages: 3, reportedTotal: 5, problem: null });
    expect(result.shows).toHaveLength(5);
  });

  it("reports an incomplete listing rather than guessing", async () => {
    const result = await listAtgVenue("regent", async (url) => {
      const n = Number(new URL(url).searchParams.get("page"));
      return n === 1 ? page(atgPage([{ path: "a/regent-theatre", title: "A", dates: "Mon 30 Nov 2026" }], 9)) : page("", 503);
    });
    expect(result.complete).toBe(false);
    expect(result.problem).toContain("503");
    expect(result.shows).toHaveLength(1);
  });
});

describe("ATG show times", () => {
  it("reads weekday patterns", () => {
    expect(parseShowTime("Tue - Sat at 19:30")).toEqual({ days: [1, 2, 3, 4, 5], dates: [], times: ["19:30"] });
    expect(parseShowTime("Wed, Thu and Sat at 14:30")).toEqual({ days: [2, 3, 5], dates: [], times: ["14:30"] });
    expect(parseShowTime("Tue - Thu and Sat at 19:30")).toEqual({ days: [1, 2, 3, 5], dates: [], times: ["19:30"] });
    expect(parseShowTime("Fri at 17:00 and 20:30")).toEqual({ days: [4], dates: [], times: ["17:00", "20:30"] });
    expect(parseShowTime("Fri 31 Dec at 19:00")).toEqual({ days: [], dates: [{ day: 31, month: 12 }], times: ["19:00"] });
    expect(parseShowTime("Sat - Mon at 19:30")?.days).toEqual([0, 5, 6]);
  });
  it("rejects free text", () => {
    expect(parseShowTime("Please check the calendar for full performance information.")).toBeNull();
    expect(parseShowTime("Doors at 19:00")).toBeNull();
  });

  const run = { startDate: "2026-11-17", endDate: "2026-11-21", bookingUrl: "https://example/book" };

  it("expands a week-long run from its pattern", () => {
    const perfs = buildAtgPerformances(run, { date: "2026-11-17", time: "19:30" }, ["Tue - Sat at 19:30", "Wed, Thu and Sat at 14:30"]);
    expect(perfs.map((p) => `${p.date} ${p.time} ${p.kind}`)).toEqual([
      "2026-11-17 19:30 exact",
      "2026-11-18 14:30 pattern", "2026-11-18 19:30 pattern",
      "2026-11-19 14:30 pattern", "2026-11-19 19:30 pattern",
      "2026-11-20 19:30 pattern",
      "2026-11-21 14:30 pattern", "2026-11-21 19:30 pattern",
    ]);
  });

  it("handles two shows on one day and one-off dates", () => {
    const dirty = buildAtgPerformances({ ...run, startDate: "2026-11-24", endDate: "2026-11-28" }, null,
      ["Tue - Thu and Sat at 19:30", "Fri at 17:00 and 20:30", "Sat at 14:30"]);
    expect(dirty.filter((p) => p.date === "2026-11-27").map((p) => p.time)).toEqual(["17:00", "20:30"]);
    expect(dirty).toHaveLength(7);

    const club = buildAtgPerformances({ ...run, startDate: "2027-12-18", endDate: "2027-12-31" }, null, ["Sat at 20:00", "Fri 31 Dec at 19:00"]);
    expect(club.map((p) => `${p.date} ${p.time}`)).toEqual(["2027-12-18 20:00", "2027-12-25 20:00", "2027-12-31 19:00"]);
  });

  it("marks every day of a run when the times cannot be read", () => {
    const panto = buildAtgPerformances({ ...run, startDate: "2026-12-11", endDate: "2027-01-03" }, { date: "2026-12-11", time: "13:00" },
      ["Please check the calendar for full performance information."]);
    expect(panto).toHaveLength(24);
    expect(panto.every((p) => p.kind === "run" && p.time === null)).toBe(true);
  });

  it("uses the exact first-performance time for a single night, in UK time", () => {
    const show = { startDate: "2027-07-01", endDate: "2027-07-01", bookingUrl: null };
    // 18:00 UTC in July is 19:00 British Summer Time.
    const detail = parseAtgDetail(show, atgDetail({ first: "2027-07-01T18:00:00.000Z", showTimes: ["Thu at 19:00"], min: 12.5 }));
    expect(detail.performances).toEqual([{ date: "2027-07-01", time: "19:00", kind: "exact", bookingUrl: null, note: null }]);
    expect(detail.priceText).toBe("From £12.50");
    expect(londonParts(new Date("2026-11-30T19:00:00.000Z"))).toEqual({ date: "2026-11-30", time: "19:00" });
  });

  it("picks up on-sale and presale times", () => {
    const show = { startDate: "2027-05-15", endDate: "2027-05-15", bookingUrl: null };
    const detail = parseAtgDetail(show, atgDetail({ first: "2027-05-15T18:30:00.000Z", onSaleStart: "2026-11-18T10:00:00.000Z", preSale: "2026-11-17T10:00:00.000Z" }));
    expect(detail.onSaleAt).toBe("2026-11-18T10:00:00.000Z");
    expect(detail.presaleAt).toBe("2026-11-17T10:00:00.000Z");
  });
});

describe("New Vic", () => {
  const today = "2026-11-16";

  it("works out the year from the weekday", () => {
    expect(parseNewVicDates("Wed 18 Nov", today)).toEqual({ start: "2026-11-18", end: "2026-11-18" });
    expect(parseNewVicDates("Fri 13 Nov–Sat 23 Jan", today)).toEqual({ start: "2026-11-13", end: "2027-01-23" });
    expect(parseNewVicDates("Wed 9–Thu 24 Dec", today)).toEqual({ start: "2026-12-09", end: "2026-12-24" });
    expect(parseNewVicDates("Thu 7 Jan", today)).toEqual({ start: "2027-01-07", end: "2027-01-07" });
    expect(parseNewVicDates("Sat 6 Feb–Sat 27 Feb", today)).toEqual({ start: "2027-02-06", end: "2027-02-27" });
  });

  it("reads a listing page (markup captured from the live site)", () => {
    const { shows, next } = parseNewVicListingPage(fixture("newvic-listing.html"), today);
    expect(next).toBe("https://www.newvictheatre.org.uk/whats-on/page/2/");
    expect(shows.map((s) => [s.id, s.title, s.dateText, s.startDate, s.endDate])).toEqual([
      ["newvic:the-borrowers-2", "The Borrowers", "Fri 13 Nov–Sat 23 Jan", "2026-11-13", "2027-01-23"],
      ["newvic:the-manfreds-get-your-kicks-on-tour-26", "The Manfreds: Get Your Kicks On Tour ’26", "Wed 18 Nov", "2026-11-18", "2026-11-18"],
    ]);
    expect(shows[1]!.image).toBe("https://www.newvictheatre.org.uk/wp-content/uploads/2026/06/X_MAN-724x418.jpg");
    expect(shows[1]!.summary).toMatch(/^Join us for an unforgettable evening/);
  });

  it("reads every performance from a production page", () => {
    const detail = parseNewVicDetail(fixture("newvic-production.html"));
    expect(detail.performances.map((p) => `${p.date} ${p.time}`)).toEqual([
      "2026-11-13 19:30", "2026-11-14 19:30", "2026-11-17 10:30", "2027-01-23 14:15",
    ]);
    expect(detail.performances[0]!.bookingUrl).toContain("EventInstanceId=165801");
    expect(detail.performances[0]!.note).toBeNull();
    expect(detail.performances[2]).toMatchObject({ bookingUrl: null, note: "AD · Not bookable online" });
    expect(detail).toMatchObject({ startDate: "2026-11-13", endDate: "2027-01-23", priceText: "£17.50 – £43.50" });
  });

  it("follows the Next link through every page", async () => {
    const base = "https://www.newvictheatre.org.uk/whats-on/";
    const pages: Record<string, string> = {
      [base]: newVicPage([{ slug: "a", title: "A", dates: "Wed 18 Nov" }], `${base}page/2/`),
      [`${base}page/2/`]: newVicPage([{ slug: "b", title: "B", dates: "Thu 7 Jan" }, { slug: "a", title: "A", dates: "Wed 18 Nov" }], `${base}page/3/`),
      [`${base}page/3/`]: newVicPage([{ slug: "c", title: "C", dates: "Sat 6 Feb–Sat 27 Feb" }], null),
    };
    const result = await listNewVic(async (url) => page(pages[url] ?? "", pages[url] ? 200 : 404), today);
    expect(result).toMatchObject({ complete: true, pages: 3, problem: null });
    expect(result.shows.map((s) => s.id)).toEqual(["newvic:a", "newvic:b", "newvic:c"]);
  });

  it("flags a listing that stops part way", async () => {
    const base = "https://www.newvictheatre.org.uk/whats-on/";
    const result = await listNewVic(async (url) =>
      url === base ? page(newVicPage([{ slug: "a", title: "A", dates: "Wed 18 Nov" }], `${base}page/2/`)) : page("", 500), today);
    expect(result.complete).toBe(false);
  });
});
