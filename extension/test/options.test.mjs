/**
 * Option matching, checked against the option lists a real form actually
 * offered.
 *
 * Every list below is copied from Greenhouse's own schema for the Verkada
 * posting this was written after — the one where the filler typed "M.S. in
 * Computer Science" into a degree dropdown that does not contain that string,
 * "3.67" into a GPA question offering only ranges, and "2027" into a graduation
 * question whose newest option ends in 2026. Fixtures invented by hand would
 * have agreed with whatever the code did.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const window = {};
new Function("window", readFileSync(join(here, "..", "autofill", "options.js"), "utf8"))(window);
const { chooseOption, degreeLevel, parseRange, rangeHas, EEO, isDecline } =
  window.HIRECRAFT_OPTIONS;

/** Greenhouse's education degree list. */
const DEGREES = [
  "High School",
  "Associate's Degree",
  "Bachelor's Degree",
  "Master's Degree",
  "Master of Business Administration (M.B.A.)",
  "Juris Doctor (J.D.)",
  "Doctor of Medicine (M.D.)",
  "Doctor of Philosophy (Ph.D.)",
  "Engineer's Degree",
  "Other",
];
const GPA = ["3.6 - 4.0", "3.1 - 3.5", "3.0 or under"];
const GRAD_YEAR = ["2023-2026", "2020-2023", "Before 2020"];
const GENDER = ["Decline To Self Identify", "Female", "Male"];
const RACE = [
  "Decline To Self Identify",
  "Two or More Races",
  "Native Hawaiian or Other Pacific Islander",
  "White",
  "Hispanic or Latino",
  "Black or African American",
  "Asian",
  "American Indian or Alaskan Native",
];
const VETERAN = [
  "I don't wish to answer",
  "I identify as one or more of the classifications of a protected veteran",
  "I am not a protected veteran",
];
const DISABILITY = [
  "I do not want to answer",
  "No, I do not have a disability and have not had one in the past",
  "Yes, I have a disability, or have had one in the past",
];

const chose = (want, options, kind) => options[chooseOption(want, options, { kind }).index];

test("a résumé's degree wording finds the right level in the form's list", () => {
  assert.equal(chose("M.S. in Computer Science", DEGREES, "degree"), "Master's Degree");
  assert.equal(chose("Master of Science", DEGREES, "degree"), "Master's Degree");
  assert.equal(chose("B.S. in Electrical Engineering", DEGREES, "degree"), "Bachelor's Degree");
  assert.equal(chose("PhD", DEGREES, "degree"), "Doctor of Philosophy (Ph.D.)");
  // Specific beats general: with an MBA option present, an MBA takes it.
  assert.equal(chose("MBA", DEGREES, "degree"), "Master of Business Administration (M.B.A.)");
  assert.equal(chose("J.D.", DEGREES, "degree"), "Juris Doctor (J.D.)");
  // ...but a form with only the general option still gets answered.
  assert.equal(chose("MBA", ["Bachelor's Degree", "Master's Degree"], "degree"), "Master's Degree");
});

test("degree levels read the same off a résumé and off a dropdown", () => {
  // The point of canonicalising both sides: these are the same answer.
  for (const written of ["M.S.", "MS", "Master of Science", "Masters", "M.Sc."]) {
    assert.equal(degreeLevel(written), "master", written);
  }
  assert.equal(degreeLevel("Master's Degree"), "master");
  assert.equal(degreeLevel("Bachelor of Arts"), "bachelor");
  assert.equal(degreeLevel("Other"), null, "'Other' must not claim a level");
});

test("a numeric GPA lands in the band that contains it", () => {
  assert.equal(chose("3.67", GPA, null), "3.6 - 4.0");
  assert.equal(chose("3.2", GPA, null), "3.1 - 3.5");
  assert.equal(chose("2.8", GPA, null), "3.0 or under");
  assert.equal(chose("4.0", GPA, null), "3.6 - 4.0", "an endpoint is inside its band");
});

test("a year outside every band is reported, not guessed", () => {
  // The case that made this file necessary. 2027 is in none of the options, and
  // the only correct behaviour is to say so — the previous code typed "2027"
  // into the box and reported success.
  const result = chooseOption("2027", GRAD_YEAR, {});
  assert.equal(result.index, -1);
  assert.match(result.why, /outside every option/);
  assert.ok(result.why.includes("2027"), "the reason must name the value");
});

test("years inside a band still resolve", () => {
  assert.equal(chose("2025", GRAD_YEAR, null), "2023-2026");
  assert.equal(chose("2021", GRAD_YEAR, null), "2020-2023");
  assert.equal(chose("2015", GRAD_YEAR, null), "Before 2020");
});

test("'Before 2020' excludes 2020 itself", () => {
  const before = parseRange("Before 2020");
  assert.equal(rangeHas(before, 2019), true);
  assert.equal(rangeHas(before, 2020), false);
  // Where an inclusive phrasing is used, 2020 is in.
  assert.equal(rangeHas(parseRange("2020 or under"), 2020), true);
});

test("each EEOC answer finds its option, however the employer worded it", () => {
  assert.equal(chose("male", GENDER, "gender"), "Male");
  assert.equal(chose("female", GENDER, "gender"), "Female");
  assert.equal(chose("decline", GENDER, "gender"), "Decline To Self Identify");
  assert.equal(chose("asian", RACE, "race_ethnicity"), "Asian");
  assert.equal(chose("hispanic", RACE, "race_ethnicity"), "Hispanic or Latino");
  assert.equal(chose("two_or_more", RACE, "race_ethnicity"), "Two or More Races");
  assert.equal(chose("no", DISABILITY, "disability_status"),
    "No, I do not have a disability and have not had one in the past");
  assert.equal(chose("yes", DISABILITY, "disability_status"),
    "Yes, I have a disability, or have had one in the past");
});

test("the veteran options are told apart despite sharing their key phrase", () => {
  // Both real answers contain "protected veteran"; only the negation separates
  // them, and getting this backwards would put a false statement on a federal
  // self-identification form.
  assert.equal(chose("not_protected", VETERAN, "veteran_status"), "I am not a protected veteran");
  assert.equal(
    chose("protected", VETERAN, "veteran_status"),
    "I identify as one or more of the classifications of a protected veteran"
  );
  assert.equal(chose("decline", VETERAN, "veteran_status"), "I don't wish to answer");
});

test("'male' is not found inside 'female'", () => {
  assert.equal(EEO.gender("Female"), "female");
  assert.equal(EEO.gender("Male"), "male");
});

test("decline is recognised across the phrasings boards use", () => {
  for (const text of [
    "Decline To Self Identify",
    "I don't wish to answer",
    "I do not want to answer",
    "Prefer not to say",
    "I decline to self-identify",
  ]) {
    assert.equal(isDecline(text), true, text);
  }
  assert.equal(isDecline("No, I do not have a disability and have not had one in the past"), false);
  assert.equal(isDecline("Male"), false);
});

test("an unanswerable question returns a reason rather than a wrong option", () => {
  const noMatch = chooseOption("non_binary", GENDER, { kind: "gender" });
  assert.equal(noMatch.index, -1, "this form offers no non-binary option");
  assert.match(noMatch.why, /no option means/);

  assert.equal(chooseOption("", GPA, {}).index, -1);
  assert.equal(chooseOption("3.67", [], {}).index, -1);
});

test("plain lists still match without being told what they are", () => {
  const countries = ["United Kingdom", "United States", "United Arab Emirates"];
  assert.equal(chose("United States", countries, null), "United States");
  assert.equal(chose("Yes", ["Yes", "No"], null), "Yes");
});

test("a duration is not matched against options measured in something else", () => {
  // Found by dry-running a real Twitch form: 2.5 years of experience matched
  // "Less than 6 months", because 2.5 < 6 and nothing knew what 6 counted.
  const TENURE = ["Less than 6 months", "6 months - 1 year", "1-2 years", "3-5 years", "5+ years"];

  assert.equal(chooseOption("2.5", TENURE, { unit: "years" }).index, -1,
    "2.5 years sits between the 1-2 and 3-5 bands, so there is no honest answer");
  assert.equal(TENURE[chooseOption("4", TENURE, { unit: "years" }).index], "3-5 years");
  assert.equal(TENURE[chooseOption("0.25", TENURE, { unit: "years" }).index], "Less than 6 months");

  // Without a declared unit the comparison is meaningless and is refused.
  assert.equal(chooseOption("2.5", TENURE, {}).index, -1);
});

test("a range naming two units is not guessed at", () => {
  // "6 months - 1 year" cannot be read as one span; picking either unit is
  // wrong by a factor of twelve.
  assert.equal(parseRange("6 months - 1 year"), null);
  assert.equal(parseRange("Less than 6 months").unit, "month");
  assert.equal(parseRange("3-5 years").unit, "year");
});

test("unitless ranges are unaffected", () => {
  // GPA bands and year bands name no unit, so none of the above applies.
  assert.equal(parseRange("3.6 - 4.0").unit, null);
  assert.equal(parseRange("2023-2026").unit, null);
  assert.equal(chooseOption("3.67", ["3.6 - 4.0", "3.1 - 3.5"], {}).index, 0);
});

// --- Lever's wording, copied from a live apply form -------------------------
//
// Both lists below broke the matcher in ways the Greenhouse lists could not.

const LEVER_RACE = [
  "Hispanic or Latino",
  "White (Not Hispanic or Latino)",
  "Black or African American (Not Hispanic or Latino)",
  "Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino)",
  "Asian (Not Hispanic or Latino)",
  "American Indian or Alaska Native (Not Hispanic or Latino)",
  "Two or More Races (Not Hispanic or Latino)",
  "Decline to self-identify",
];
const LEVER_VETERAN = ["I am a veteran", "I am not a veteran", "Decline to self-identify"];

test("a parenthesised 'Not Hispanic or Latino' does not make every race hispanic", () => {
  // Lever qualifies every option this way. Reading the whole string, the
  // hispanic test fired on all of them, and an Asian applicant would have been
  // recorded as Hispanic or Latino on an EEO form.
  assert.equal(chose("asian", LEVER_RACE, "race_ethnicity"), "Asian (Not Hispanic or Latino)");
  assert.equal(chose("white", LEVER_RACE, "race_ethnicity"), "White (Not Hispanic or Latino)");
  assert.equal(
    chose("black", LEVER_RACE, "race_ethnicity"),
    "Black or African American (Not Hispanic or Latino)"
  );
  assert.equal(
    chose("two_or_more", LEVER_RACE, "race_ethnicity"),
    "Two or More Races (Not Hispanic or Latino)"
  );
  // And the genuinely Hispanic option is still reachable.
  assert.equal(chose("hispanic", LEVER_RACE, "race_ethnicity"), "Hispanic or Latino");
  assert.equal(chose("decline", LEVER_RACE, "race_ethnicity"), "Decline to self-identify");
});

test("'I am not a veteran' is understood, not just 'not a protected veteran'", () => {
  // Greenhouse says "protected veteran"; Lever says plain "veteran". The
  // pattern was anchored on the first, so Lever's options matched nothing.
  assert.equal(chose("not_protected", LEVER_VETERAN, "veteran_status"), "I am not a veteran");
  assert.equal(chose("protected", LEVER_VETERAN, "veteran_status"), "I am a veteran");
  assert.equal(chose("decline", LEVER_VETERAN, "veteran_status"), "Decline to self-identify");

  // Greenhouse's longer wording still resolves the same way.
  assert.equal(chose("not_protected", VETERAN, "veteran_status"), "I am not a protected veteran");
  assert.equal(
    chose("protected", VETERAN, "veteran_status"),
    "I identify as one or more of the classifications of a protected veteran"
  );
});

test("Lever's gender list works unchanged", () => {
  const LEVER_GENDER = ["Male", "Female", "Decline to self-identify"];
  assert.equal(chose("male", LEVER_GENDER, "gender"), "Male");
  assert.equal(chose("decline", LEVER_GENDER, "gender"), "Decline to self-identify");
});
