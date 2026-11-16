// Calendar front end. No framework and no build step: plain DOM, with all text set via textContent.

const VENUES = [
  { id: "regent", label: "Regent Theatre" },
  { id: "victoria-hall", label: "Victoria Hall" },
  { id: "newvic", label: "New Vic" },
];
const NEW_FOR_DAYS = 14;
const MAX_PILLS = 4;

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: carry on without saving */ }
  },
};

const state = {
  today: null,
  month: null, // { y, m } with m from 1 to 12
  hidden: new Set(store.get("hiddenVenues", [])),
  cache: new Map(), // "YYYY-MM" -> calendar data
  feed: null,
  seenEventId: store.get("seenEventId", 0),
  showEarlier: false,
};

// ---------- small helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const toDate = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const fromDate = (d) => ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return fromDate(d); };
const longDay = (s) => toDate(s).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const monthName = ({ y, m }) => new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

function ukDateTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  }).replace(":00", "").replace(/\s(am|pm)/, "$1");
}

function ago(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

function isNew(show) {
  return !show.is_baseline && state.today && show.first_seen.slice(0, 10) >= addDays(state.today, -NEW_FOR_DAYS);
}

function statusLabel(show) {
  if (show.status === "sold_out") return "Sold out";
  if (show.status === "coming_soon") return show.status_text || "On sale soon";
  return null;
}

function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

// ---------- calendar data ----------

/** The Monday on or before the 1st, to the Sunday on or after the last day. */
function gridRange({ y, m }) {
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const start = addDays(fromDate(first), -((first.getDay() + 6) % 7));
  const end = addDays(fromDate(last), 6 - ((last.getDay() + 6) % 7));
  return { start, end };
}

async function loadMonth(month) {
  const key = ymd(month.y, month.m, 1).slice(0, 7);
  if (!state.cache.has(key)) {
    const { start, end } = gridRange(month);
    const data = await api(`/api/calendar?from=${start}&to=${end}`);
    data.showsById = new Map(data.shows.map((s) => [s.id, s]));
    state.cache.set(key, data);
  }
  return state.cache.get(key);
}

/** One entry per show per day, with that day's times gathered together. */
function entriesByDay(data) {
  const days = new Map();
  for (const p of data.performances) {
    const show = data.showsById.get(p.show_id);
    if (!show || state.hidden.has(show.source)) continue;
    if (!days.has(p.date)) days.set(p.date, new Map());
    const day = days.get(p.date);
    if (!day.has(show.id)) day.set(show.id, { show, performances: [] });
    day.get(show.id).performances.push(p);
  }
  const sorted = new Map();
  for (const [date, entries] of days) {
    sorted.set(date, [...entries.values()].sort((a, b) =>
      (a.performances[0].time ?? "99").localeCompare(b.performances[0].time ?? "99") || a.show.title.localeCompare(b.show.title)));
  }
  return sorted;
}

function timesText(entry) {
  const times = entry.performances.map((p) => p.time).filter(Boolean);
  if (times.length === 0) return "Times vary";
  return times.join(" & ");
}

function kindOf(entry) {
  if (entry.performances.some((p) => p.kind === "run")) return "run";
  if (entry.performances.some((p) => p.kind === "pattern")) return "pattern";
  return "exact";
}

// ---------- rendering: calendar ----------

function pill(entry, date) {
  const { show } = entry;
  const kind = kindOf(entry);
  return el("button", {
    type: "button",
    class: `pill v-${show.source} k-${kind}${show.status === "sold_out" ? " sold" : ""}`,
    onclick: (e) => { e.stopPropagation(); openShow(entry, date); },
  },
    el("span", { class: "pill-time", text: kind === "run" ? "All day" : timesText(entry) }),
    el("span", { class: "pill-title", text: show.title }),
    isNew(show) && el("span", { class: "tag tag-new", text: "New" }),
    show.status === "sold_out" && el("span", { class: "tag", text: "Sold out" }),
  );
}

function renderGrid(month, days) {
  const grid = $("grid");
  grid.replaceChildren(...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => el("div", { class: "dow", text: d })));
  const { start, end } = gridRange(month);
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const entries = days.get(date) ?? [];
    const inMonth = Number(date.slice(5, 7)) === month.m;
    const cell = el("div", {
      class: `cell${inMonth ? "" : " other"}${date === state.today ? " is-today" : ""}${date < state.today ? " past" : ""}`,
    },
      el("div", { class: "cell-date", text: String(Number(date.slice(8))) }),
      entries.slice(0, MAX_PILLS).map((e) => pill(e, date)),
      entries.length > MAX_PILLS && el("button", {
        type: "button", class: "more", text: `+${entries.length - MAX_PILLS} more`, onclick: () => openDay(date, entries),
      }),
    );
    grid.append(cell);
  }
}

function renderAgenda(month, days) {
  const agenda = $("agenda");
  const inMonth = [...days.keys()].filter((d) => Number(d.slice(5, 7)) === month.m && Number(d.slice(0, 4)) === month.y).sort();
  // On a phone the list starts at today; earlier days are one tap away.
  const earlier = inMonth.filter((d) => d < state.today);
  const dates = state.showEarlier ? inMonth : inMonth.filter((d) => d >= state.today);
  const nodes = [];
  if (earlier.length > 0 && !state.showEarlier) {
    nodes.push(el("button", {
      type: "button", class: "earlier", text: `Show ${earlier.length} earlier ${earlier.length === 1 ? "day" : "days"}`,
      onclick: () => { state.showEarlier = true; renderCalendar(); },
    }));
  }
  if (dates.length === 0) nodes.push(el("p", { class: "empty", text: inMonth.length ? "Nothing more listed this month." : "Nothing listed for this month yet." }));
  for (const date of dates) {
    nodes.push(el("section", { class: `agenda-day${date === state.today ? " is-today" : ""}${date < state.today ? " past" : ""}`, id: `day-${date}` },
      el("h3", { text: longDay(date) + (date === state.today ? " · Today" : "") }),
      days.get(date).map((e) => pill(e, date)),
    ));
  }
  agenda.replaceChildren(...nodes);
}

async function renderCalendar() {
  $("month-title").textContent = monthName(state.month);
  let data;
  try {
    data = await loadMonth(state.month);
  } catch {
    notice("Couldn't load the calendar. Check your connection and try again.");
    return;
  }
  notice("");
  state.today = data.today;
  const days = entriesByDay(data);
  renderGrid(state.month, days);
  renderAgenda(state.month, days);
  $("grid").hidden = false;
}

function renderFilters() {
  $("filters").replaceChildren(...VENUES.map((v) =>
    el("button", {
      type: "button", class: `chip v-${v.id}`, "aria-pressed": String(!state.hidden.has(v.id)),
      onclick: () => {
        if (state.hidden.has(v.id)) state.hidden.delete(v.id); else state.hidden.add(v.id);
        store.set("hiddenVenues", [...state.hidden]);
        renderFilters();
        renderCalendar();
      },
    }, el("span", { class: "chip-box", "aria-hidden": "true" }), el("span", { text: v.label }))));
}

function shiftMonth(by) {
  const d = new Date(state.month.y, state.month.m - 1 + by, 1);
  state.month = { y: d.getFullYear(), m: d.getMonth() + 1 };
  state.showEarlier = false;
  renderCalendar();
}

// ---------- dialogs ----------

function showDialog(...content) {
  const dialog = $("dialog");
  $("dialog-body").replaceChildren(
    el("button", { type: "button", class: "close", "aria-label": "Close", text: "×", onclick: () => dialog.close() }),
    ...content.flat().filter(Boolean),
  );
  if (!dialog.open) dialog.showModal();
}

function showCard(show, dayEntry, date) {
  const book = safeUrl(show.booking_url);
  const info = safeUrl(show.url);
  const image = safeUrl(show.image);
  const status = statusLabel(show);
  const kind = dayEntry ? kindOf(dayEntry) : null;
  const onSale = ukDateTime(show.on_sale_at);
  const presale = ukDateTime(show.presale_at);
  const dayBooking = dayEntry?.performances.map((p) => safeUrl(p.booking_url)).find(Boolean);
  const notes = dayEntry ? [...new Set(dayEntry.performances.map((p) => p.note).filter(Boolean))] : [];

  return [
    image && el("img", { class: "show-image", src: image, alt: "", loading: "lazy", onerror: (e) => e.target.remove() }),
    el("p", { class: `venue v-${show.source}`, text: show.venue + (show.genre ? ` · ${show.genre}` : "") }),
    el("h2", { id: "dialog-title", text: show.title }),
    el("p", { class: "tags" },
      isNew(show) && el("span", { class: "tag tag-new", text: "New" }),
      status && el("span", { class: `tag${show.status === "coming_soon" ? " tag-soon" : ""}`, text: status }),
    ),
    dayEntry && el("p", { class: "when" },
      el("strong", { text: longDay(date) }),
      el("span", { text: ` · ${timesText(dayEntry)}` }),
    ),
    kind === "pattern" && el("p", { class: "caveat", text: "This time comes from the venue's weekly pattern for the run. Check the booking page before you travel." }),
    kind === "run" && el("p", { class: "caveat", text: "The show is running on this date, but the venue hasn't published times in a form this app can read. See the booking page." }),
    notes.length > 0 && el("p", { class: "caveat", text: notes.join(" · ") }),
    el("dl", { class: "facts" },
      el("dt", { text: "Dates" }), el("dd", { text: show.date_text }),
      show.times_text && [el("dt", { text: "Times" }), el("dd", { text: show.times_text })],
      show.price_text && [el("dt", { text: "Tickets" }), el("dd", { text: show.price_text })],
      show.status === "coming_soon" && onSale && [el("dt", { text: "On sale" }), el("dd", { text: onSale })],
      show.status === "coming_soon" && presale && [el("dt", { text: "Presale" }), el("dd", { text: presale })],
    ),
    show.summary && el("p", { class: "summary", text: show.summary }),
    el("p", { class: "actions" },
      (dayBooking || book) && show.status !== "sold_out" && el("a", {
        class: "button primary", href: dayBooking || book, target: "_blank", rel: "noopener",
        text: show.status === "coming_soon" ? "Booking page" : "Book tickets",
      }),
      info && el("a", { class: "button", href: info, target: "_blank", rel: "noopener", text: "Venue page" }),
    ),
  ];
}

function openShow(entry, date) {
  showDialog(...showCard(entry.show, entry, date));
}

function openDay(date, entries) {
  showDialog(
    el("h2", { id: "dialog-title", text: longDay(date) }),
    el("div", { class: "day-list" }, entries.map((e) => pill(e, date))),
  );
}

// ---------- rendering: new & on sale ----------

const EVENT_LABEL = { new_show: "New show", on_sale: "Now on sale", back_on_sale: "Tickets available again", sold_out: "Sold out" };

/** A show card: a label, the title, then label and value pairs, like an index card. */
function feedItem(show, label, fields, unseen) {
  return el("li", { class: unseen ? "unseen" : "" },
    el("button", { type: "button", class: `feed-item v-${show.source}`, onclick: () => showDialog(...showCard(show, null, null)) },
      el("span", { class: "feed-head" },
        el("span", { class: "feed-label", text: label }),
        unseen && el("span", { class: "tag tag-new", text: "New" }),
      ),
      el("span", { class: "feed-title", text: show.title }),
      el("dl", { class: "feed-facts" },
        fields.filter(([, value]) => value).map(([name, value]) => el("div", {}, el("dt", { text: name }), el("dd", { text: value }))),
      ),
      el("span", { class: "feed-more", text: "View show" }),
    ));
}

function renderFeed() {
  const { events, comingSoon } = state.feed;
  $("feed").replaceChildren(...(events.length
    ? events.map((e) => feedItem(e, EVENT_LABEL[e.type] ?? e.type, [
        ["Venue", e.venue],
        ["Dates", e.date_text],
        ["Tickets", e.type === "new_show" ? statusLabel(e) : null],
        ["Spotted", ago(e.created_at)],
      ], e.event_id > state.seenEventId))
    : [el("li", { class: "empty", text: "Nothing new yet. New shows will appear here as soon as a venue lists them." })]));
  $("soon").replaceChildren(...(comingSoon.length
    ? comingSoon.map((s) => feedItem(s, s.venue, [
        ["Dates", s.date_text],
        ["On sale", ukDateTime(s.on_sale_at) ?? (s.status_text || "Soon")],
        ["Presale", ukDateTime(s.presale_at)],
      ], false))
    : [el("li", { class: "empty", text: "No upcoming on-sale dates at the moment." })]));
}

function renderAlert() {
  const unseen = state.feed.events.filter((e) => e.event_id > state.seenEventId && e.type !== "sold_out");
  $("new-count").hidden = unseen.length === 0;
  $("new-count").textContent = String(unseen.length);
  $("alert").hidden = unseen.length === 0;
  if (unseen.length === 0) return;
  const names = unseen.slice(0, 3).map((e) => e.title).join(", ");
  $("alert").textContent = `${unseen.length} new since your last visit: ${names}${unseen.length > 3 ? "…" : ""}`;
}

function renderChecked() {
  const sync = state.feed.lastSync;
  if (!sync) {
    $("checked").textContent = "Waiting for the first check of the venues.";
    return;
  }
  const problems = sync.sources.filter((s) => !s.complete);
  $("checked").textContent = `Venues checked ${ago(sync.at)}` +
    (problems.length ? `. Couldn't fully read: ${problems.map((s) => VENUES.find((v) => v.id === s.source)?.label ?? s.source).join(", ")}` : "");
  $("checked").classList.toggle("warn", problems.length > 0);
}

function showView(name) {
  const isNewView = name === "new";
  $("view-calendar").hidden = isNewView;
  $("view-new").hidden = !isNewView;
  $("tab-calendar").setAttribute("aria-pressed", String(!isNewView));
  $("tab-new").setAttribute("aria-pressed", String(isNewView));
  if (isNewView && state.feed) {
    renderFeed(); // drawn before marking as seen, so unseen items are highlighted this once
    const latest = Math.max(state.seenEventId, ...state.feed.events.map((e) => e.event_id));
    state.seenEventId = latest;
    store.set("seenEventId", latest);
    renderAlert();
  }
}

// ---------- notifications ----------

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function setupPush() {
  const button = $("notify");
  const help = $("push-help");
  const say = (text) => { help.textContent = text; };
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  if (!supported) {
    say(isIos && !installed
      ? "For phone notifications on iPhone: tap Share, then Add to Home Screen, and open the app from there."
      : "This browser doesn't support notifications. New shows will still be flagged here.");
    return;
  }
  const { key } = await api("/api/push/key").catch(() => ({ key: null }));
  if (!key) {
    say("Phone notifications aren't set up on the server yet (see the README). New shows are still flagged here.");
    return;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  const refresh = async () => {
    const sub = await registration.pushManager.getSubscription();
    button.hidden = false;
    button.textContent = sub ? "Notifications on" : "Turn on notifications";
    button.classList.toggle("on", Boolean(sub));
    say(sub ? "You'll get a notification when a new show is announced or tickets go on sale. Tap the button again to turn them off."
            : "Turn on notifications to hear about new shows the moment a venue lists them.");
    return sub;
  };

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        await api("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: existing.endpoint }) });
        await existing.unsubscribe();
      } else {
        if ((await Notification.requestPermission()) !== "granted") {
          say("Notifications are blocked for this site. Allow them in your browser settings, then try again.");
          return;
        }
        const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
        const result = await api("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub) });
        if (result.test !== "sent") notice("Subscribed, but the test notification didn't send. Check the server's push keys.");
      }
      await refresh();
    } catch {
      notice("Couldn't change notifications just now. Please try again.");
    } finally {
      button.disabled = false;
    }
  });
  await refresh();
}

// ---------- start ----------

async function start() {
  const now = new Date();
  state.today = fromDate(now);
  state.month = { y: now.getFullYear(), m: now.getMonth() + 1 };

  $("prev").addEventListener("click", () => shiftMonth(-1));
  $("next").addEventListener("click", () => shiftMonth(1));
  $("today").addEventListener("click", () => {
    const t = toDate(state.today);
    state.month = { y: t.getFullYear(), m: t.getMonth() + 1 };
    renderCalendar().then(() => document.getElementById(`day-${state.today}`)?.scrollIntoView({ block: "start" }));
  });
  $("tab-calendar").addEventListener("click", () => showView("calendar"));
  $("tab-new").addEventListener("click", () => showView("new"));
  $("alert").addEventListener("click", () => showView("new"));
  $("dialog").addEventListener("click", (e) => { if (e.target === $("dialog")) $("dialog").close(); });

  renderFilters();
  const calendarReady = renderCalendar();
  try {
    state.feed = await api("/api/feed");
    renderChecked();
    renderFeed();
    renderAlert();
  } catch {
    $("checked").textContent = "Couldn't load the latest changes.";
    state.feed = { events: [], comingSoon: [], lastSync: null };
  }
  await calendarReady;
  if (new URLSearchParams(location.search).get("view") === "new") showView("new");
  setupPush().catch(() => {});
}

start();
