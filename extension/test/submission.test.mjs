/**
 * Recognising that an application was actually submitted.
 *
 * The patterns are the whole feature: too loose and a careers-page footer marks
 * a job as applied, which puts a false record in a tracker the user relies on;
 * too tight and the moment passes unrecorded, which is the problem the feature
 * exists to solve. Both failures are silent, so both are pinned here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const window = {};
new Function(
  "window",
  readFileSync(join(here, "..", "autofill", "submission.js"), "utf8")
)(window);
const { isConfirmationUrl, isConfirmationText } = window.HIRECRAFT_SUBMISSION;

test("confirmation urls are recognised", () => {
  for (const path of [
    "/jobs/123/thank-you",
    "/application/confirmation",
    "/apply/submitted",
    "/careers/success",
    "/postings/abc/confirmed",
    "/apply/complete",
  ]) {
    assert.ok(isConfirmationUrl(path), `missed: ${path}`);
  }
});

test("ordinary application urls are not confirmations", () => {
  // Every one of these is a page the user is still filling in. Treating any as
  // a submission would record an application that had not happened.
  for (const path of [
    "/jobs/5195995007",
    "/verkada/jobs/5195995007",
    "/apply",
    "/application",
    "/careers/software-engineer",
    "/jobs/completeness-analyst",
  ]) {
    assert.ok(!isConfirmationUrl(path), `false positive: ${path}`);
  }
});

test("confirmation wording is recognised", () => {
  for (const text of [
    "Thank you for applying to Verkada!",
    "Your application has been submitted.",
    "We have received your application and will be in touch.",
    "We've received your application.",
    "Application submitted successfully",
    "Thank you for your application",
  ]) {
    assert.ok(isConfirmationText(text), `missed: ${text}`);
  }
});

test("page furniture is not a submission", () => {
  // These appear on pages where nothing has been submitted — the form itself,
  // a careers landing page, a privacy notice. Matching one would mark a job as
  // applied while the user was still typing.
  for (const text of [
    "Submit your application when you're ready",
    "Complete all required fields to apply",
    "Thank you for visiting our careers page",
    "Your application will be reviewed by our team",
    "Applications are received on a rolling basis",
    "Please complete the application below",
    // Deliberately not a confirmation. It appears at the top of plenty of forms
    // that have not been submitted — "Thanks for your interest in this role,
    // please complete the fields below" — and it is the phrase most likely to
    // put a false "applied" into the tracker.
    "Thanks for your interest in this role",
    "Thank you for your interest in joining us",
  ]) {
    assert.ok(!isConfirmationText(text), `false positive: ${text}`);
  }
});
