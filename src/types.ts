export type SourceId = "regent" | "victoria-hall" | "newvic";

export type ShowStatus = "on_sale" | "sold_out" | "coming_soon" | "unknown";

/**
 * How sure we are about a performance:
 *  - exact:   the venue lists this date and time
 *  - pattern: worked out from the venue's weekly pattern ("Tue - Sat at 19:30")
 *  - run:     the show is running on this date, but the time is not known
 */
export type PerformanceKind = "exact" | "pattern" | "run";

export interface Performance {
  date: string; // YYYY-MM-DD, UK local date
  time: string | null; // HH:MM, UK local time
  kind: PerformanceKind;
  bookingUrl: string | null;
  note: string | null;
}

/** What a venue's "what's on" listing tells us about a show. */
export interface ListedShow {
  id: string;
  source: SourceId;
  venue: string;
  title: string;
  url: string;
  bookingUrl: string | null;
  image: string | null;
  genre: string | null;
  summary: string | null;
  dateText: string;
  startDate: string | null;
  endDate: string | null;
  status: ShowStatus;
  statusText: string | null;
}

/** Extra information from a show's own page. */
export interface ShowDetail {
  startDate: string | null;
  endDate: string | null;
  onSaleAt: string | null;
  presaleAt: string | null;
  priceText: string | null;
  timesText: string | null;
  summary: string | null;
  performances: Performance[];
}

export interface ListingResult {
  shows: ListedShow[];
  /** True only when every page was read and the count matches what the venue reports. */
  complete: boolean;
  pages: number;
  reportedTotal: number | null;
  problem: string | null;
}

export type PageFetcher = (url: string) => Promise<Response>;
