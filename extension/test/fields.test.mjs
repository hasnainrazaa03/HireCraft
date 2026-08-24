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

const { HIRECRAFT_FIELDS: FIELDS, HIRECRAFT_SKIP: SKIP, HIRECRAFT_RESUME_FILE: RESUME } = window;
const { normalise } = window.HIRECRAFT_FILL;

/** The key that would claim this label, or null. */
function claim(rawLabel) {
  const label = normalise(rawLabel);
  if (SKIP.some((re) => re.test(label))) return "SKIP";
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
  ];
  for (const [label, expected] of cases) {
    assert.equal(claim(label), expected, `${label} should map to ${expected}`);
  }
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

test("voluntary self-identification is never filled", () => {
  for (const label of [
    "Race / Ethnicity",
    "Gender",
    "What are your pronouns?",
    "Do you have a disability?",
    "Veteran status",
    "Are you Hispanic or Latino?",
    "Sexual orientation",
    "Date of birth",
  ]) {
    assert.equal(claim(label), "SKIP", `${label} must be left for the candidate`);
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
    email: "ada@example.com",
    phone: "555-0100",
    location: "Los Angeles, CA",
    linkedin: "https://linkedin.com/in/ada",
    github: "https://github.com/ada",
    portfolio: "https://ada.dev",
    website: "https://ada.dev",
    years_experience: 3.5,
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
