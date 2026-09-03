/**
 * What the job feed remembers between visits.
 *
 * Filters are a statement about what you are looking for, and that does not
 * change between one visit and the next — but the page reset every one of them
 * on load, so the same five clicks were needed each time before the list meant
 * anything. Skips are the same argument from the other side: a role you have
 * ruled out stays ruled out.
 *
 * Kept in localStorage rather than on the server. It is a per-device
 * convenience, it must survive being absent or corrupt without taking the page
 * with it, and nothing here is worth a round trip.
 */

const FILTERS_KEY = "hirecraft.feed.filters";
const SKIPPED_KEY = "hirecraft.feed.skipped";

export type FeedFilters = {
  bucket: string;
  level: string;
  source: string;
  location: string;
  remote: boolean;
  minScore: number;
  postedWithin: number;
  degree: string;
  visa: string;
  query: string;
  sort: string;
};

export const DEFAULT_FILTERS: FeedFilters = {
  bucket: "",
  level: "",
  source: "",
  location: "",
  remote: false,
  minScore: 0,
  postedWithin: 0,
  // The two the feed is opinionated about, and the ones a master's candidate
  // needing sponsorship would set by hand on every visit otherwise.
  degree: "masters_eligible",
  visa: "open",
  query: "",
  sort: "match",
};

/**
 * Everything a fresh install starts with narrowing off.
 *
 * Distinct from DEFAULT_FILTERS, and the difference matters. The two the feed
 * is opinionated about — degree and visa — are the right *starting* point for a
 * master's candidate who needs sponsorship, and they are also, quietly,
 * hiding postings. "Clear all" has to mean everything, or it is a button that
 * claims to stop filtering while two filters stay on.
 */
export const NOTHING_HIDDEN: FeedFilters = {
  ...DEFAULT_FILTERS,
  degree: "any",
  visa: "any",
};

/**
 * Which filters are narrowing the list right now.
 *
 * Anything that hides a posting counts, including the two that are on by
 * default. Whether a filter was chosen or inherited makes no difference to the
 * question being asked, which is "am I seeing everything?" — and the honest
 * answer on arrival is no.
 */
export function activeFilters(f: FeedFilters): { key: keyof FeedFilters; label: string }[] {
  const out: { key: keyof FeedFilters; label: string }[] = [];
  if (f.bucket) out.push({ key: "bucket", label: f.bucket });
  if (f.level) out.push({ key: "level", label: f.level.replace(/_/g, " ") });
  if (f.source) out.push({ key: "source", label: f.source });
  if (f.location) out.push({ key: "location", label: f.location });
  if (f.remote) out.push({ key: "remote", label: "Remote only" });
  if (f.minScore) out.push({ key: "minScore", label: `Match ≥ ${f.minScore}%` });
  if (f.postedWithin) out.push({ key: "postedWithin", label: `Posted ≤ ${f.postedWithin}d` });
  if (f.degree !== "any") out.push({ key: "degree", label: `Degree: ${f.degree.replace(/_/g, " ")}` });
  if (f.visa !== "any") out.push({ key: "visa", label: `Visa: ${f.visa.replace(/_/g, " ")}` });
  if (f.query.trim()) out.push({ key: "query", label: `“${f.query.trim()}”` });
  return out;
}

/** One filter off — for the × on a summary chip. */
export function withoutFilter(f: FeedFilters, key: keyof FeedFilters): FeedFilters {
  return { ...f, [key]: NOTHING_HIDDEN[key] } as FeedFilters;
}

export function loadFilters(): FeedFilters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    // Spread over the defaults rather than trusting the stored shape: a filter
    // added since this was written would otherwise arrive undefined and be sent
    // to the API as the string "undefined".
    return { ...DEFAULT_FILTERS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function saveFilters(f: FeedFilters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(f));
  } catch {
    /* private window, or storage full — the page works either way */
  }
}

export function loadSkipped(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SKIPPED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export function saveSkipped(ids: Set<string>): void {
  try {
    // Capped, oldest first. An unbounded list of everything ever passed over
    // would grow for as long as the feed is used, and the far end of it stops
    // mattering long before it stops costing.
    localStorage.setItem(SKIPPED_KEY, JSON.stringify([...ids].slice(-500)));
  } catch {
    /* as above */
  }
}
