CREATE TABLE shows (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  venue TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  booking_url TEXT,
  image TEXT,
  genre TEXT,
  summary TEXT,
  date_text TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_text TEXT,
  on_sale_at TEXT,
  presale_at TEXT,
  price_text TEXT,
  times_text TEXT,
  perf_hash TEXT,
  is_baseline INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  removed_at TEXT,
  detail_fetched_at TEXT,
  detail_error TEXT
);
CREATE INDEX idx_shows_source ON shows (source);

CREATE TABLE performances (
  show_id TEXT NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time TEXT,
  kind TEXT NOT NULL,
  booking_url TEXT,
  note TEXT
);
CREATE INDEX idx_performances_date ON performances (date);
CREATE INDEX idx_performances_show ON performances (show_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  show_id TEXT NOT NULL REFERENCES shows (id) ON DELETE CASCADE,
  detail TEXT,
  created_at TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
