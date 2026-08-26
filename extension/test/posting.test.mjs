/**
 * Naming the employer and the role from a page hosted by neither.
 *
 * The titles below are the shapes these boards actually produce. The one that
 * started this: a tracked application read "Applied" rather than "Applied
 * Intuition", because the first path segment of an Ashby URL is the company's
 * slug and a slug is not a name.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const window = {};
new Function("window", readFileSync(join(here, "..", "autofill", "posting.js"), "utf8"))(window);
const { companyFrom, companyFromTitle, roleFromTitle } = window.HIRECRAFT_POSTING;

test("structured data wins, because it is the page saying so outright", () => {
  assert.equal(
    companyFrom({
      jsonLd: "Applied Intuition",
      siteName: "Ashby",
      title: "Research Engineer @ Applied Intuition",
      pathSegment: "applied",
    }),
    "Applied Intuition"
  );
});

test("a board's own name is not the employer's", () => {
  // og:site_name is set to the ATS on several of these, and taking it would
  // fill a tracker with rows called Greenhouse.
  for (const board of ["Greenhouse", "Lever", "Ashby", "Workday", "SmartRecruiters"]) {
    assert.notEqual(
      companyFrom({ siteName: board, title: "Engineer @ Verkada", pathSegment: "verkada" }),
      board
    );
  }
  // A real employer's site name is still used.
  assert.equal(companyFrom({ siteName: "Stripe", pathSegment: "stripe" }), "Stripe");
});

test("the titles these boards produce", () => {
  assert.equal(
    companyFromTitle("Research Engineer - New Grad (2027) @ Applied Intuition"),
    "Applied Intuition"
  );
  assert.equal(
    companyFromTitle("Job Application for 2027 Cubist Quant Academy – Developers at Point72"),
    "Point72"
  );
  assert.equal(companyFromTitle("Software Engineer at Verkada"), "Verkada");
});

test("a hyphen or a pipe is not trusted, because it is used both ways round", () => {
  // "Zoox - ML Engineer" and "ML Engineer - Zoox" are both common, so reading
  // either would be right half the time. Half is worse than abstaining.
  assert.equal(companyFromTitle("Zoox - Machine Learning Engineer"), "");
  assert.equal(companyFromTitle("Machine Learning Engineer | Zoox"), "");
});

test("a slug is capitalised, not left as typed", () => {
  // Last resort, and it still has to read as a name in a tracker row.
  assert.equal(companyFrom({ pathSegment: "point72" }), "Point72");
  assert.equal(companyFrom({ pathSegment: "general-matter" }), "General Matter");
  assert.equal(companyFrom({ pathSegment: "parallel_systems" }), "Parallel Systems");
  // A run-together slug cannot be split reliably, so it is not guessed at.
  assert.equal(companyFrom({ pathSegment: "applied" }), "Applied");
});

test("the role is the title with the employer taken off", () => {
  assert.equal(
    roleFromTitle("Research Engineer - New Grad (2027) @ Applied Intuition"),
    "Research Engineer - New Grad (2027)"
  );
  assert.equal(
    roleFromTitle("Job Application for 2027 Cubist Quant Academy – Developers at Point72"),
    "2027 Cubist Quant Academy – Developers"
  );
  assert.equal(roleFromTitle("Machine Learning Engineer | Zoox"), "Machine Learning Engineer");
});

test("nothing to go on gives nothing, rather than something wrong", () => {
  assert.equal(companyFromTitle(""), "");
  assert.equal(companyFrom({}), "");
  assert.equal(roleFromTitle(""), "");
  assert.equal(companyFrom({ host: "careers.roblox.com" }), "careers");
});
