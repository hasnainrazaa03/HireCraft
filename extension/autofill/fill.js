/**
 * The fill engine: find each control, work out what it's asking for, set it.
 *
 * The one thing that must not be got wrong is *how* a value is set. Greenhouse,
 * Ashby and Lever all render React-controlled inputs, and `el.value = x` on one
 * of those is silently discarded — React re-renders from its own state and the
 * field snaps back empty, usually after the user has looked away. So values go
 * in through the native property setter and are announced with the events React
 * actually listens for.
 */

/** Wait, so the user can watch a field fill rather than find the form full. */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Normalise a label for matching: lowercase, unaccented, no punctuation.
 *
 * Accents are folded rather than stripped. JavaScript's `\w` is ASCII-only, so
 * deleting non-word characters turned "Résumé" into "r sum" — and the résumé
 * upload, the single most valuable field on the form, went unrecognised on every
 * site that spells it properly. Decomposing and dropping the combining marks
 * gives "resume", so one ASCII pattern matches both spellings.
 */
function normalise(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[*✱]/g, " ")
    .replace(/\(\s*required\s*\)|\brequired\b|\boptional\b/gi, " ")
    .replace(/[^\w\s@+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The label a human would read for this control.
 *
 * Tries the accessible sources in the order a screen reader would, then falls
 * back to nearby text — some forms render a styled <div> as the label with no
 * association at all, and those are exactly the ones a selector map misses.
 */
function labelFor(el) {
  const byAria = el.getAttribute("aria-label");
  if (byAria) return byAria;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ")
      .trim();
    if (text) return text;
  }

  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit?.innerText.trim()) return explicit.innerText;
  }

  const wrapping = el.closest("label");
  if (wrapping?.innerText.trim()) return wrapping.innerText;

  // Nearest preceding label-ish text within the field's own group.
  const group = el.closest("div,fieldset,section,li,td");
  if (group) {
    const candidate = group.querySelector("label,legend,[class*='label'],[class*='Label']");
    if (candidate?.innerText.trim()) return candidate.innerText;
  }

  return el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "";
}

const IGNORED_TYPES = new Set([
  "hidden", "submit", "button", "reset", "image", "checkbox", "radio",
]);

/**
 * Every control we could conceivably fill, each with its label already resolved.
 *
 * Labels are resolved here rather than in the fill loop because `labelFor` walks
 * the DOM and reads `innerText`, which forces layout. Doing that once per
 * control — instead of once per control per pass — is the difference between a
 * fill that feels instant and one that visibly hangs on a long form.
 */
function controls() {
  const out = [];
  for (const el of document.querySelectorAll("input, select, textarea")) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (IGNORED_TYPES.has(type)) continue;
    if (el.disabled || el.readOnly) continue;
    // Off-screen controls are usually a hidden duplicate form or a widget's
    // internals; filling those does nothing visible and can confuse the page.
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const raw = labelFor(el);
    const label = normalise(raw);
    if (!label) continue;
    out.push({ el, raw, label });
  }
  return out;
}

/**
 * Set a value the way React will keep.
 *
 * The native setter bypasses React's own value property descriptor, and the
 * bubbled `input` event is what its onChange is actually wired to; `change`
 * follows for plain listeners and validation.
 */
function setValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Is this a dropdown that isn't a native `<select>`?
 *
 * It matters because the two behave nothing alike, and treating one as the
 * other is what put "M.S. in Computer Science" into a degree box offering ten
 * fixed choices. Greenhouse, Ashby and Lever all build their dropdowns out of a
 * text input plus a popup listbox, so `el.value = "..."` succeeds at the DOM
 * level, looks filled, and submits nothing — the component's own state never
 * changed.
 *
 * Detected by the ARIA a combobox has to expose to be usable with a screen
 * reader. That is the one part such a widget cannot omit and still work, which
 * makes it the durable thing to key on.
 */
function isCombobox(el) {
  if (el instanceof HTMLSelectElement) return false;
  const role = (el.getAttribute("role") || "").toLowerCase();
  const haspopup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
  return (
    role === "combobox" ||
    el.hasAttribute("aria-autocomplete") ||
    el.hasAttribute("aria-expanded") ||
    ["listbox", "menu", "tree", "grid", "true"].includes(haspopup)
  );
}

/** The popup list this control drives, if it is open. */
function listboxFor(el) {
  const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  if (id) {
    const byId = document.getElementById(id);
    if (byId) return byId;
  }
  // Several libraries portal the listbox to <body> without wiring aria-controls.
  // Only take that route when exactly one is open, so we never drive a listbox
  // belonging to a different field.
  const open = Array.from(document.querySelectorAll('[role="listbox"]')).filter(
    (node) => node.getBoundingClientRect().height > 0
  );
  return open.length === 1 ? open[0] : null;
}

/** The choosable rows in a popup list. */
function optionNodes(box) {
  if (!box) return [];
  // Prefer the explicit role. Falling back to <li> as well would double-count
  // when a library marks up both, and the duplicate index picks the wrong row.
  const byRole = Array.from(box.querySelectorAll('[role="option"]'));
  const nodes = byRole.length ? byRole : Array.from(box.querySelectorAll("li"));
  return nodes.filter((node) => (node.textContent || "").trim());
}

const optionText = (node) => (node.textContent || "").replace(/\s+/g, " ").trim();

/** Click the way a component library expects: many commit on mousedown. */
function clickLike(node) {
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
    try {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    } catch {
      // MouseEvent is unavailable in a bare test DOM; the plain click below is
      // enough there, and on a real page all four dispatch fine.
    }
  }
  node.click?.();
}

function pressKey(el, key) {
  try {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
  } catch {
    /* same as above */
  }
}

/** Open the popup and wait for it to render. */
async function openListbox(el) {
  el.focus?.();
  clickLike(el);
  for (let tries = 0; tries < 12; tries += 1) {
    const box = listboxFor(el);
    if (optionNodes(box).length) return box;
    await pause(40);
  }
  return listboxFor(el);
}

/**
 * Text to type when a list renders nothing until it is filtered.
 *
 * A school autocomplete holds thousands of entries and shows none of them cold.
 * The value itself is the best first guess; a degree falls back to the word for
 * its level, because "M.S. in Computer Science" filters a degree list to
 * nothing while "Master" finds the row we want.
 */
function probesFor(value, kind) {
  const out = [String(value)];
  if (kind === "degree") {
    const level = window.HIRECRAFT_OPTIONS.degreeLevel(value);
    const word = {
      master: "Master", bachelor: "Bachelor", doctorate: "Doctor",
      mba: "Master of Business", jd: "Juris", md: "Doctor of Medicine",
      associate: "Associate", high_school: "High School",
    }[level];
    if (word) out.push(word);
  }
  const first = String(value).split(/\s+/)[0];
  if (first.length >= 3 && first !== value) out.push(first);
  return out;
}

/**
 * Pick `value` out of a combobox, or explain why it isn't there.
 *
 * On failure the box is left empty rather than holding the text we typed while
 * probing. A combobox showing "2027" that has committed nothing is exactly the
 * false impression this whole change exists to remove.
 */
async function chooseFromCombobox(el, value, kind, unit) {
  let box = await openListbox(el);
  let nodes = optionNodes(box);

  // An empty list means it filters as you type; a very long one means the match
  // we want may not be rendered yet.
  if (!nodes.length || nodes.length > 60) {
    for (const probe of probesFor(value, kind)) {
      setValue(el, probe);
      pressKey(el, probe.slice(-1) || "a");
      await pause(180);
      box = listboxFor(el) || box;
      nodes = optionNodes(box);
      if (nodes.length && nodes.length <= 60) break;
    }
  }

  if (!nodes.length) {
    setValue(el, "");
    pressKey(el, "Escape");
    return { ok: false, why: "the dropdown never showed any options" };
  }

  const texts = nodes.map(optionText);
  const { index, why } = window.HIRECRAFT_OPTIONS.chooseOption(value, texts, { kind, unit });
  if (index < 0) {
    setValue(el, "");
    pressKey(el, "Escape");
    return { ok: false, why, offered: texts.slice(0, 12) };
  }

  const chosen = texts[index];
  nodes[index].scrollIntoView?.({ block: "nearest" });
  clickLike(nodes[index]);
  await pause(120);
  if (committed(el, nodes[index], chosen)) return { ok: true, chosen, why };

  // The click was ignored. Some libraries only commit from the keyboard, so
  // try that once before giving up — arrow into the list and press Enter.
  el.focus?.();
  pressKey(el, "ArrowDown");
  await pause(60);
  pressKey(el, "Enter");
  await pause(120);
  if (committed(el, nodes[index], chosen)) return { ok: true, chosen, why };

  // Report the failure rather than the attempt. Returning success here was the
  // same mistake as the old `(setValue(...), true)`: the panel said a required
  // sponsorship question was answered while the form still had it empty.
  setValue(el, "");
  pressKey(el, "Escape");
  return { ok: false, why: `"${chosen}" was clicked but the dropdown didn't take it` };
}

/**
 * Did the component actually accept the choice?
 *
 * Two ways to tell, because the widgets differ: most write the chosen text into
 * the input, while some leave it blank and mark the row instead. Either is
 * proof; neither being true means the click went nowhere.
 */
function committed(el, node, chosen) {
  if (node.getAttribute?.("aria-selected") === "true") return true;
  const { normText } = window.HIRECRAFT_OPTIONS;
  const now = normText(String(el.value ?? "").trim());
  if (!now) return false;
  const want = normText(chosen);
  return now === want || now.includes(want) || want.includes(now);
}

/**
 * Set a value and check it survived.
 *
 * The check is the point. Until now this returned success unconditionally for
 * anything that wasn't a `<select>`, so the report described what was attempted
 * and was read as what happened — the difference being every field a
 * React-controlled component silently rejected.
 *
 * A field that reformats what it was given (a phone mask, a trimmed URL) counts
 * as filled and says what it now holds. Only an empty field is a failure.
 */
async function setAndVerify(el, value) {
  setValue(el, value);
  await pause(30); // a controlled component re-renders on the next tick
  const now = String(el.value ?? "").trim();
  if (!now) return { ok: false, why: "the field discarded the value" };

  const wanted = normalise(value);
  const got = normalise(now);
  if (got !== wanted && !got.includes(wanted) && !wanted.includes(got)) {
    return { ok: true, actual: now, note: `the field changed it to "${now}"` };
  }
  return { ok: true, actual: now };
}

/**
 * Attach the résumé to a file input.
 *
 * `input.files` is read-only, so the file has to arrive via a DataTransfer —
 * the same mechanism a real drag-and-drop uses, which is why the page accepts it.
 */
function attachFile(el, file) {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  el.files = transfer.files;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Turn the data URL the background worker sent back into a File. */
function fileFromDataUrl(dataUrl, filename) {
  const [header, base64] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(header)?.[1] || "application/pdf";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

/**
 * Fill the form from `profile`.
 *
 * Returns a report of every decision made. That report is the feature, not
 * decoration: an autofiller that quietly skips a field is worse than one that
 * does nothing, because the user submits believing it worked.
 */
async function fillForm(
  profile,
  { resumeFile = null, overrides = {}, onProgress = null, stepDelay = 90 } = {}
) {
  const filled = [];
  const skipped = [];
  const missing = [];
  const claimed = new Set();

  for (const { el, raw, label } of controls()) {
    const skip = window.HIRECRAFT_SKIP.find((group) =>
      group.match.some((re) => re.test(label))
    );
    if (skip) {
      // Say *why* it was left. "Left for you" on a demographic question and on
      // a salary question mean different things, and the reader needs to know
      // which they are looking at.
      skipped.push({ label: raw.trim().slice(0, 60), why: skip.why });
      continue;
    }

    // Don't overwrite something already on the form — the user may have typed
    // it, or the page may have restored a draft.
    if (el.value && String(el.value).trim()) continue;

    const field =
      overrides[label] ||
      window.HIRECRAFT_FIELDS.find((f) => f.match.some((re) => re.test(label)));
    if (!field || claimed.has(field.key)) continue;
    // Left unclaimed on purpose, so a genuine country question later on the
    // form can still be answered.
    if (field.key === "country" && isPhoneCountryPicker(el)) continue;

    const value = String(field.from(profile) ?? "").trim();
    if (!value) {
      missing.push({ label: field.label, why: field.whenEmpty || "nothing stored for this" });
      claimed.add(field.key);
      continue;
    }

    claimed.add(field.key);

    // Three kinds of control, three ways to commit a value — and each reports
    // what it actually managed, rather than that it tried.
    let result;
    if (el instanceof HTMLSelectElement) {
      const texts = Array.from(el.options || []).map((o) => o.text);
      const choice = window.HIRECRAFT_OPTIONS.chooseOption(value, texts, {
          kind: field.kind,
          unit: field.unit,
        });
      if (choice.index >= 0) {
        setValue(el, el.options[choice.index].value);
        result = { ok: true, actual: texts[choice.index] };
      } else {
        result = { ok: false, why: choice.why, offered: texts.slice(0, 12) };
      }
    } else if (field.key === "location" && needsPlacePick(el)) {
      result = await pickPlace(el, value);
    } else if (isCombobox(el)) {
      result = await chooseFromCombobox(el, value, field.kind, field.unit);
      if (result.ok) result.actual = result.chosen;
    } else {
      result = await setAndVerify(el, value);
    }

    if (result.ok) {
      filled.push({ label: field.label, value: result.actual ?? value, note: result.note });
      // Let the caller follow along. Watching each field fill is how you check
      // the work — a form that is simply full when you look up tells you
      // nothing about whether the right answer went in the right box.
      if (onProgress) {
        onProgress({ el, label: field.label, value: result.actual ?? value });
        if (stepDelay) await pause(stepDelay);
      }
    } else {
      missing.push({ label: field.label, why: result.why, offered: result.offered });
    }
  }

  // Résumé upload, handled separately: file inputs are excluded from `controls`
  // because everything above them assumes a text value.
  if (resumeFile) {
    const target = findUploadInput(window.HIRECRAFT_RESUME_FILE, window.HIRECRAFT_NOT_RESUME);
    if (target) {
      try {
        attachFile(target, resumeFile);
        filled.push({ label: "Résumé", value: resumeFile.name });
        if (onProgress) onProgress({ el: target, label: "Résumé", value: resumeFile.name });
      } catch (error) {
        missing.push({ label: "Résumé", why: "the upload field refused the file" });
      }
    } else {
      missing.push({
        label: "Résumé",
        why: document.querySelector('input[type="file"]')
          ? "couldn't tell which upload box"
          : "no upload box on this page",
      });
    }
  }

  // Checked last, so anything the fill just satisfied no longer counts.
  return { filled, skipped, missing, required: requiredGaps() };
}

/**
 * Find the file input for a particular upload.
 *
 * A real application form has several. The Verkada/Greenhouse form carries four
 * — résumé, cover letter, undergraduate transcript, graduate transcript — and
 * each is a hidden input behind an "Attach" button, so the input itself has no
 * usable label of its own. The label lives on the *section*, so the search walks
 * up from the input until it finds an ancestor whose text names one upload and
 * not the others. `reject` matters as much as `want`: without it the résumé
 * lands in the cover-letter box, which is worse than not filling at all.
 */
function findUploadInput(want, reject = []) {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  if (!inputs.length) return null;

  for (const input of inputs) {
    // The input's own label first, when it has one.
    const own = normalise(labelFor(input));
    if (own && want.some((re) => re.test(own)) && !reject.some((re) => re.test(own))) {
      return input;
    }
  }

  for (const input of inputs) {
    let node = input.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      // textContent, not innerText: innerText forces a layout pass per ancestor
      // per input, and the difference in what they return does not matter for
      // deciding which upload a section is about.
      const text = normalise((node.textContent || "").slice(0, 400));
      if (!text) continue;
      const wanted = want.some((re) => re.test(text));
      const rejected = reject.some((re) => re.test(text));
      // Stop at the first ancestor that mentions any upload at all: going
      // further reaches a container holding every upload on the form, where
      // "resume" and "cover letter" both appear and the answer is meaningless.
      if (wanted || rejected) {
        if (wanted && !rejected) return input;
        break;
      }
    }
  }
  return null;
}

/**
 * Is this a place autocomplete whose real answer is a pair of coordinates?
 *
 * Greenhouse's Location field is required and carries two hidden inputs,
 * latitude and longitude, which are only written when a suggestion is picked
 * from its dropdown. Typing the city name fills the visible box and leaves both
 * empty, so the form looks answered and refuses to submit — a failure that only
 * appears at the very end, after everything else has been filled.
 *
 * Detected by those hidden inputs rather than by the label, because the label
 * is just "Location" and says nothing about the coordinates behind it.
 */
function needsPlacePick(el) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    if (
      node.querySelector?.('input[name="latitude"], input[name="longitude"], [name*="lat"][type="hidden"]')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Fill a place field by choosing from its suggestions.
 *
 * Types the location, waits for the dropdown, and clicks the first suggestion —
 * "first" rather than best-matched because a place autocomplete has already
 * ranked them against exactly the string we typed, and second-guessing that
 * ranking with our own text comparison would be worse, not better.
 */
async function pickPlace(el, value) {
  setValue(el, value);
  pressKey(el, value.slice(-1) || "a");

  for (let tries = 0; tries < 14; tries += 1) {
    await pause(120);
    const nodes = optionNodes(listboxFor(el));
    if (!nodes.length) continue;
    const chosen = optionText(nodes[0]);
    nodes[0].scrollIntoView?.({ block: "nearest" });
    clickLike(nodes[0]);
    await pause(140);
    if (String(el.value ?? "").trim()) return { ok: true, actual: chosen };
  }

  // Leave the typed text: it is the right city, and a human can pick the
  // suggestion in one click. Say so rather than claiming the field is done.
  return {
    ok: false,
    why: "pick a suggestion from this dropdown — the form needs the coordinates behind it",
  };
}

/**
 * Is this the dial-code picker belonging to a phone field?
 *
 * Those are labelled "Country" and read "United States +1", so the country
 * field claims them. That is worse than useless: the country slot is spent on a
 * widget the phone number already implies, and a real country question further
 * down the form is then skipped as already answered.
 *
 * Detected by looking for a telephone input in the same neighbourhood, which is
 * what actually makes it a dial-code picker, rather than by the label — the
 * label is the thing that misleads here.
 */
function isPhoneCountryPicker(el) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    if (node.querySelector?.('input[type="tel"]')) return true;
    if (/phone|dial[-_ ]?code|country[-_ ]?code/i.test(String(node.className || ""))) {
      return true;
    }
  }
  return false;
}

/**
 * Required questions the form still has no answer for.
 *
 * Filling is only half of not-submitting-a-broken-application. Verkada's form
 * requires an undergraduate transcript, a Yes/No on working onsite in the Bay
 * Area, and all four EEOC questions; a filler that reports fifteen successes
 * and says nothing about the required boxes it never touched has told the user
 * the form is ready when it is not.
 *
 * Read from the page rather than from our own catalogue, so a question nobody
 * anticipated still gets counted.
 */
function requiredGaps() {
  const gaps = [];
  const groupChecked = new Map();

  for (const el of document.querySelectorAll("input, select, textarea")) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
    if (el.disabled) continue;

    // Only what a person could actually fill. A widget's hidden mirror input
    // is not a question anyone can answer, and listing it sends the user
    // hunting the page for a box that is not on it — which is exactly what
    // happened: a report said "Country still empty" about the invisible half
    // of a phone field whose visible half had just been filled.
    //
    // File inputs are the exception. They are routinely hidden behind an
    // "Attach" button and are still genuinely required.
    if (type !== "file") {
      const box = el.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
    }

    const raw = (labelFor(el) || "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    // The asterisk is how most boards mark a required field, and it is often
    // the only marker — plenty never set the `required` attribute at all.
    const required =
      el.hasAttribute("required") ||
      el.getAttribute("aria-required") === "true" ||
      /[*✱]|\brequired\b/i.test(raw);
    if (!required) continue;

    let empty;
    if (type === "file") {
      empty = !(el.files && el.files.length);
    } else if (type === "radio" || type === "checkbox") {
      // One answer satisfies the whole group, so judge the group, not the box.
      const name = el.getAttribute("name") || raw;
      if (!groupChecked.has(name)) {
        const peers = name
          ? Array.from(document.querySelectorAll(`[name="${CSS.escape(name)}"]`))
          : [el];
        groupChecked.set(name, peers.some((p) => p.checked));
      }
      empty = !groupChecked.get(name);
    } else {
      empty = !String(el.value ?? "").trim();
    }
    if (empty) gaps.push(raw.replace(/[*✱]/g, "").trim().slice(0, 70));
  }
  return [...new Set(gaps)];
}

/** Every control with its resolved label — how adapters get built and debugged. */
function inspectForm() {
  const seen = controls();
  const rows = seen.map(({ el, raw, label }) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: raw.replace(/\s+/g, " ").trim().slice(0, 90),
    normalised: label.slice(0, 90),
    // The three things needed to explain a fill that went wrong from a report
    // alone: what kind of control it is, whether it already holds something,
    // and whether the form insists on it.
    combobox: isCombobox(el),
    value: String(el.value ?? "").slice(0, 60),
    required:
      el.hasAttribute("required") ||
      el.getAttribute("aria-required") === "true" ||
      /[*✱]/.test(raw),
    matched: (window.HIRECRAFT_FIELDS.find((f) => f.match.some((re) => re.test(label))) || {}).key
      || (window.HIRECRAFT_SKIP.find((g) => g.match.some((re) => re.test(label))) ? "(skipped)" : ""),
  }));
  return rows;
}

window.HIRECRAFT_FILL = {
  fillForm,
  inspectForm,
  fileFromDataUrl,
  normalise,
  labelFor,
  isCombobox,
  setAndVerify,
  requiredGaps,
  findUploadInput,
  attachFile,
  needsPlacePick,
};
