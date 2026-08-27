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
    key: "preferred_name",
    label: "Preferred name",
    from: (p) => p.preferred_name || p.first_name,
    // Checked before the legal name: a form that asks specifically for a
    // preferred name must not receive the name on someone's documents.
    match: [/^preferred\s*(first\s*)?name$/, /\bpreferred\s*name\b/, /\bgo(es)?\s*by\b/, /\bnickname\b/],
  },
  {
    key: "first_name",
    label: "First name",
    from: (p) => p.legal_first_name || p.first_name,
    match: [/^first\s*name$/, /^given\s*name$/, /^legal\s*first\s*name$/, /\bfirst\s*name\b/],
  },
  {
    key: "last_name",
    label: "Last name",
    from: (p) => p.legal_last_name || p.last_name,
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
    // Narrow, because Workday's phone block is four boxes and only one of them
    // wants a number: Country Phone Code, Phone Device Type, Phone Number and
    // Phone Extension all contain the word "phone". A bare \bphone\b matched
    // the country code first, typed a US number into it, and claimed the field
    // — leaving Phone Number, which is required, empty.
    match: [
      /^phone$/, /^phone\s*number$/, /\bphone\s*number\b/,
      /^mobile$/, /\bmobile\s*(phone|number)\b/,
      /^telephone\b/, /^cell\s*(phone|number)?$/,
      /\bprimary\s*phone\b/, /\bhome\s*phone\b/,
    ],
    type: "tel",
  },
  {
    key: "city",
    label: "City",
    // Before the general location field, and deliberately narrow. A box inside
    // an address section wants the city alone; Greenhouse's "Location (City)"
    // is a place picker that wants the whole thing, and it falls through to
    // `location` below because none of these match it.
    from: (p) => p.city,
    match: [/\baddress\s*(section\s*)?city\b/, /^city$/, /\bcity\s*name\b/, /^town$/],
  },
  {
    key: "state",
    label: "State",
    from: (p) => p.state,
    match: [
      /\baddress\s*(section\s*)?(state|region|province)\b/,
      /^state\b/, /^province\b/, /^region\b/, /^state\s*\/?\s*province\b/,
    ],
  },
  {
    key: "location",
    label: "Location",
    // A place is matched by its parts, not as a string: "Los Angeles, CA"
    // against a worldwide city list is otherwise a coin toss between the right
    // answer, East Los Angeles, and Los Ángeles in Campeche.
    kind: "location",
    from: (p) => p.location,
    // "Location (City)" normalises to "location city", which none of the
    // original anchored patterns matched — the field sat empty on the first
    // real form this was tried on.
    match: [
      /^location\b/, /\bcurrent\s*location\b/, /^city\b/, /\bcity\b/,
      /\bwhere\s+are\s+you\s+(currently\s+|presently\s+)?(located|based)\b/,
      /\bcurrently\s+(located|based)\b/, /^town\b/,
    ],
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
    key: "country",
    label: "Country",
    from: (p) => p.country,
    match: [/^country$/, /\bcountry\b/],
  },
  {
    key: "school",
    label: "School",
    from: (p) => p.education?.school,
    // "institution" is not anchored on its own: an H-1B question ending "…other
    // than a cap exempt institution?" matched it, and the filler tried to
    // answer a yes/no with a university name.
    match: [
      /^school$/, /\bschool\s*name\b/, /\buniversity\b/, /\bcollege\b/,
      // Ashby labels its school picker with a placeholder, "Search schools…".
      /\bsearch\s*schools?\b/, /^schools?$/,
      /^institution$/, /\beducational\s*institution\b/, /\binstitution\s*name\b/,
    ],
  },
  {
    key: "degree",
    label: "Degree",
    // Named so the matcher reduces both sides to a level: a résumé says "M.S.
    // in Computer Science" where the form offers "Master's Degree", and neither
    // string contains the other.
    kind: "degree",
    from: (p) => p.education?.degree,
    match: [/^degree$/, /\bdegree\s*(type|level|earned)\b/, /\bhighest\s*degree\b/],
  },
  {
    key: "field_of_study",
    label: "Field of study",
    from: (p) => p.education?.field_of_study,
    match: [/\bfield\s*of\s*study\b/, /\bmajor$/, /\bdiscipline\b/, /\bcourse\s*of\s*study\b/],
  },
  {
    key: "start_year",
    label: "Start year",
    from: (p) => p.education?.start_year,
    match: [/\bstart\s*date\s*year\b/, /^start\s*year$/, /\bfrom\s*year\b/, /^start\s*date\s*$/],
  },
  {
    key: "end_year",
    label: "End year",
    from: (p) => p.education?.end_year,
    match: [/\bend\s*date\s*year\b/, /^end\s*year$/, /\bto\s*year\b/, /\bgraduation\s*year\b/],
  },
  {
    key: "end_month",
    label: "End month",
    from: (p) => p.education?.end_month,
    match: [/\bend\s*date\s*month\b/, /^end\s*month$/, /\bgraduation\s*month\b/],
  },
  {
    key: "start_month",
    label: "Start month",
    from: (p) => p.education?.start_month,
    match: [/\bstart\s*date\s*month\b/, /^start\s*month$/],
  },
  {
    key: "still_student",
    label: "Still a student",
    kind: "consent",
    // A checkbox beside the end date. Answered from the dates rather than
    // asked: a December 2027 end has not happened yet.
    from: (p) => (p.education?.is_current == null ? "" : p.education.is_current ? "yes" : "no"),
    match: [/\bstill\s*(a\s*)?student\b/, /\bcurrently\s*(a\s*)?student\b/, /\bcurrently\s*enrolled\b/],
  },
  {
    key: "graduation_year",
    label: "Graduation year",
    from: (p) => p.education?.end_year,
    match: [
      /\bgraduat\w*\s*(date|year)\b/, /\byear\s*(did|of)\s*.*graduat/,
      /\bwhat\s*year\s*did\s*you\s*graduate\b/, /\bexpected\s*graduation\b/,
    ],
  },
  {
    key: "gpa",
    label: "GPA",
    from: (p) => p.education?.gpa,
    match: [/\bgpa\b/, /\bgrade\s*point\s*average\b/],
  },
  {
    key: "authorized_to_work",
    label: "Authorized to work in the US",
    // Only answered from a stored decision. `undefined` leaves the question
    // alone: an empty box an employer asks about is far better than a wrong
    // answer to a question about someone's right to work.
    from: (p) =>
      p.authorized_to_work == null ? "" : p.authorized_to_work ? "Yes" : "No",
    // Where a form spells the answers out instead of offering yes/no, the two
    // stored booleans together pick exactly one sentence. Both must be
    // answered, or this falls back to plain yes/no matching.
    kind: "work_authorization",
    context: (p) =>
      p.authorized_to_work == null || p.requires_sponsorship == null
        ? null
        : { authorized: p.authorized_to_work, sponsorship: p.requires_sponsorship },
    match: [
      /\b(legally\s*)?authoriz(ed|ation)\s*to\s*work\b/,
      /\beligible\s*to\s*work\b/,
      /\bwork\s*authoriz/,
      /\blegally\s*(be\s*)?employed\b/,
    ],
  },
  {
    key: "requires_sponsorship",
    label: "Requires sponsorship",
    from: (p) =>
      p.requires_sponsorship == null ? "" : p.requires_sponsorship ? "Yes" : "No",
    // Listed after the authorization question because several forms word this
    // one as "…require sponsorship for employment visa status", which contains
    // "sponsorship" and "employment" both.
    match: [
      /\brequire\s*(visa\s*)?sponsorship\b/,
      /\bneed\s*sponsorship\b/,
      /\bsponsorship\b.*\b(now|future|employment)\b/,
      /\b(now|future)\b.*\bsponsorship\b/,
      /\bvisa\s*sponsorship\b/,
    ],
  },
  {
    key: "hispanic_latino",
    label: "Hispanic/Latino",
    kind: "hispanic_latino",
    // Before the race question: a form that asks both wants this one answered
    // from the yes/no, while a combined "Race/Ethnicity" dropdown carries
    // "Hispanic or Latino" as one of its options and belongs to the next entry.
    from: (p) => p.self_identification?.hispanic_latino || "",
    whenEmpty: "set it once in Career Profile → Self-identification",
    match: [/\bhispanic\b/, /\blatino\b/, /\blatinx\b/],
  },
  {
    key: "race_ethnicity",
    label: "Race/ethnicity",
    kind: "race_ethnicity",
    from: (p) => p.self_identification?.race_ethnicity || "",
    whenEmpty: "set it once in Career Profile → Self-identification",
    match: [/\braces?\b/, /\bethnicit(y|ies)\b/, /\bracial\b/],
  },
  {
    key: "gender",
    label: "Gender",
    kind: "gender",
    from: (p) => p.self_identification?.gender || "",
    whenEmpty: "set it once in Career Profile → Self-identification",
    match: [/\bgenders?\b/, /^sex$/],
  },
  {
    key: "military_service",
    label: "Military service",
    kind: "hispanic_latino",
    // Listed before the veteran question so "Have you served in the military?"
    // is answered from the service answer rather than from the EEOC category.
    // They are genuinely different: "protected veteran" carries conditions a
    // person who served may not meet, so neither answer follows from the other.
    from: (p) => p.self_identification?.military_service || "",
    whenEmpty: "set it once in Career Profile → Self-identification",
    match: [
      /\b(have\s*you\s*)?(ever\s*)?served\s*(in\s*)?(the\s*)?(us\s*|u\s*s\s*)?(armed\s*forces|military)\b/,
      /\bmilitary\s*service\b/,
      /\barmed\s*forces\b/,
    ],
  },
  {
    key: "veteran_status",
    label: "Veteran status",
    kind: "veteran_status",
    from: (p) => p.self_identification?.veteran_status || "",
    whenEmpty: "set it once in Career Profile → Self-identification",
    match: [/\bveterans?\b/, /\bprotected\s*veteran\b/],
  },
  {
    key: "disability_status",
    label: "Disability status",
    kind: "disability_status",
    from: (p) => p.self_identification?.disability_status || "",
    whenEmpty: "set it once in Career Profile → Self-identification",
    match: [/\bdisabilit(y|ies)\b/],
  },
  {
    key: "open_to_relocation",
    label: "Open to relocation",
    // Only ever from the stored decision. Blank stays blank: an unanswered
    // relocation question is a question, and a wrong "no" costs a role.
    from: (p) =>
      p.open_to_relocation == null ? "" : p.open_to_relocation ? "Yes" : "No",
    match: [
      /\b(willing|open|able|happy|prepared)\s*(and\s*able\s*)?to\s*relocat/,
      /\bconsider\s*relocat/,
      /\brelocation\s*(required|possible)\b/,
      /^.{0,40}\brelocat\w*\s*\??$/,
      // "This role requires working onsite 5 days a week — are you willing to
      // work onsite?" is the same question wearing different clothes.
      // "…open to being in-office 5 days a week in Sunnyvale?" — the gerund
      // between "open to" and the place is what the earlier pattern missed.
      /\b(willing|able|open|happy)\s*to\s*(be\s*|being\s*|work\w*\s*)*(onsite|on-?site|in[- ]?office|in\s*the\s*office|from\s*the\s*office)\b/,
      /\b(in[- ]?office|onsite|on-site)\s*\d+\s*days?\s*(a|per)\s*week\b/,
      /\bwilling\s*to\s*commute\b/,
    ],
  },
  {
    key: "consent_to_terms",
    label: "Privacy / terms",
    kind: "consent",
    // Consent only. The patterns are anchored on agreement and privacy language
    // rather than on the word "agree" alone, because a question of *fact* can
    // be worded as one — a conviction, a termination, a non-compete — and those
    // are answers about someone's history, not permissions they are granting.
    from: (p) => (p.consent_to_terms == null ? "" : p.consent_to_terms ? "yes" : "no"),
    whenEmpty: "set it once in Career Profile → Privacy notices",
    match: [
      /^privacy\b/,
      /\bprivacy\s*(policy|notice|statement)\b/,
      /\bterms\s*(and|&)?\s*conditions\b/,
      /\bdata\s*(processing|protection|privacy)\b/,
      /\bi\s*(agree|consent|acknowledge|certify|confirm)\b/,
      /\bconsent\s*to\s*(the|our|this)\b/,
      /\backnowledge\s*(and\s*agree|that)\b/,
      /\bgdpr\b/,
    ],
  },
  {
    key: "years_experience",
    label: "Years of experience",
    from: (p) => (p.years_experience == null ? "" : String(p.years_experience)),
    // The question has to be about experience. A bare "how many years" also
    // matched "How many years have you been active on the platform?", which is
    // about using a product, not about a career.
    unit: "years",
    match: [
      /\byears\s*(of\s*)?(relevant\s*|professional\s*|work\s*|industry\s*)?experience\b/,
      /\bhow\s*many\s*years\s*(of\s*)?(relevant\s*|professional\s*|work\s*|industry\s*)?experience\b/,
      /\byears\s*in\s*(the\s*)?(industry|field)\b/,
    ],
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
  {
    // The EEOC four moved into FIELDS above once there was somewhere to store
    // the answers — they are identical on every application, so retyping them
    // was the filler skipping the easiest part of the form. What stays here is
    // what HireCraft holds nothing for, and guessing at it would be inventing
    // an answer about someone's identity.
    why: "yours to answer",
    match: [
      /\bpronouns?\b/,
      /\btransgender\b/,
      /\bsexual\s*orientation\b/,
      /\bdate\s*of\s*birth\b/,
    ],
  },
  {
    // Deliberately narrow. Plenty of legitimate sponsorship questions name H-1B
    // ("will you require sponsorship, e.g. H-1B?") and those must still be
    // answered; only a question about status previously *held* is skipped. We
    // store a current visa status, not an immigration history.
    why: "your visa history isn't stored — answer this yourself",
    match: [
      /\bhave\s+you\s+(ever\s+)?(held|had)\b[^?]{0,90}\bh\s*-?\s*1\s*b\b/,
      /\bpreviously\s+held\b[^?]{0,60}\b(visa|status)\b/,
    ],
  },
  {
    // Checked before the `country` field can claim these. HireCraft stores the
    // country someone *lives in*; a form asking which country they hold
    // citizenship in is asking something else entirely, and answering it from a
    // location would put "United States" against the citizenship of someone on
    // a student visa. These are export-control and right-to-work questions
    // where a wrong answer is a false statement, not a typo.
    why: "citizenship isn't stored — answer this yourself",
    match: [
      /\bcitizenships?\b/,
      /\bcitizen\b/,
      /\bnationality\b/,
      /\bexport\s*(control|licensing|regulation)/,
      /\bcountry\s*of\s*(origin|birth)\b/,
      /\bpassport\b/,
      /\bdual\s*national/,
    ],
  },
  {
    // Same reasoning: a clearance is a fact about someone's record, we hold
    // none of it, and "eligible" is a judgement they have to make themselves.
    why: "clearance status is yours to state",
    match: [/\bsecurity\s*clearance\b/, /\bclearances?\b/, /\bpolygraph\b/],
  },
  {
    why: "depends on the offer",
    match: [
      /\b(salary|compensation)\s*(expectation|requirement|range)?\b/,
      /\bdesired\s*(salary|pay|compensation)\b/,
    ],
  },
  {
    // Whether someone is *willing to move* is a preference, and it is stored,
    // so it is answered above. Whether they *already live somewhere* is a fact
    // about today, and the two get worded almost identically — "are you
    // currently local to the Bay Area, or willing to relocate?" contains both.
    // Answering "currently local" for someone in Los Angeles would put a false
    // statement on a real application, so a question that asks where they are
    // now is left alone even when it also mentions relocating.
    why: "asks where you live right now — check this one",
    match: [
      /\b(currently|presently|now)\s*(located|living|live|residing|reside|based)\s*in\b/,
      /\bdo\s*you\s*(currently\s*)?(live|reside)\s*(in|near)\b/,
      /\bare\s*you\s*(currently\s*)?local\b/,
      /\bhow\s*far\s*(are\s*you\s*)?from\b/,
    ],
  },
  {
    why: "answer this one yourself",
    match: [
      /\bwhy\s+(do\s+you\s+want|are\s+you\s+interested|this\s+(role|company))\b/,
      /\btell\s+us\s+about\b/,
      /\bcover\s*letter\b/,
    ],
  },
];

/** A file input we should attach the résumé to. */
// Labels are accent-folded before matching (see fill.js `normalise`), so the
// ASCII spelling covers "Résumé" too.
const RESUME_FILE = [/\bresume\b/, /\bcv\b/, /\bupload\s*(your)?\s*resume\b/];

/**
 * Uploads the résumé must never land in.
 *
 * A real form has several file inputs. Verkada's asks for a résumé, a cover
 * letter, an undergraduate transcript and a graduate transcript; putting the
 * résumé in the wrong one is worse than leaving it empty, because it looks done.
 * "Resume/CV" contains "resume" and must still win over these, which is why the
 * search rejects only when a section names one of these and *not* the résumé.
 */
const NOT_RESUME = [
  /\bcover\s*letter\b/,
  /\btranscript\b/,
  /\bportfolio\s*(file|upload)\b/,
  /\bwriting\s*sample\b/,
  /\bcertificat(e|ion)s?\b/,
];

/**
 * The upload box a cover letter belongs in, and the ones it must not.
 *
 * Mirrors RESUME_FILE/NOT_RESUME. A form with four upload boxes will take the
 * letter into any of them, and a cover letter filed as a transcript is worse
 * than one not attached at all — it looks done.
 */
const COVER_FILE = [/\bcover\s*letter\b/, /\bletter\s*of\s*(interest|motivation)\b/];

const NOT_COVER = [
  /\bresume\b/,
  /\bcv\b/,
  /\btranscript\b/,
  /\bwriting\s*sample\b/,
  /\bportfolio\s*(file|upload)\b/,
  /\bcertificat(e|ion)s?\b/,
];

// Attached to window so the content script can read them; MV3 content scripts
// share one scope per frame but are not modules.
window.HIRECRAFT_FIELDS = FIELDS;
window.HIRECRAFT_SKIP = SKIP;
window.HIRECRAFT_RESUME_FILE = RESUME_FILE;
window.HIRECRAFT_NOT_RESUME = NOT_RESUME;
window.HIRECRAFT_COVER_FILE = COVER_FILE;
window.HIRECRAFT_NOT_COVER = NOT_COVER;
