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

test("questions that need the role in front of you are left alone", () => {
  // A stored relocation preference cannot answer "are you local to the Bay
  // Area, or willing to relocate?" — that needs the role's city and a decision.
  // Filling "currently local" for someone in Los Angeles would be a false
  // statement on a real application.
  for (const label of [
    "This role requires working onsite 5 days per week in the Bay Area. Are you currently local or willing to relocate?",
    "Are you willing to relocate?",
    "Are you comfortable with a hybrid schedule?",
    "Why do you want to work here?",
  ]) {
    assert.equal(claim(label), "SKIP", `${label} must be left for the candidate`);
  }
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
