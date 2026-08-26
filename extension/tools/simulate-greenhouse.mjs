/**
 * Dry-run the field catalogue against a real Greenhouse form schema.
 *
 * No DOM and no clicking: this only answers "for each question this form asks,
 * what would the filler do?" — which is the thing worth checking before
 * pointing it at someone's actual application.
 *
 * It has already earned its place. Run against three live postings it found
 * four wrong answers the unit tests did not: an H-1B question answered with a
 * university name (it ends "...other than a cap exempt institution?"), a
 * question about years spent using a product answered from years of work
 * experience and then bucketed into "Less than 6 months", a citizenship
 * question answered "United States" for someone on an F-1 visa, and a location
 * question missed because it said "currently located".
 *
 *   curl -s "https://boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>?questions=true" > form.json
 *   node extension/tools/simulate-greenhouse.mjs form.json profile.json
 *
 * where profile.json is the body of GET /api/v1/extension/profile.
 */
import { readFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const w = {};
for (const f of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
  new Function("window", "document", "CSS", "Event", "HTMLInputElement", "HTMLTextAreaElement",
    "HTMLSelectElement", "MouseEvent", "KeyboardEvent", "DataTransfer", "setTimeout",
    readFileSync(`${EXT}/${f}`, "utf8"))(
    w, { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
    { escape: (s) => s }, class {}, class {}, class {}, class {}, class {}, class {}, class {}, setTimeout);
}
const { normalise } = w.HIRECRAFT_FILL;
const { chooseOption } = w.HIRECRAFT_OPTIONS;
const profile = JSON.parse(readFileSync(process.argv[3], "utf8"));
const schema = JSON.parse(readFileSync(process.argv[2], "utf8"));

const questions = [
  ...(schema.questions || []),
  ...(schema.location_questions || []),
  ...(schema.compliance || []).flatMap((b) => b.questions || []),
];

let fills = 0, skips = 0, gaps = 0, blanks = 0;
for (const q of questions) {
  for (const f of q.fields) {
    if (f.type === "input_hidden") continue;
    const raw = q.label.replace(/\s+/g, " ").trim();
    const label = normalise(raw);
    const req = q.required ? "*" : " ";

    const skip = w.HIRECRAFT_SKIP.find((g) => g.match.some((re) => re.test(label)));
    if (skip) { skips++; console.log(`  ⏭${req} ${raw.slice(0, 56).padEnd(58)} left: ${skip.why}`); continue; }

    if (f.type === "input_file") {
      const isResume = w.HIRECRAFT_RESUME_FILE.some((re) => re.test(label)) &&
                       !w.HIRECRAFT_NOT_RESUME.some((re) => re.test(label));
      if (isResume) { fills++; console.log(`  ✅${req} ${raw.slice(0, 56).padEnd(58)} résumé attached`); }
      else { gaps++; console.log(`  📎${req} ${raw.slice(0, 56).padEnd(58)} upload by hand`); }
      continue;
    }

    const field = w.HIRECRAFT_FIELDS.find((x) => x.match.some((re) => re.test(label)));
    if (!field) { blanks++; console.log(`  ⬜${req} ${raw.slice(0, 56).padEnd(58)} no field matches`); continue; }

    const value = String(field.from(profile) ?? "").trim();
    if (!value) { gaps++; console.log(`  ⚠️${req} ${raw.slice(0, 56).padEnd(58)} ${field.label}: ${field.whenEmpty || "nothing stored"}`); continue; }

    const vals = (f.values || []).map((v) => String(v.label));
    if (vals.length) {
      // Same options the engine passes, or this tool reports failures the
      // real filler would not have — which is worse than not running it.
      const { index, why } = chooseOption(value, vals, {
        kind: field.kind,
        unit: field.unit,
        context: field.context?.(profile),
      });
      if (index >= 0) { fills++; console.log(`  ✅${req} ${raw.slice(0, 56).padEnd(58)} ${vals[index]}`); }
      else { gaps++; console.log(`  ⚠️${req} ${raw.slice(0, 56).padEnd(58)} ${why}`); }
    } else { fills++; console.log(`  ✅${req} ${raw.slice(0, 56).padEnd(58)} ${value.slice(0, 40)}`); }
  }
}
console.log(`\n  ${fills} filled · ${gaps} needs you · ${skips} deliberately skipped · ${blanks} unrecognised`);
