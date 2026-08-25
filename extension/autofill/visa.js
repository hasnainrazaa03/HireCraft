/**
 * Read the posting on this page and say whether it will sponsor a visa.
 *
 * A deliberate port of backend/app/services/sponsorship.py rather than a call
 * to it: the extension runs on postings that are not in the feed — a link from
 * a friend, a company's own careers page — and those have no row to look up. A
 * check that only worked for jobs HireCraft already knew about would miss the
 * ones the reader most needs it for.
 *
 * The two rules that matter, both learned from real postings:
 *
 *   Silence is not a refusal. Three postings in five say nothing about
 *   sponsorship, and reading that as a "no" would condemn most of the market.
 *
 *   A blocker outranks an offer. A posting whose benefits mention sponsorship
 *   and whose qualifications demand a clearance is closed, and the clearance is
 *   the operative fact.
 */

const VISA = {
  CLEARANCE: "clearance_required",
  CITIZENSHIP: "citizenship_required",
  NONE: "no_sponsorship",
  SPONSORS: "sponsors",
  UNSTATED: "unstated",
};

const CLEARANCE_RE =
  /\b(?:(?:active|current|existing|must\s+(?:possess|hold|have))[^.\n]{0,40}\bclearance\b|\bsecurity\s+clearance\b|\bTS\s*\/\s*SCI\b|\btop\s+secret\b|\bsecret\s+clearance\b|\bpolygraph\b)/i;

const CITIZENSHIP_RE =
  /\b(?:(?:U\.?\s?S\.?|United\s+States)\s+(?:citizen(?:ship)?|person)s?|must\s+be\s+a\s+(?:U\.?\s?S\.?|United\s+States)\s+citizen|\bITAR\b|export[- ]control(?:led|s)?\s+(?:laws?|regulations?|requirements?)|(?:green\s+card|permanent\s+resident)\s*(?:holder)?s?\s*(?:only|required)|lawful\s+permanent\s+resident)/i;

// The gap allows newlines and abbreviation periods: a refusal often runs from
// "may not be able to" through "certain U.S. visa categories" before reaching
// the word "sponsorship", and page text carries line breaks mid-sentence.
const NO_RE =
  /(?:(?:will\s+not|won'?t|cannot|can\s?not|unable\s+to|does\s+not|do\s+not|(?:may|are|is)\s+not\s+(?:\w+\s+)?(?:be\s+)?able\s+to)(?:[^.]|\.(?=\s*[a-z0-9])){0,200}\bsponsor|\bno\s+(?:visa\s+)?sponsorship\b|without\s+(?:visa\s+)?sponsorship|sponsorship\s+is\s+not\s+(?:available|offered|provided)|sponsorship[^.\n:]{0,24}[:\-=]\s*(?:no|none)\b)/i;

// The bare verb never counts: "you will sponsor internal initiatives" is a
// description of the job, not an offer of a visa.
const SPONSORS_RE =
  /(?:(?:will|do|does|can|are\s+able\s+to|happy\s+to|glad\s+to)\s+sponsor\b[^.\n]{0,45}\b(?:visas?|employment|work\s+authoriz|immigration|H-?1B|green\s+card)|sponsor\s+(?:employment\s+|work\s+)?visas?|(?:visa|employment|immigration)\s+sponsorship\s+(?:is\s+)?(?:available|offered|provided|supported)|sponsorship\s+(?:is\s+)?(?:available|offered|provided|supported)|(?:offer|provide)s?\s+(?:visa\s+|employment\s+)?sponsorship|take\s+over\s+sponsorship|\bH-?1B\s+(?:sponsorship|transfer)s?)/i;

const NEGATED_RE = /\b(?:not|cannot|can\s?not|won'?t|unable|neither|nor|without|no)\b/i;
const FIELD_NO_RE = /^\s*[:\-=]\s*(?:no|none)\b|^\s*[:\-=]\s*(?:#|\n|$)/i;
const SENTENCE_END_RE = /[.!?]\s+(?=[A-Z])/g;

// Bounded, because sentence detection is unreliable on a page: a benefits
// bullet list carries no terminal punctuation, so an unbounded look-back finds
// a "not" hundreds of characters away that has nothing to do with the offer.
const NEGATION_WINDOW = 140;

function sentenceBefore(text, index) {
  let start = 0;
  SENTENCE_END_RE.lastIndex = 0;
  let match;
  while ((match = SENTENCE_END_RE.exec(text)) && match.index < index) {
    start = match.index + match[0].length;
  }
  return text.slice(Math.max(start, index - NEGATION_WINDOW), index);
}

/** The posting text on this page, as plainly as we can get it. */
function pageText() {
  const container =
    document.querySelector(
      "[class*='job-description'], [class*='jobDescription'], [data-testid*='jobDescription'], " +
        "[data-automation-id='jobPostingDescription'], [class*='_description'], " +
        "[data-qa='job-description'], main, article"
    ) || document.body;
  return (container.innerText || "").slice(0, 40000);
}

/**
 * Classify the posting on this page.
 *
 * Returns {verdict, evidence}. The evidence is the sentence that decided it,
 * because a verdict the reader cannot check is one they have to take on trust.
 */
function classifyVisa(text) {
  const body = text == null ? pageText() : text;
  if (!body) return { verdict: VISA.UNSTATED, evidence: "" };

  const checks = [
    [CLEARANCE_RE, VISA.CLEARANCE],
    [CITIZENSHIP_RE, VISA.CITIZENSHIP],
    [NO_RE, VISA.NONE],
    [SPONSORS_RE, VISA.SPONSORS],
  ];

  for (const [regex, verdict] of checks) {
    const global = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
    let match;
    while ((match = global.exec(body))) {
      if (verdict === VISA.SPONSORS) {
        const negated =
          NEGATED_RE.test(sentenceBefore(body, match.index)) ||
          FIELD_NO_RE.test(body.slice(match.index + match[0].length, match.index + match[0].length + 26));
        if (negated) continue; // an apparent offer inside a refusal
      }
      const from = Math.max(0, match.index - 90);
      const to = Math.min(body.length, match.index + match[0].length + 110);
      return { verdict, evidence: body.slice(from, to).replace(/\s+/g, " ").trim() };
    }
  }
  return { verdict: VISA.UNSTATED, evidence: "" };
}

/** How a verdict should read to someone who needs sponsorship. */
function visaLabel(verdict) {
  switch (verdict) {
    case VISA.SPONSORS:
      return { text: "Sponsors visas", tone: "ok", blocks: false };
    case VISA.NONE:
      return { text: "Won't sponsor", tone: "warn", blocks: true };
    case VISA.CITIZENSHIP:
      return { text: "US citizens only", tone: "bad", blocks: true };
    case VISA.CLEARANCE:
      return { text: "Security clearance required", tone: "bad", blocks: true };
    default:
      return { text: "Sponsorship not mentioned", tone: "quiet", blocks: false };
  }
}

window.HIRECRAFT_VISA = { classifyVisa, visaLabel, pageText, VISA };
