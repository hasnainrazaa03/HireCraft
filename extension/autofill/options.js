/**
 * Choosing the right entry from a list of options the page defines.
 *
 * A dropdown is not a text box, and the difference is the whole problem. Typing
 * "M.S. in Computer Science" into a degree box that only offers "Master's
 * Degree" leaves the form both wrong and looking answered, and typing "3.67"
 * into a box offering "3.6 - 4.0" does the same. Neither is a matching failure
 * the user can see, which is why they have to be handled here rather than left
 * to chance.
 *
 * The approach is to canonicalise *both sides* and compare. Rather than teach
 * the matcher that "M.S." should find "Master's Degree", both strings are
 * reduced to the token `master` and compared directly. That works no matter
 * which of the dozen spellings each side happens to use, and it means adding a
 * new phrasing helps in both directions at once.
 *
 * The most important return value is "no match". A form asking which years you
 * attended, offering only 2023-2026 / 2020-2023 / Before 2020, has no answer
 * for someone graduating in 2027 — and the right behaviour is to say so, not to
 * pick the closest-looking one. A wrong answer on a required question is worse
 * than an empty one, because an empty one gets noticed.
 */

/**
 * Lowercase, unaccented, punctuation closed up so "M.S." reads as "ms".
 *
 * A period between two digits is kept. Closing those up too turned "3.67" into
 * "367" and "3.6 - 4.0" into "36 - 40", which silently disabled every numeric
 * comparison below — the GPA question this was written for would have gone on
 * failing, in a new way.
 */
function normText(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/(?<!\d)\.(?!\d)/g, "")
    .replace(/[^\w\s.+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The level of a degree, from either a résumé's phrasing or a form's.
 *
 * Ordered most-specific first: "Master of Business Administration" must reach
 * the master rule, and an MBA is a master's degree wherever it is asked about.
 */
const DEGREE_LEVELS = [
  ["mba", [/\bmba\b/, /\bmaster of business administration\b/]],
  ["jd", [/\bjd\b/, /\bjuris doctor\b/]],
  ["md", [/\bmd\b/, /\bdoctor of medicine\b/]],
  ["doctorate", [/\bphd\b/, /\bph d\b/, /\bdoctor/, /\bdphil\b/, /\bscd\b/, /\bedd\b/]],
  ["master", [/\bmaster/, /\bms\b/, /\bmsc\b/, /\bmeng\b/, /\bma\b/, /\bmfa\b/, /\bmph\b/, /\bllm\b/]],
  ["bachelor", [/\bbachelor/, /\bbs\b/, /\bbsc\b/, /\bba\b/, /\bbeng\b/, /\bbtech\b/, /\bbba\b/, /\bab\b/]],
  ["associate", [/\bassociate/, /\baa\b/, /\bas\b/, /\baas\b/]],
  ["high_school", [/\bhigh school\b/, /\bged\b/, /\bsecondary\b/, /\bdiploma\b/]],
];

/**
 * What a specific degree falls back to when the form is less specific.
 *
 * A form offering "Master of Business Administration" should get the MBA, but
 * one offering only "Master's Degree" should still be answered rather than left
 * blank. Kept one step wide: a JD broadens to a doctorate, never to a master's.
 */
const BROADER = { mba: "master", jd: "doctorate", md: "doctorate" };

function degreeLevel(text) {
  const t = normText(text);
  if (!t) return null;
  for (const [level, patterns] of DEGREE_LEVELS) {
    if (patterns.some((re) => re.test(t))) return level;
  }
  return null;
}

/** Does this option mean "I'd rather not say"? Offered on every EEOC question. */
function isDecline(text) {
  const t = normText(text);
  return (
    /\bdecline\b/.test(t) ||
    /\b(do not|dont|don t)\s+(wish|want)\b/.test(t) ||
    /\bprefer\s+not\b/.test(t) ||
    /\bnot\s+(wish|want)\s+to\s+(answer|disclose|identify)\b/.test(t) ||
    /\bself\s*identify\b/.test(t) && /\bdecline|not\b/.test(t)
  );
}

/**
 * The EEOC answers, canonicalised.
 *
 * Each function reads a piece of option text and returns the token it means, so
 * a stored token can be compared against every option on the page regardless of
 * how that particular employer worded it. `decline` is checked first throughout:
 * "I don't wish to answer" mentions no category, but several decline options do
 * ("Decline to self-identify as a protected veteran") and would otherwise be
 * mistaken for the category itself.
 */
const EEO = {
  gender(text) {
    if (isDecline(text)) return "decline";
    const t = normText(text);
    if (/\bnon\s*binary\b|\bnonbinary\b|\bgenderqueer\b/.test(t)) return "non_binary";
    // "male" does not match inside "female": there is no word boundary between
    // the e and the m, so the anchors do the work without extra ordering rules.
    if (/\bfemale\b|\bwoman\b/.test(t)) return "female";
    if (/\bmale\b|\bman\b/.test(t)) return "male";
    return null;
  },

  race_ethnicity(text) {
    if (isDecline(text)) return "decline";
    const t = normText(text);
    if (/\btwo or more\b/.test(t)) return "two_or_more";
    if (/\bhispanic\b|\blatino\b|\blatinx\b/.test(t)) return "hispanic";
    if (/\bnative hawaiian\b|\bpacific islander\b/.test(t)) return "native_hawaiian";
    if (/\bamerican indian\b|\balaska/.test(t)) return "american_indian";
    if (/\bblack\b|\bafrican american\b/.test(t)) return "black";
    if (/\basian\b/.test(t)) return "asian";
    if (/\bwhite\b|\bcaucasian\b/.test(t)) return "white";
    return null;
  },

  hispanic_latino(text) {
    if (isDecline(text)) return "decline";
    return EEO._yesNo(text);
  },

  veteran_status(text) {
    if (isDecline(text)) return "decline";
    const t = normText(text);
    // Both real answers contain "protected veteran", so the negation is the
    // whole signal and has to be tested before the affirmative.
    if (/\b(not|am not|no)\b[^.]*\bprotected veteran\b/.test(t)) return "not_protected";
    if (/\bidentify as\b|\bone or more\b|\byes\b/.test(t)) return "protected";
    return null;
  },

  disability_status(text) {
    if (isDecline(text)) return "decline";
    const t = normText(text);
    if (/\bno\b|\bdo not have\b|\bdont have\b/.test(t)) return "no";
    if (/\byes\b|\bi have\b/.test(t)) return "yes";
    return null;
  },

  _yesNo(text) {
    const t = normText(text);
    if (/^no\b|\bno i\b|\bdo not\b|\bdont\b|\bnot\b/.test(t)) return "no";
    if (/^yes\b|\byes\b|\bi am\b|\bi do\b/.test(t)) return "yes";
    return null;
  },
};

/**
 * A numeric range written as option text, or null if it isn't one.
 *
 * Open ends are tracked rather than nudged by one, because "Before 2020" and
 * "2020 or under" differ exactly at 2020 and a form that offers both means
 * different things by them.
 */
function parseRange(text) {
  const t = normText(text);
  // "6 months - 1 year" names two units in one range and cannot be read as a
  // single span. Refusing it is better than picking one unit and being wrong by
  // a factor of twelve.
  const units = unitsIn(t);
  if (units.length > 1) return null;
  const unit = units[0] || null;
  // No leading sign: form ranges are never negative, and allowing one made
  // "2023-2026" read its second number as -2026.
  const num = /\d+(?:\.\d+)?/g;
  const found = (t.match(num) || []).map(Number);

  // "3.6 - 4.0", "2023-2026", "3.6 to 4.0"
  if (found.length >= 2 && /\d\s*(?:-|to|–|—)\s*\d/.test(t)) {
    return { lo: found[0], hi: found[1], loOpen: false, hiOpen: false, unit };
  }
  if (found.length !== 1) return null;
  const n = found[0];

  if (/\bbefore\b|\bprior to\b|\bearlier than\b|\bless than\b|\bunder\b(?!\s*$)/.test(t) &&
      !/\bor\b/.test(t)) {
    return { lo: -Infinity, hi: n, loOpen: false, hiOpen: true, unit };
  }
  if (/\bor\s*(under|below|less|fewer|earlier)\b|\bor\s*younger\b/.test(t)) {
    return { lo: -Infinity, hi: n, loOpen: false, hiOpen: false, unit };
  }
  if (/\bafter\b|\bmore than\b|\bgreater than\b|\bover\b/.test(t)) {
    return { lo: n, hi: Infinity, loOpen: true, hiOpen: false, unit };
  }
  if (/\bor\s*(above|over|more|later|greater|higher)\b|\+\s*$/.test(t)) {
    return { lo: n, hi: Infinity, loOpen: false, hiOpen: false, unit };
  }
  return null;
}

/** How long a unit is, in years — the base every duration is compared in. */
const UNIT_YEARS = { year: 1, month: 1 / 12, week: 1 / 52, day: 1 / 365 };

/** Every distinct time unit named in a piece of text. */
function unitsIn(text) {
  const found = new Set();
  for (const m of normText(text).matchAll(/\b(years?|yrs?|months?|mos?|weeks?|days?)\b/g)) {
    const w = m[1];
    found.add(
      w[0] === "y" ? "year" : w[0] === "m" ? "month" : w[0] === "w" ? "week" : "day"
    );
  }
  return [...found];
}

function rangeHas(range, n) {
  const aboveLo = n > range.lo || (!range.loOpen && n === range.lo);
  const belowHi = n < range.hi || (!range.hiOpen && n === range.hi);
  return aboveLo && belowHi;
}

const rangeWidth = (r) => (r.hi === Infinity || r.lo === -Infinity ? Infinity : r.hi - r.lo);

/** The single number in a value, if that is all it is. */
function asNumber(value) {
  const t = normText(value);
  const m = /^\d+(?:\.\d+)?$/.exec(t);
  return m ? Number(m[0]) : null;
}

const tokens = (text) => new Set(normText(text).split(" ").filter(Boolean));

/**
 * Pick the option that answers `want`, or report that none does.
 *
 * `kind` names the question when it is one we understand specially — a degree,
 * a GPA, one of the EEOC four. Everything else falls through to text matching,
 * which handles the ordinary cases (a country list, a "Yes"/"No" pair) without
 * needing to be told anything.
 *
 * Returns `{index, why}`. A negative index always carries a reason, because the
 * caller has to be able to tell the user what happened.
 */
function chooseOption(want, optionTexts, { kind = null, unit = null } = {}) {
  const options = optionTexts.map((t) => String(t ?? ""));
  if (!options.length) return { index: -1, why: "the list was empty" };

  const target = normText(want);
  if (!target) return { index: -1, why: "nothing stored for this" };

  // 1. The value is already one of the options.
  const exact = options.findIndex((o) => normText(o) === target);
  if (exact >= 0) return { index: exact, why: "exact match" };

  // 2. A question we understand: canonicalise both sides and compare tokens.
  if (kind && EEO[kind]) {
    const hit = options.findIndex((o) => EEO[kind](o) === target);
    if (hit >= 0) return { index: hit, why: `matched "${options[hit]}"` };
    return { index: -1, why: `no option means "${want}"` };
  }
  if (kind === "degree") {
    const level = degreeLevel(want);
    if (level) {
      let hit = options.findIndex((o) => degreeLevel(o) === level);
      if (hit < 0 && BROADER[level]) {
        hit = options.findIndex((o) => degreeLevel(o) === BROADER[level]);
      }
      if (hit >= 0) return { index: hit, why: `${level} → "${options[hit]}"` };
    }
  }

  // 3. Numeric value against options written as ranges. The narrowest
  //    containing range wins, so an explicit "3.6 - 4.0" beats a catch-all.
  const n = asNumber(want);
  if (n !== null) {
    let best = -1;
    let bestWidth = Infinity;
    options.forEach((o, i) => {
      let range = parseRange(o);
      if (!range) return;
      if (range.unit) {
        // The options are measured in something. Without knowing what the
        // stored value is measured in, there is no honest comparison to make —
        // "2.5" against "Less than 6 months" silently read as a match, and 2.5
        // years is not less than six months.
        if (!unit) return;
        const scale = UNIT_YEARS[range.unit] / (UNIT_YEARS[unit] ?? 1);
        range = { ...range, lo: range.lo * scale, hi: range.hi * scale };
      }
      // `best < 0` first: an open-ended range has infinite width, and
      // comparing that against the initial Infinity excluded it forever.
      if (rangeHas(range, n) && (best < 0 || rangeWidth(range) < bestWidth)) {
        best = i;
        bestWidth = rangeWidth(range);
      }
    });
    if (best >= 0) return { index: best, why: `${n} falls in "${options[best]}"` };
    // Every option is a range and the value is in none of them. This is a real
    // answer — the form does not accommodate this person — and saying so is the
    // entire point of the function.
    if (options.some((o) => parseRange(o))) {
      return { index: -1, why: `${n} is outside every option offered` };
    }
  }

  // 4. Containment, longest option first so "United States" beats "United".
  const byLength = options
    .map((o, i) => ({ o: normText(o), i }))
    .filter(({ o }) => o && (o === target || o.includes(target) || target.includes(o)))
    .sort((a, b) => b.o.length - a.o.length);
  if (byLength.length) return { index: byLength[0].i, why: `matched "${options[byLength[0].i]}"` };

  // 5. Word overlap, as a last resort and only when most of the value is there.
  const wantTokens = tokens(want);
  if (wantTokens.size) {
    let best = -1;
    let bestScore = 0;
    options.forEach((o, i) => {
      const has = [...wantTokens].filter((t) => tokens(o).has(t)).length;
      const score = has / wantTokens.size;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    if (bestScore >= 0.6) return { index: best, why: `matched "${options[best]}"` };
  }

  return { index: -1, why: `no option matched "${want}"` };
}

window.HIRECRAFT_OPTIONS = {
  normText,
  degreeLevel,
  isDecline,
  EEO,
  parseRange,
  rangeHas,
  chooseOption,
};
