/**
 * Working out which employer and which role a page is about.
 *
 * Harder than it sounds, because the page is hosted by an applicant tracking
 * system rather than by the employer, so nothing in the hostname helps. The
 * first guess was the URL's first path segment, which gave "applied" for
 * Applied Intuition and "point72" for Point72 — a tracker row you cannot find
 * by searching for the company you applied to.
 *
 * Kept as pure functions over already-extracted strings so they can be tested
 * against the real titles these boards produce, without a DOM.
 */

/** Tidy a name: collapse whitespace, drop trailing punctuation, cap the length. */
function clean(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s|·—–-]+|[\s|·—–-]+$/g, "")
    .slice(0, 120)
    .trim();
}

/**
 * The company named in a page title, if one is.
 *
 * Only the separators that actually mean "at this employer" are trusted. A
 * hyphen or a pipe is used both ways round — "Zoox - ML Engineer" and "ML
 * Engineer - Zoox" are both common — so guessing from those would be right half
 * the time, which is worse than not guessing.
 */
function companyFromTitle(title) {
  const text = clean(title);
  if (!text) return "";

  // "Job Application for <role> at <Company>" — Greenhouse.
  const application = /\bjob application for\b.*?\bat\s+(.+)$/i.exec(text);
  if (application) return clean(application[1]);

  // "<role> @ <Company>" — Ashby, and several others.
  const at = /\s@\s+(.+)$/.exec(text);
  if (at) return clean(at[1]);

  // "<role> at <Company>" where the tail is short enough to be a name rather
  // than the rest of a sentence.
  const plain = /\s+at\s+([^,|]{2,60})$/i.exec(text);
  if (plain) return clean(plain[1]);

  return "";
}

/**
 * The employer, from whichever source knows.
 *
 * Ordered by how much each one is actually a statement about the employer.
 * Structured data is the page saying so outright; a site name is close; a title
 * is a convention; a path segment is a guess, and is only reached when nothing
 * else spoke.
 */
function companyFrom({ jsonLd = "", siteName = "", title = "", pathSegment = "", host = "" } = {}) {
  const structured = clean(jsonLd);
  if (structured) return structured;

  const site = clean(siteName);
  // Some boards set og:site_name to their own name rather than the employer's.
  if (site && !/greenhouse|lever|ashby|workday|smartrecruiters|icims|workable/i.test(site)) {
    return site;
  }

  const fromTitle = companyFromTitle(title);
  if (fromTitle) return fromTitle;

  const segment = clean(String(pathSegment).replace(/[-_]+/g, " "));
  if (segment) {
    // Capitalise it, since a slug is lowercase and a tracker row is read by a
    // person. "point72" stays "Point72"; "general matter" becomes "General
    // Matter". A slug with no separators cannot be split reliably, so it is
    // left as one word rather than guessed at.
    return segment.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return clean(String(host).replace(/^www\./, "").split(".")[0]);
}

/**
 * The role, from a page title.
 *
 * The mirror of the above: strip the employer off the end rather than keep it.
 */
function roleFromTitle(title) {
  const text = clean(title);
  if (!text) return "";

  const application = /\bjob application for\s+(.+?)\s+at\s+.+$/i.exec(text);
  if (application) return clean(application[1]);

  const at = /^(.+?)\s@\s+.+$/.exec(text);
  if (at) return clean(at[1]);

  const plain = /^(.+?)\s+at\s+[^,|]{2,60}$/i.exec(text);
  if (plain) return clean(plain[1]);

  // Otherwise the first segment, which is the role far more often than not.
  return clean(text.split(/\s[|·–—]\s/)[0]);
}

window.HIRECRAFT_POSTING = { companyFrom, companyFromTitle, roleFromTitle, clean };
