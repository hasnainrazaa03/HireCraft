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

/** Every control on the page we could conceivably fill. */
function controls() {
  return Array.from(
    document.querySelectorAll("input, select, textarea")
  ).filter((el) => {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "checkbox", "radio"].includes(type)) {
      return false;
    }
    if (el.disabled || el.readOnly) return false;
    // Off-screen controls are usually a hidden duplicate form or a widget's
    // internals; filling those does nothing visible and can confuse the page.
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
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
function fillForm(profile, { resumeFile = null, overrides = {} } = {}) {
  const filled = [];
  const skipped = [];
  const missing = [];
  const claimed = new Set();

  for (const el of controls()) {
    const raw = labelFor(el);
    const label = normalise(raw);
    if (!label) continue;

    if (window.HIRECRAFT_SKIP.some((re) => re.test(label))) {
      skipped.push({ label: raw.trim().slice(0, 60), why: "left for you to answer" });
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
    } else {
      missing.push({ label: field.label, why: "no matching option" });
    }
  }

  // Résumé upload, handled separately: file inputs are excluded from `controls`
  // because everything above them assumes a text value.
  if (resumeFile) {
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const target =
      fileInputs.find((el) => window.HIRECRAFT_RESUME_FILE.some((re) => re.test(normalise(labelFor(el))))) ||
      (fileInputs.length === 1 ? fileInputs[0] : null);
    if (target) {
      try {
        attachFile(target, resumeFile);
        filled.push({ label: "Résumé", value: resumeFile.name });
      } catch (error) {
        missing.push({ label: "Résumé", why: "the upload field refused the file" });
      }
    } else {
      missing.push({
        label: "Résumé",
        why: fileInputs.length ? "couldn't tell which upload box" : "no upload box on this page",
      });
    }
  }

  return { filled, skipped, missing };
}

/** Every control with its resolved label — how adapters get built and debugged. */
function inspectForm() {
  return controls().map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: labelFor(el).replace(/\s+/g, " ").trim().slice(0, 90),
    normalised: normalise(labelFor(el)).slice(0, 90),
  }));
}

window.HIRECRAFT_FILL = { fillForm, inspectForm, fileFromDataUrl, normalise, labelFor };
