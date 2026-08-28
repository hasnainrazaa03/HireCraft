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
    // Split camelCase before anything else. Greenhouse's compliance questions
    // arrive labelled "VeteranStatus" and "DisabilityStatus" with no separator,
    // so \bveterans?\b found no word boundary and both went unanswered — the
    // two questions this whole self-identification feature exists for.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
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

/**
 * Abbreviations that are only safe to read with their dots still on.
 *
 * "B.E." is a Bachelor of Engineering, and the résumé says exactly that — but
 * normText drops the dots, and `\bbe\b` against the result would read "Degree
 * to be awarded" as a bachelor's. So these are matched before normalising and
 * every pattern requires a literal dot, which prose does not have.
 *
 * Left out of the list below rather than added to it, because that list is
 * matched against the employer's option text too, where the words are spelled
 * out and these would only add risk.
 */
/**
 * Each pattern is bounded on both sides by "not a letter and not a dot".
 *
 * Without the left bound, `b\.\s*a\.?` finds "B.A." inside "M.B.A." and reads a
 * Master of Business Administration as a bachelor's — which the first version
 * of this did, on the very test written to stop degrees collapsing into each
 * other.
 */
const EDGE = "(?<![A-Za-z.])";
const DOTTED_LEVELS = [
  [new RegExp(`${EDGE}b\\.\\s*e\\.?(?![A-Za-z])`, "i"), "bachelor"],
  [new RegExp(`${EDGE}b\\.\\s*tech\\.?(?![A-Za-z])`, "i"), "bachelor"],
  [new RegExp(`${EDGE}b\\.\\s*sc?\\.?(?![A-Za-z])`, "i"), "bachelor"],
  [new RegExp(`${EDGE}b\\.\\s*a\\.?(?![A-Za-z])`, "i"), "bachelor"],
  [new RegExp(`${EDGE}b\\.\\s*com\\.?(?![A-Za-z])`, "i"), "bachelor"],
  [new RegExp(`${EDGE}m\\.\\s*e\\.?(?![A-Za-z])`, "i"), "master"],
  [new RegExp(`${EDGE}m\\.\\s*tech\\.?(?![A-Za-z])`, "i"), "master"],
  [new RegExp(`${EDGE}m\\.\\s*sc?\\.?(?![A-Za-z])`, "i"), "master"],
  [new RegExp(`${EDGE}m\\.\\s*a\\.?(?![A-Za-z])`, "i"), "master"],
  [new RegExp(`${EDGE}m\\.\\s*com\\.?(?![A-Za-z])`, "i"), "master"],
];

function degreeLevel(text) {
  const t = normText(text);
  if (!t) return null;
  // The spelled-out list first. It is the one matched against the employer's
  // own option text, where the words are written out, and running it first
  // means the dotted patterns below are only ever reached by a string that
  // named no degree in words — which is what a résumé's "B.E." is.
  for (const [level, patterns] of DEGREE_LEVELS) {
    if (patterns.some((re) => re.test(t))) return level;
  }
  const raw = String(text || "");
  for (const [pattern, level] of DOTTED_LEVELS) {
    if (pattern.test(raw)) return level;
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
    // Parenthetical qualifiers are dropped first. Lever writes every option as
    // "Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)" and so
    // on, so a hispanic check reading the whole string claims all of them — and
    // an Asian applicant would be recorded as Hispanic or Latino on an EEO
    // form. Hispanic is then tested last, so even an unparenthesised negation
    // loses to a named race.
    const t = normText(String(text ?? "").replace(/\([^)]*\)/g, " "));
    if (/\btwo or more\b/.test(t)) return "two_or_more";
    if (/\bnative hawaiian\b|\bpacific islander\b/.test(t)) return "native_hawaiian";
    if (/\bamerican indian\b|\balaska/.test(t)) return "american_indian";
    if (/\bblack\b|\bafrican american\b/.test(t)) return "black";
    if (/\basian\b/.test(t)) return "asian";
    if (/\bwhite\b|\bcaucasian\b/.test(t)) return "white";
    if (/\bhispanic\b|\blatino\b|\blatinx\b/.test(t)) return "hispanic";
    return null;
  },

  hispanic_latino(text) {
    if (isDecline(text)) return "decline";
    return EEO._yesNo(text);
  },

  veteran_status(text) {
    if (isDecline(text)) return "decline";
    const t = normText(text);
    // The negation is the whole signal: every answer here, affirmative or not,
    // is built on the word "veteran". Anchored on that word alone rather than
    // on "protected veteran", because boards differ — Greenhouse offers "I am
    // not a protected veteran" while Lever offers plain "I am not a veteran",
    // and the second matched nothing at all.
    if (/\b(not|no)\b[^.]{0,60}\bveterans?\b/.test(t)) return "not_protected";
    if (/\bveterans?\b|\bidentify as\b|\bone or more\b/.test(t)) return "protected";
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
 * What a spelled-out work-authorisation option means.
 *
 * Some forms ask "are you authorized to work in the US?" as yes/no; others
 * replace it with a list of sentences — "I am authorized to work in the United
 * States for any employer", "I require sponsorship to work in the United
 * States", and so on. A stored "Yes" matches none of those, so the question was
 * reported unanswerable on every form that words it the second way.
 *
 * Nothing is inferred here that is not already stored. Authorisation and
 * sponsorship are held as two separate answers precisely because they are
 * independent, and together they name exactly one sentence in this list — this
 * only translates them into the vocabulary a given form uses.
 */
function workAuthOption(text) {
  const t = normText(text);
  if (/\bnot authorized\b|\bnot legally authorized\b/.test(t)) return "not_authorized";
  if (/\bunknown\b|\bnot sure\b|\bunsure\b/.test(t)) return "unknown";
  if (/\brequires?\b[^.]{0,40}\bsponsorship\b|\bneed\b[^.]{0,40}\bsponsorship\b/.test(t)) {
    return "needs_sponsorship";
  }
  if (/\bpresent employer only\b|\bcurrent employer only\b/.test(t)) return "present_employer_only";
  if (/\bauthorized\b/.test(t)) return "any_employer";
  return null;
}

/**
 * What an agreement option means.
 *
 * These are worded as "I agree" at least as often as "Yes", and a stored "Yes"
 * matches neither the wording nor any part of it — Reddit's form offers exactly
 * one option, reading "I agree", and nothing generic would ever find it.
 */
function consentOption(text) {
  const t = normText(text);
  if (/^no\b|\bi\s*do\s*not\s*(agree|consent|accept)\b|\bdecline\b|\bdisagree\b/.test(t)) {
    return "no";
  }
  if (/^yes\b|^agree\b|^accept\b|\bi\s*(agree|accept|acknowledge|consent|certify|confirm)\b/.test(t)) {
    return "yes";
  }
  return null;
}

/** US state abbreviations, so "CA" and "California" are the same answer. */
const US_STATES = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", dc: "district of columbia",
  fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois",
  in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana",
  me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan",
  mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana",
  ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey",
  nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota",
  oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania",
  ri: "rhode island", sc: "south carolina", sd: "south dakota", tn: "tennessee",
  tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
  wv: "west virginia", wi: "wisconsin", wy: "wyoming", pr: "puerto rico",
};

/**
 * A place, split into city and region.
 *
 * Split on commas *before* normalising, because normalising drops the commas —
 * and the commas are the only thing separating a city from its state.
 */
function placeParts(text) {
  const parts = String(text ?? "")
    .split(",")
    .map((piece) => normText(piece))
    .filter(Boolean);
  if (!parts.length) return null;
  const after = parts.slice(1);
  return {
    city: parts[0],
    region: after[0] ? US_STATES[after[0]] || after[0] : "",
    all: parts,
  };
}

/**
 * Match a place by its parts rather than as a string.
 *
 * Generic string matching cannot do this, and produced a different wrong city
 * each time it was tuned. Ranking by longest gave "East Los Angeles,
 * California" for "Los Angeles, CA"; ranking by least-extra then gave "Los
 * Ángeles, Campeche, Mexico", because "los angeles ca" really is a prefix of
 * "los angeles campeche mexico" and that option is the shorter of the two. The
 * abbreviation is the whole problem: nothing about the characters says "CA" is
 * a state in one reading and the first half of "Campeche" in the other.
 *
 * So the city must match outright, and where a region is known it must match
 * too. A city of the same name in another state or country is a different
 * place, and returning nothing is the correct answer — putting the wrong city
 * on an application is not a near miss.
 */
function matchPlace(want, options) {
  const wanted = placeParts(want);
  if (!wanted?.city) return { index: -1, why: `could not read "${want}" as a place` };

  const sameCity = options
    .map((text, index) => ({ index, place: placeParts(text) }))
    .filter(({ place }) => place && place.city === wanted.city);

  if (!sameCity.length) return { index: -1, why: `no option is "${wanted.city}"` };
  if (!wanted.region) {
    return { index: sameCity[0].index, why: `matched "${options[sameCity[0].index]}"` };
  }

  const sameRegion = sameCity.filter(
    ({ place }) => place.region === wanted.region || place.all.includes(wanted.region)
  );
  if (sameRegion.length) {
    return { index: sameRegion[0].index, why: `matched "${options[sameRegion[0].index]}"` };
  }
  return {
    index: -1,
    why: `found ${wanted.city} but not in ${wanted.region} — pick this one yourself`,
  };
}

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
function chooseOption(want, optionTexts, { kind = null, unit = null, context = null } = {}) {
  const options = optionTexts.map((t) => String(t ?? ""));
  if (!options.length) return { index: -1, why: "the list was empty" };

  const target = normText(want);
  if (!target) return { index: -1, why: "nothing stored for this" };

  // 1. The value is already one of the options.
  const exact = options.findIndex((o) => normText(o) === target);
  if (exact >= 0) return { index: exact, why: "exact match" };

  // 2c. An agreement, which is as often worded "I agree" as "Yes".
  if (kind === "consent") {
    const hit = options.findIndex((o) => consentOption(o) === target);
    if (hit >= 0) return { index: hit, why: `matched "${options[hit]}"` };
    return { index: -1, why: `no option means "${want}"` };
  }

  // 2b. A place. Handled apart from everything below because a city and its
  //     state cannot be compared as one string — see matchPlace.
  if (kind === "location") return matchPlace(want, options);

  // 2d. A state, which is stored abbreviated and listed in full.
  //
  //     Left to the generic matching below, "CA" is a substring of California,
  //     North Carolina and South Carolina alike, and which of the three came
  //     back would be down to the ranking rather than to the answer. The
  //     abbreviation is not a prefix of anything, it is a name for it.
  if (kind === "state") {
    const full = US_STATES[target] || target;
    const hit = options.findIndex((o) => normText(o) === full);
    if (hit >= 0) return { index: hit, why: `${want} → "${options[hit]}"` };
    // The other direction, for a list that offers the abbreviations.
    const short = Object.keys(US_STATES).find((code) => US_STATES[code] === full);
    const abbreviated = short && options.findIndex((o) => normText(o) === short);
    if (abbreviated >= 0) return { index: abbreviated, why: `matched "${options[abbreviated]}"` };
    return { index: -1, why: `no option means "${want}"` };
  }

  // 2a. A work-authorisation list written as sentences rather than yes/no.
  if (kind === "work_authorization" && context) {
    const wanted = !context.authorized
      ? "not_authorized"
      : context.sponsorship
        ? "needs_sponsorship"
        : "any_employer";
    const hit = options.findIndex((o) => workAuthOption(o) === wanted);
    if (hit >= 0) return { index: hit, why: `matched "${options[hit]}"` };
    // Fall through to the plain yes/no path below, which is the other way this
    // question gets asked.
  }

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

  // 4. Containment. The best of the options that contain the value is the one
  //    carrying the least extra material, and a match at the start beats one
  //    buried in the middle.
  //
  //    Ranking by longest — the previous rule — is backwards: a longer option
  //    containing the value has *more* that is not the value. Asked for
  //    "Los Angeles, CA" against a city list, it answered "East Los Angeles,
  //    California, United States" while "Los Angeles, California, United
  //    States" sat two rows above it.
  const contained = [];
  options.forEach((raw, i) => {
    const o = normText(raw);
    if (!o) return;
    if (o === target || o.includes(target) || target.includes(o)) {
      const aligned = o.startsWith(target) || target.startsWith(o) ? 0 : 1;
      contained.push({ i, aligned, extra: Math.abs(o.length - target.length) });
    }
  });
  if (contained.length) {
    contained.sort((a, b) => a.aligned - b.aligned || a.extra - b.extra);
    const best = contained[0].i;
    return { index: best, why: `matched "${options[best]}"` };
  }

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
  workAuthOption,
  consentOption,
  placeParts,
  matchPlace,
  degreeLevel,
  isDecline,
  EEO,
  parseRange,
  rangeHas,
  chooseOption,
};
