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

/** Choose the option whose text best matches `value`. */
function selectOption(el, value) {
  const want = normalise(value);
  if (!want) return false;
  const options = Array.from(el.options || []);
  const exact = options.find((o) => normalise(o.text) === want);
  const partial =
    exact ||
    options.find((o) => normalise(o.text).includes(want) || want.includes(normalise(o.text)));
  if (!partial) return false;
  setValue(el, partial.value);
  return true;
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

    const value = String(field.from(profile) ?? "").trim();
    if (!value) {
      missing.push({ label: field.label, why: "nothing stored for this" });
      claimed.add(field.key);
      continue;
    }

    const ok =
      el instanceof HTMLSelectElement ? selectOption(el, value) : (setValue(el, value), true);
    if (ok) {
      filled.push({ label: field.label, value });
      claimed.add(field.key);
      // Let the caller follow along. Watching each field fill is how you check
      // the work — a form that is simply full when you look up tells you
      // nothing about whether the right answer went in the right box.
      if (onProgress) {
        onProgress({ el, label: field.label, value });
        if (stepDelay) await pause(stepDelay);
      }
    } else {
      missing.push({ label: field.label, why: "no matching option" });
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

  return { filled, skipped, missing };
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

/** Every control with its resolved label — how adapters get built and debugged. */
function inspectForm() {
  return controls().map(({ el, raw, label }) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: raw.replace(/\s+/g, " ").trim().slice(0, 90),
    normalised: label.slice(0, 90),
  }));
}

window.HIRECRAFT_FILL = { fillForm, inspectForm, fileFromDataUrl, normalise, labelFor };
