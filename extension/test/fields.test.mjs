/**
 * Which field claims which label.
 *
 * Run with:  node --test extension/test/
 *
 * This is the part of the autofiller most likely to be wrong in a way nobody
 * notices, because a mis-claimed field looks filled. The cases that matter most
 * are the near-misses — "Company name" is not the candidate's name, "School" is
 * not their location — and the ones we must refuse to answer at all.
 *
 * No test framework and no DOM: fields.js is plain data plus regexes, so it is
 * loaded with a `window` stub and exercised directly. Anything needing a real
 * document belongs in the live per-ATS pass instead, where it can be checked
 * against a page that actually exists.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "autofill", "fields.js"), "utf8");

const window = {};
new Function("window", source)(window);
// Load the engine too and use its real `normalise`. Re-implementing it here
// would mean the tests pass against a copy while the shipped filler does
// something else — which is how the accent bug survived being "covered".
new Function(
  "window",
  readFileSync(join(here, "..", "autofill", "fill.js"), "utf8")
)(window);

const {
  HIRECRAFT_FIELDS: FIELDS,
  HIRECRAFT_SKIP: SKIP,
  HIRECRAFT_RESUME_FILE: RESUME,
  HIRECRAFT_NOT_RESUME: NOT_RESUME,
  HIRECRAFT_COVER_FILE: COVER,
  HIRECRAFT_NOT_COVER: NOT_COVER,
} = window;
const { normalise } = window.HIRECRAFT_FILL;

/** The key that would claim this label, or null. */
function claim(rawLabel) {
  const label = normalise(rawLabel);
  if (SKIP.some((group) => group.match.some((re) => re.test(label)))) return "SKIP";
  return FIELDS.find((f) => f.match.some((re) => re.test(label)))?.key ?? null;
}

test("labels map to the field a human would expect", () => {
  const cases = [
    ["First Name *", "first_name"],
    ["Legal first name", "first_name"],
    ["Given name", "first_name"],
    ["Last Name (required)", "last_name"],
    ["Surname", "last_name"],
    ["Family Name", "last_name"],
    ["Full name", "full_name"],
    ["Name", "full_name"],
    ["Email", "email"],
    ["Email Address *", "email"],
    ["Phone", "phone"],
    ["Mobile phone number", "phone"],
    ["LinkedIn Profile", "linkedin"],
    ["LinkedIn URL", "linkedin"],
    ["GitHub", "github"],
    ["Github profile", "github"],
    ["Portfolio", "portfolio"],
    ["Personal website", "portfolio"],
    ["Website", "website"],
    ["Location", "location"],
    ["Current location", "location"],
    ["City, State", "location"],
    ["Years of experience", "years_experience"],
    ["How many years of relevant experience do you have?", "years_experience"],
    // Labels taken verbatim from a live Verkada/Greenhouse application form.
    ["Location (City) *", "location"],
    ["Country *", "country"],
    ["School *", "school"],
    ["Degree *", "degree"],
    ["Start date year *", "start_year"],
    ["End date year *", "end_year"],
    ["What year did you graduate from your most recent degree program? *", "graduation_year"],
    ["What is your major GPA (on a 4.0 scale) for your most recent degree program? *", "gpa"],
    ["Are you legally authorized to work in the United States? *", "authorized_to_work"],
    ["Are you eligible to work in the US?", "authorized_to_work"],
    ["Will you now or in the future require sponsorship for employment visa status? *", "requires_sponsorship"],
    ["Do you require visa sponsorship?", "requires_sponsorship"],
  ];
  for (const [label, expected] of cases) {
    assert.equal(claim(label), expected, `${label} should map to ${expected}`);
  }
});

test("a preferred-name box gets the preferred name, not the legal one", () => {
  // Both exist for a reason: an application is an employment record and asks
  // for the name on the candidate's documents, while a "preferred name" box is
  // asking the opposite question. Answering either with the other is wrong.
  assert.equal(claim("Preferred name"), "preferred_name");
  assert.equal(claim("What name do you go by?"), "preferred_name");
  assert.equal(claim("First Name"), "first_name");
  assert.equal(claim("Legal first name"), "first_name");

  const FIELDS_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
  const p = { legal_first_name: "Mohammad Hasnain", preferred_name: "Hasnain", first_name: "X" };
  assert.equal(FIELDS_BY_KEY.first_name.from(p), "Mohammad Hasnain");
  assert.equal(FIELDS_BY_KEY.preferred_name.from(p), "Hasnain");
});

test("near-miss labels are not answered with the candidate's own details", () => {
  // Every one of these contains a word a looser pattern would grab. Filling any
  // of them puts a wrong answer on a real employer's form.
  for (const label of [
    "Company name",
    "Current company",
    "School name",
    "University name",
    "Manager name",
    "Reference name",
    "Emergency contact name",
    "Preferred name of your referrer",
  ]) {
    assert.notEqual(claim(label), "full_name", `${label} must not be filled with the user's name`);
    assert.notEqual(claim(label), "first_name", `${label} must not be filled with a first name`);
    assert.notEqual(claim(label), "last_name", `${label} must not be filled with a last name`);
  }
});

test("the EEOC four are answered from the profile, each by its own question", () => {
  // These used to be skipped outright. They are identical on every application
  // and never change, so refusing to fill them meant retyping the same five
  // answers forever. They are still only ever answered from a stored decision —
  // an unset one leaves the box blank, exactly as before.
  assert.equal(claim("Gender"), "gender");
  assert.equal(claim("Race / Ethnicity"), "race_ethnicity");
  assert.equal(claim("Are you Hispanic or Latino?"), "hispanic_latino");
  assert.equal(claim("Veteran status"), "veteran_status");
  assert.equal(claim("Do you have a disability?"), "disability_status");
});

test("a Hispanic/Latino question is not answered from the race field", () => {
  // Forms split these two ways: one combined "Race/Ethnicity" dropdown, or a
  // yes/no about Hispanic origin followed by a separate race question. Reading
  // the wrong stored answer into either would put a wrong answer on the form.
  assert.equal(claim("Are you Hispanic/Latino?"), "hispanic_latino");
  assert.equal(claim("Race"), "race_ethnicity");
  assert.equal(claim("Ethnicity"), "race_ethnicity");
});

test("what nothing is stored for is still left for the candidate", () => {
  for (const label of [
    "What are your pronouns?",
    "Sexual orientation",
    "Date of birth",
    "Do you identify as transgender?",
  ]) {
    assert.equal(claim(label), "SKIP", `${label} must be left for the candidate`);
  }
});

test("relocation is answered; where you live today still is not", () => {
  // These read almost identically and are different questions. Willingness to
  // move is a preference and it is stored, so it gets answered. Where someone
  // already lives is a fact about today — and a form asking "are you currently
  // local, or willing to relocate?" asks both at once, so it stays with the
  // candidate rather than being answered "currently local" for someone in
  // Los Angeles.
  assert.equal(claim("Are you willing to relocate?"), "open_to_relocation");
  assert.equal(claim("Are you open to relocation?"), "open_to_relocation");
  assert.equal(claim("Are you willing to work onsite 5 days per week?"), "open_to_relocation");

  for (const label of [
    "This role requires working onsite 5 days per week in the Bay Area. Are you currently local or willing to relocate?",
    "Do you currently live in the Bay Area?",
    "Are you currently local to New York?",
    "Why do you want to work here?",
  ]) {
    assert.equal(claim(label), "SKIP", `${label} must be left for the candidate`);
  }
});

test("relocation is only answered from a stored decision", () => {
  const field = FIELDS.find((f) => f.key === "open_to_relocation");
  assert.equal(field.from({}), "");
  assert.equal(field.from({ open_to_relocation: null }), "");
  assert.equal(field.from({ open_to_relocation: true }), "Yes");
  assert.equal(field.from({ open_to_relocation: false }), "No");
});

test("every skip group explains itself", () => {
  for (const group of SKIP) {
    assert.ok(group.why && group.why.length > 3, "a skip group needs a reason to show");
    assert.ok(Array.isArray(group.match) && group.match.length, "a skip group needs patterns");
  }
});

test("salary questions are left alone", () => {
  // A stored range is a preference. Committing to a number on an employer's
  // form is a decision the user makes with the posting in front of them.
  for (const label of [
    "Desired salary",
    "Salary expectations",
    "Compensation requirement",
  ]) {
    assert.equal(claim(label), "SKIP", `${label} must be left for the candidate`);
  }
});

test("specific patterns are ordered before general ones", () => {
  // "First name" contains "name"; if full_name were listed first it would win
  // and both name boxes would receive the whole name.
  const order = FIELDS.map((f) => f.key);
  assert.ok(order.indexOf("first_name") < order.indexOf("full_name"));
  assert.ok(order.indexOf("last_name") < order.indexOf("full_name"));
  // Likewise a LinkedIn box is a URL box; the generic website field must not
  // claim it first.
  assert.ok(order.indexOf("linkedin") < order.indexOf("website"));
  assert.ok(order.indexOf("portfolio") < order.indexOf("website"));
});

test("résumé upload labels are recognised", () => {
  for (const label of ["Resume", "Résumé", "Resume/CV", "Upload your resume", "CV"]) {
    assert.ok(
      RESUME.some((re) => re.test(normalise(label))),
      `${label} should be recognised as the résumé upload`
    );
  }
  assert.ok(
    !RESUME.some((re) => re.test(normalise("Cover letter"))),
    "a cover-letter upload must not receive the résumé"
  );
});

test("every field can produce a value from a full profile", () => {
  const profile = {
    full_name: "Ada Lovelace King",
    first_name: "Ada Lovelace",
    last_name: "King",
    legal_first_name: "Ada Lovelace",
    legal_last_name: "King",
    preferred_name: "Ada",
    email: "ada@example.com",
    phone: "555-0100",
    location: "Los Angeles, CA",
    country: "United States",
    linkedin: "https://linkedin.com/in/ada",
    github: "https://github.com/ada",
    portfolio: "https://ada.dev",
    website: "https://ada.dev",
    years_experience: 3.5,
    open_to_relocation: true,
    authorized_to_work: true,
    requires_sponsorship: true,
    self_identification: {
      gender: "male",
      race_ethnicity: "asian",
      hispanic_latino: "no",
      veteran_status: "not_protected",
      disability_status: "no",
    },
    education: {
      school: "University of Southern California",
      degree: "M.S. in Computer Science",
      field_of_study: "Computer Science",
      gpa: "3.67",
      start_year: "2025",
      end_year: "2027",
    },
  };
  for (const field of FIELDS) {
    const value = field.from(profile);
    assert.ok(
      value !== undefined && String(value).length > 0,
      `${field.key} produced nothing from a fully populated profile`
    );
  }
});

test("an empty profile yields no values rather than undefined text", () => {
  // The filler reports "nothing stored" for a blank value; it must never type
  // the string "undefined" into someone's application.
  for (const field of FIELDS) {
    const value = String(field.from({}) ?? "").trim();
    assert.equal(value, "", `${field.key} should be blank for an empty profile`);
  }
});

test("the résumé is not put in another upload box", () => {
  /** What findUploadInput decides for a section with this text. */
  const verdict = (text) => {
    const n = normalise(text);
    const wanted = RESUME.some((re) => re.test(n));
    const rejected = NOT_RESUME.some((re) => re.test(n));
    return wanted && !rejected ? "attach" : "skip";
  };

  // Verkada's Greenhouse form carries four uploads. Only one takes the résumé.
  assert.equal(verdict("Resume/CV *"), "attach");
  assert.equal(verdict("Resume"), "attach");
  assert.equal(verdict("Upload your resume"), "attach");

  assert.equal(verdict("Cover Letter"), "skip");
  assert.equal(verdict("Undergraduate Transcript *"), "skip");
  assert.equal(verdict("Graduate Transcript"), "skip");
  assert.equal(verdict("Writing sample"), "skip");

  // The trap: a section naming both must not attach. Landing the résumé in a
  // transcript box looks filled and is wrong, which is worse than empty.
  assert.equal(verdict("Attach your resume or cover letter"), "skip");
});

test("an unanswered work-authorization question is left blank, not guessed", () => {
  // These two are independent — someone on F-1 OPT is authorized to work now
  // *and* will need sponsorship later — and both are consequential. An empty
  // box an employer asks about is far better than a wrong answer about
  // somebody's right to work, so an unset value must produce nothing.
  const by = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
  for (const key of ["authorized_to_work", "requires_sponsorship"]) {
    assert.equal(by[key].from({}), "", `${key} must be blank when unanswered`);
    assert.equal(by[key].from({ [key]: null }), "", `${key} must be blank when null`);
    assert.equal(by[key].from({ [key]: true }), "Yes");
    assert.equal(by[key].from({ [key]: false }), "No");
  }
});

test("a citizenship question is never answered from the stored country", () => {
  // Found by reading a real Amazon/Twitch form: it asks "In which
  // country/region do you have citizenship?", which contains the word
  // "country". HireCraft stores where you live, not what you hold — answering
  // one from the other writes "United States" against the citizenship of
  // someone on a student visa, on an export-control question.
  for (const label of [
    "In which country/region do you have citizenship?",
    "For the sole purpose of determining export licensing requirements, in which country do you hold citizenship?",
    "Country of citizenship",
    "What is your nationality?",
    "Are you a U.S. citizen?",
    "Country of birth",
  ]) {
    assert.equal(claim(label), "SKIP", `${label} must not be auto-answered`);
  }

  // The ordinary country question still fills, or the fix would have cost more
  // than it saved.
  assert.equal(claim("Country"), "country");
  assert.equal(claim("Country of residence"), "country");
});

test("clearance questions are left to the candidate", () => {
  for (const label of [
    "Clearance Eligibility",
    "Active Security Clearance(s)",
    "Do you hold a current security clearance?",
  ]) {
    assert.equal(claim(label), "SKIP", `${label} must not be auto-answered`);
  }
});

test("visa history is skipped without disarming the sponsorship question", () => {
  // These sit close together and mean different things. "Have you held H-1B
  // status?" is about a record we do not hold; "will you require sponsorship?"
  // is answered from a stored decision and must keep working, including when it
  // names H-1B itself — which is how most forms word it.
  assert.equal(
    claim("Have you held H-1B status, or had an H-1B petition approved on your behalf, within the preceding 6 years for an employer other than a cap exempt institution?"),
    "SKIP"
  );
  assert.equal(
    claim("Will you now or in the future require sponsorship for employment visa status (e.g. H-1B)?"),
    "requires_sponsorship"
  );
  assert.equal(
    claim("Do you need, or will you need in the future, any immigration related support or sponsorship?"),
    "requires_sponsorship"
  );
});

test("a question about a product is not answered from work experience", () => {
  // "How many years have you been active on the platform?" was answered from
  // years_experience, and then bucketed into "Less than 6 months".
  const got = claim("How many years have you been active on the platform?");
  assert.notEqual(got, "years_experience", "a platform-usage question is not a career question");
});

test("an H-1B question is not answered with a university name", () => {
  // "…an employer other than a cap exempt institution?" matched the school
  // field on the word "institution".
  assert.notEqual(
    claim("Have you held H-1B status for an employer other than a cap exempt institution?"),
    "school"
  );
  // The real school questions still match.
  assert.equal(claim("School"), "school");
  assert.equal(claim("University"), "school");
  assert.equal(claim("Institution name"), "school");
});

test("a location question survives an adverb", () => {
  assert.equal(claim("Where are you currently located?"), "location");
  assert.equal(claim("Where are you based?"), "location");
});

test("a cover letter goes in the cover-letter box and nowhere else", () => {
  // Same shape as the résumé rule, and for the same reason: Verkada's form had
  // four upload boxes, and a letter filed as a transcript looks done.
  const wants = (label) =>
    COVER.some((re) => re.test(normalise(label))) &&
    !NOT_COVER.some((re) => re.test(normalise(label)));

  assert.equal(wants("Cover Letter"), true);
  assert.equal(wants("Letter of interest"), true);
  assert.equal(wants("Resume/CV"), false);
  assert.equal(wants("Undergraduate Transcript"), false);
  assert.equal(wants("Writing sample"), false);
});

test("camelCase labels still find their field", () => {
  // Greenhouse's compliance block labels its questions "VeteranStatus" and
  // "DisabilityStatus" with no separator, so a pattern anchored on \bveteran\b
  // found no word boundary and both went unanswered — the exact two questions
  // the self-identification feature was built to answer.
  assert.equal(claim("VeteranStatus"), "veteran_status");
  assert.equal(claim("DisabilityStatus"), "disability_status");
  assert.equal(claim("Veteran Status"), "veteran_status");

  // And the split must not break the labels that were already working.
  assert.equal(claim("LinkedIn Profile"), "linkedin");
  assert.equal(claim("GitHub"), "github");
  assert.equal(claim("FirstName"), "first_name");
});
