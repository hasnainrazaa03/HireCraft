/**
 * What to fill, and how to recognise it.
 *
 * Deliberately keyed on the field's *label* rather than on per-ATS selectors.
 * Two of the three ATSs we target render their forms client-side, so there is no
 * stable markup to pin to, and a selector map would break silently the next time
 * any of them ships a release. A label is the one thing a form must get right —
 * it is what a human reads to know what the box wants — so matching it is both
 * more durable and works partway on sites nobody has written an adapter for.
 *
 * Order matters: the first entry whose pattern matches a control claims it, so
 * the specific ("first name") must precede the general ("name").
 */

// Regexes are matched against a normalised label: lowercase, collapsed
// whitespace, punctuation stripped, and any trailing "required"/"*" removed.
const FIELDS = [
  {
    key: "first_name",
    label: "First name",
    from: (p) => p.first_name,
    match: [/^first\s*name$/, /^given\s*name$/, /^legal\s*first\s*name$/, /\bfirst\s*name\b/],
  },
  {
    key: "last_name",
    label: "Last name",
    from: (p) => p.last_name,
    match: [/^last\s*name$/, /^family\s*name$/, /^surname$/, /^legal\s*last\s*name$/, /\blast\s*name\b/],
  },
  {
    key: "full_name",
    label: "Full name",
    from: (p) => p.full_name,
    // Bare "name" only as a whole label: "company name" and "school name" are
    // different questions and must not be answered with the candidate's name.
    match: [/^full\s*name$/, /^name$/, /^your\s*name$/, /^preferred\s*name$/],
  },
  {
    key: "email",
    label: "Email",
    from: (p) => p.email,
    match: [/\bemail\b/, /\be-?mail\s*address\b/],
    type: "email",
  },
  {
    key: "phone",
    label: "Phone",
    from: (p) => p.phone,
    match: [/\bphone\b/, /\bmobile\b/, /\btelephone\b/, /\bcell\b/],
    type: "tel",
  },
  {
    key: "location",
    label: "Location",
    from: (p) => p.location,
    match: [/^location$/, /\bcurrent\s*location\b/, /^city\b/, /\bcity,?\s*state\b/, /\bwhere\s+are\s+you\s+located\b/],
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    from: (p) => p.linkedin,
    match: [/\blinked\s*in\b/],
  },
  {
    key: "github",
    label: "GitHub",
    from: (p) => p.github,
    match: [/\bgit\s*hub\b/],
  },
  {
    key: "portfolio",
    label: "Portfolio",
    from: (p) => p.portfolio || p.website,
    match: [/\bportfolio\b/, /\bpersonal\s*(site|website)\b/],
  },
  {
    key: "website",
    label: "Website",
    from: (p) => p.website || p.portfolio,
    // Generic "website" last, so a LinkedIn or portfolio field claims itself
    // first; several forms label every URL box "Website".
    match: [/^website$/, /\bwebsite\s*url\b/, /^url$/, /^other\s*url$/],
  },
  {
    key: "years_experience",
    label: "Years of experience",
    from: (p) => (p.years_experience == null ? "" : String(p.years_experience)),
    match: [/\byears\s*(of)?\s*(relevant\s*)?experience\b/, /\bhow\s*many\s*years\b/],
  },
];

/**
 * Labels we recognise and deliberately leave alone.
 *
 * Voluntary self-identification is the candidate's to answer, and HireCraft
 * holds no data for it — filling a default would be inventing an answer to a
 * question about their race, gender, disability or veteran status. Salary is
 * excluded too: a stored range is a preference, not a number to commit to on an
 * employer's form without looking.
 */
const SKIP = [
  // Plurals are explicit: \b after "pronoun" does not match "pronouns", and
  // "What are your pronouns?" is exactly how the question is usually written.
  /\b(races?|ethnicit(y|ies)|genders?|sex|pronouns?)\b/,
  /\bdisabilit(y|ies)\b/,
  /\bveterans?\b/,
  /\bhispanic\b/,
  /\bsexual\s*orientation\b/,
  /\bdate\s*of\s*birth\b/,
  /\b(salary|compensation)\s*(expectation|requirement|range)?\b/,
  /\bdesired\s*(salary|pay|compensation)\b/,
];

/** A file input we should attach the résumé to. */
// Labels are accent-folded before matching (see fill.js `normalise`), so the
// ASCII spelling covers "Résumé" too.
const RESUME_FILE = [/\bresume\b/, /\bcv\b/, /\bupload\s*(your)?\s*resume\b/];

// Attached to window so the content script can read them; MV3 content scripts
// share one scope per frame but are not modules.
window.HIRECRAFT_FIELDS = FIELDS;
window.HIRECRAFT_SKIP = SKIP;
window.HIRECRAFT_RESUME_FILE = RESUME_FILE;
