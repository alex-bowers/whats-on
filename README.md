# What's On in Stoke

A Cloudflare Worker that checks the Regent Theatre, Victoria Hall and New Vic every 30 minutes, keeps
every show in a D1 database, serves a calendar of what is on each night, and tells you when a new
show is listed or tickets go on sale.

## What it does

- **Reads every page** of each venue's listing, not just the first. For the two ATG venues it checks
  the number of shows collected against the total the venue reports, so a missed page is reported as a
  problem instead of being silently ignored.
- **Calendar** with a month grid on wide screens and a day-by-day list on phones. Filter by venue.
- **New-show alerts** as a banner and a "New & on sale" tab in the app, and as push notifications to
  your phone or computer if you turn them on.
- **On-sale dates**: shows that are announced but not yet on sale are listed with their on-sale and
  presale times.

## How accurate the times are

| Venue | Source | Accuracy |
|---|---|---|
| New Vic | Each production page lists every performance | Exact date and time for every performance |
| Regent / Victoria Hall, one-night shows | Listing + show details feed | Exact date and time |
| Regent / Victoria Hall, multi-night runs | Weekly pattern, e.g. "Tue - Sat at 19:30" | Worked out from the pattern; shown with a dashed edge |
| Regent / Victoria Hall, runs with no readable pattern (e.g. panto) | Date range only | Shown on every day of the run with no time; dotted edge |

ATG's exact per-performance calendar comes from a separate service this app does not use. For
multi-night ATG runs, always confirm the time on the booking page.

## Set up

You need Node 20 or newer and a Cloudflare account (the free plan is enough).

```sh
npm install
npx wrangler login

# 1. Create the database, then paste the database_id it prints into wrangler.jsonc
npx wrangler d1 create whats-on-stoke
npm run db:migrate

# 2. Push notification keys (optional, but needed for phone alerts)
npm run vapid
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
#    also set VAPID_SUBJECT in wrangler.jsonc to "mailto:" followed by your email address

# 3. A token for triggering a check by hand (any long random string)
npx wrangler secret put ADMIN_TOKEN

# 4. Deploy
npm run deploy
```

The first check runs within 30 minutes of deploying. To run it straight away:

```sh
curl -X POST -H "Authorization: Bearer YOUR_ADMIN_TOKEN" https://YOUR-WORKER-URL/api/admin/sync
```

Every show appears on the calendar after the first check. Exact times and on-sale dates fill in over
the next few checks, because each run reads at most 25 individual show pages (`DETAIL_BUDGET`) to stay
inside the free plan's limit on outbound requests. Call the sync endpoint a few times in a row to
speed that up.

Everything found on the first check is treated as the starting point. Alerts begin with the first
show that appears after that.

### Phone notifications

Open the app on your phone and tap **Turn on notifications**. On iPhone, first add the app to your
home screen (Share, then Add to Home Screen) and open it from there; iOS only allows notifications for
installed web apps.

## Run it locally

```sh
cp .dev.vars.example .dev.vars      # fill in values if you want push or the admin endpoint
npm run db:migrate:local
npm run dev
# in another terminal, trigger a check:
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
```

`npm test` runs the scraper tests and a full sync against a local database using sample pages.
`npm run typecheck` checks types. Run `npm run types` after changing `wrangler.jsonc`.

## Settings (`wrangler.jsonc`)

| Setting | Default | Meaning |
|---|---|---|
| `triggers.crons` | every 30 minutes | How often the venues are checked |
| `DETAIL_BUDGET` | 25 | Show pages read per run. Keep at 25 or below on the free plan |
| `DETAIL_MAX_AGE_HOURS` | 24 | How often each show's own page is re-read |
| `ATG_DETAILS` | true | Set to "false" to stop using ATG's show-details feed (see below) |
| `VAPID_SUBJECT` | placeholder | Contact address sent to push services |

## Things to know

- **These are scrapers.** If a venue redesigns its site, that venue stops updating until the parser in
  `src/scrape/` is adjusted. The header of the app shows when the venues were last checked and names
  any venue that could not be read in full. A failed or partial read never removes shows.
- **ATG show details** (start times, weekly pattern, on-sale dates, prices) come from the JSON feed
  that ATG's own show pages load in the browser (`boltapi.atgtickets.com`). It is not a documented
  public API and could change or be restricted. With `ATG_DETAILS` set to "false" the app uses only
  the public listing pages: you still get every show, its dates, and sold-out and on-sale labels.
- **Be considerate.** The Worker identifies itself in its User-Agent and makes roughly 35 requests
  every 30 minutes across both sites. Check each site's terms of use before running it, and don't
  shorten the schedule much.
- **Not yet tried from Cloudflare.** The parsers were checked against the live sites from a normal
  browser. Either site could treat requests from Cloudflare's network differently; if so, the app
  header will say which venue could not be read.
- **Availability at the New Vic** is not published on its site, so sold-out status is only shown for
  the two ATG venues.

## Layout

```
src/index.ts          Worker entry: API routes and the scheduled check
src/sync.ts           One check: listings, changes, show pages, notifications
src/scrape/atg.ts     Regent Theatre and Victoria Hall
src/scrape/newvic.ts  New Vic
src/push.ts           Web push (encryption and VAPID) on Web Crypto
public/               The calendar app, service worker and icons
migrations/           Database schema
test/                 Tests and sample pages
```

## Adding another venue

Write a module in `src/scrape/` that returns a `ListingResult` (and optionally a `ShowDetail` per
show), add its id to `SourceId` in `src/types.ts` and to `SOURCES` in `src/sync.ts`, and add it to
`VENUES` in `public/app.js` with a colour in `public/styles.css`.
