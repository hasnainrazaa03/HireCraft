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
    // Split camelCase before anything else. Greenhouse's compliance questions
    // arrive labelled "VeteranStatus" and "DisabilityStatus" with no separator,
    // so \bveterans?\b found no word boundary and both went unanswered — the
    // two questions this whole self-identification feature exists for.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
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
 * What this control currently holds, as a person would read it.
 *
 * react-select leaves its text input empty after a selection and renders the
 * chosen value beside it, so `el.value` is the wrong question to ask. Asking it
 * anyway made the required-gaps list name Degree, work authorisation and
 * sponsorship as still empty on a form where all three had just been filled.
 */
function displayedValue(el) {
  const own = String(el.value ?? "").trim();
  if (own) return own;

  // Only a combobox keeps its value somewhere other than its input. Walking a
  // plain input's ancestors reached the react-select next door and read *its*
  // displayed value: the Phone box was judged to already hold "United States
  // +1" from the country picker beside it, and End-year to hold "December"
  // from the month picker, so both were passed over — and passed over so early
  // that neither appeared anywhere in the report.
  if (!isCombobox(el)) return "";

  let node = el.parentElement;
  for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
    // Same boundary as everywhere else: a second visible control means we have
    // left this field and are reading someone else's answer.
    const others = Array.from(node.querySelectorAll?.("input,select,textarea") || []).filter(
      (c) => c !== el && (c.getBoundingClientRect?.()?.width ?? 1) > 0
    );
    if (others.length) return "";
    const shown = node.querySelector?.(
      "[class*='single-value'],[class*='singleValue'],[class*='multi-value'],[class*='multiValue']"
    );
    const text = shown && String(shown.textContent ?? "").trim();
    if (text) return text;
  }
  return "";
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

/**
 * Every option list currently visible anywhere on the page.
 *
 * Used to tell "the list this control just opened" from "a list that was
 * already lying open". Three wrong answers have come from confusing the two,
 * most recently a phone-country picker that stayed open and was then read as
 * the option list for Location, for School, and for anything else that asked.
 */
function visibleListboxes() {
  const seen = new Set();
  const out = [];
  const consider = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (optionNodes(node).length) out.push(node);
  };
  for (const node of document.querySelectorAll('[role="listbox"]')) consider(node);
  // Not every library marks the container; some only mark the rows.
  for (const option of document.querySelectorAll('[role="option"]')) {
    const box = option.parentElement;
    if (box && !seen.has(box)) consider(box);
  }
  return out;
}

/** A short, readable path to an element — for the diagnostics dump. */
function pathTo(node) {
  const parts = [];
  let at = node;
  for (let depth = 0; at && depth < 4; depth += 1, at = at.parentElement) {
    const cls = String(at.className || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    parts.unshift(
      (at.tagName || "?").toLowerCase() + (at.id ? `#${at.id}` : "") + (cls ? `.${cls}` : "")
    );
  }
  return parts.join(" > ");
}

/** The popup list this control drives, if it is open. */
/**
 * The list this control names through ARIA, if any.
 *
 * Only the explicit link is trusted here. Every positional rule tried before
 * this — the single open listbox in the document, then a walk up the ancestors
 * — eventually reached the field next door, because on a real form every
 * control shares an ancestor with every other one. Anything not named is found
 * instead by watching which list appears when we act, in openListbox.
 */
function namedListbox(el, { requireOptions = false } = {}) {
  if (el.getAttribute("aria-expanded") === "false") return null;
  const id = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  if (!id) return null;
  const box = document.getElementById(id);
  if (!box) return null;
  // An open menu with nothing in it is the normal state of a search-backed
  // select — a city or school list holds thousands of entries and renders none
  // until you type. Insisting on options here made those look unopened, so the
  // opener kept trying, and its next move closed them.
  return !requireOptions || optionNodes(box).length ? box : null;
}

/** Kept for callers that only need whatever list is currently associated. */
function listboxFor(el) {
  return namedListbox(el);
}

/** Shut the popup, so the next field cannot inherit it. */
function closeListbox(el) {
  pressKey(el, "Escape");
  el.blur?.();
  // Escape is not honoured by every widget, and a menu left open becomes the
  // next field's problem. A mousedown elsewhere is what a person would do, and
  // outside-click handlers are near-universal.
  try {
    document.body?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  } catch {
    /* no MouseEvent in a bare test DOM */
  }
}

/** The choosable rows in a popup list. */
function optionNodes(box) {
  if (!box) return [];
  // Prefer the explicit role. Falling back to <li> as well would double-count
  // when a library marks up both, and the duplicate index picks the wrong row.
  const byRole = Array.from(box.querySelectorAll('[role="option"]'));
  const nodes = byRole.length ? byRole : Array.from(box.querySelectorAll("li"));
  return nodes.filter((node) => {
    if (!(node.textContent || "").trim()) return false;
    // A closed dropdown often keeps its rows in the DOM, just hidden. Counting
    // those made a shut phone-country list look like an open one, and the
    // Location and School fields were offered "United States +1 · Afghanistan
    // +93 · Åland Islands +358 …" as their choices.
    const box2 = node.getBoundingClientRect?.();
    return !box2 || box2.height > 0;
  });
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
  // Whatever is already open is, by definition, not ours. Recording it first
  // means a dropdown someone forgot to close can never be mistaken for the one
  // this control opens — which is the failure that keeps recurring, because
  // every rule based on DOM position eventually finds a way to reach a sibling.
  const before = new Set(visibleListboxes());
  const isOpen = () => el.getAttribute("aria-expanded") === "true";

  const mine = () => {
    const named = namedListbox(el);
    if (named) return named;
    const fresh = visibleListboxes().filter((box) => !before.has(box));
    return fresh.length === 1 ? fresh[0] : null;
  };

  el.focus?.();
  // A gap between focusing and acting. react-select decides what a mousedown
  // means from its own isFocused state, and React has not applied the focus yet
  // if both happen in the same task — so it reads the click as "focus me",
  // sets a flag to open on the focus that already happened, and never opens.
  await pause(60);

  // The keyboard first, because it is unconditional: react-select maps ArrowDown
  // straight to openMenu, while a synthetic mousedown has to survive branching
  // on state we cannot see.
  pressKey(el, "ArrowDown");
  for (let tries = 0; tries < 8; tries += 1) {
    const box = mine();
    if (box || isOpen()) return box;
    await pause(70);
  }

  // Only if it is still shut. A mousedown on an *open* react-select closes it —
  // so the fallback used to undo the keyboard, and a search-backed select (open
  // but empty until typed into) was toggled shut every single time.
  if (!isOpen()) {
    clickLike(el.closest?.("[class*='control'],[class*='select-shell'],[role='combobox']") || el);
    for (let tries = 0; tries < 10; tries += 1) {
      const box = mine();
      if (box || isOpen()) return box;
      await pause(70);
    }
  }
  return mine();
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
/**
 * Choose from a dropdown, and always leave it shut.
 *
 * The closing is not tidiness. A menu left open was picked up by the *next*
 * field's search for a list to read, so a work-authorisation question was
 * offered a set of degrees to choose from. Every exit path closes, including
 * the ones that throw.
 */
async function chooseFromCombobox(el, value, kind, unit, context) {
  try {
    return await chooseFromComboboxInner(el, value, kind, unit, context);
  } finally {
    closeListbox(el);
  }
}

async function chooseFromComboboxInner(el, value, kind, unit, context) {
  let box = await openListbox(el);
  let nodes = optionNodes(box);

  // An empty list means it filters as you type; a very long one means the match
  // we want may not be rendered yet.
  const probes = [];
  if (!nodes.length || nodes.length > 60) {
    for (const probe of probesFor(value, kind)) {
      setValue(el, probe);
      pressKey(el, probe.slice(-1) || "a");
      // Poll rather than wait once: these lists are fetched, and a single
      // 180ms guess was shorter than the round trip on every one of them.
      for (let tries = 0; tries < 14; tries += 1) {
        await pause(120);
        box = namedListbox(el) || box;
        nodes = optionNodes(box);
        if (nodes.length && nodes.length <= 60) break;
      }
      probes.push({ typed: probe, options: nodes.length });
      if (nodes.length && nodes.length <= 60) break;
    }
  }

  if (!nodes.length) {
    setValue(el, "");
    return { ok: false, why: "the dropdown never opened", listbox: null, probes };
  }

  const texts = nodes.map(optionText);
  // Where the list came from, in the report. When a field is offered the wrong
  // options, this is the line that says which control's list it actually read.
  const listbox = {
    from: namedListbox(el) === box ? "aria-controls" : "appeared-on-open",
    at: pathTo(box),
    count: texts.length,
    sample: texts.slice(0, 4),
    probes,
  };
  const { index, why } = window.HIRECRAFT_OPTIONS.chooseOption(value, texts, { kind, unit, context });
  if (index < 0) {
    // Only the probe text is cleared here; the wrapper does the closing.
    setValue(el, "");
    return { ok: false, why, offered: texts.slice(0, 12), listbox };
  }

  const chosen = texts[index];
  nodes[index].scrollIntoView?.({ block: "nearest" });
  clickLike(nodes[index]);
  await pause(120);
  if (committed(el, nodes[index], chosen)) return { ok: true, chosen, why, listbox };

  // The click was ignored. Some libraries only commit from the keyboard, so
  // try that once before giving up — arrow into the list and press Enter.
  el.focus?.();
  pressKey(el, "ArrowDown");
  await pause(60);
  pressKey(el, "Enter");
  await pause(120);
  if (committed(el, nodes[index], chosen)) return { ok: true, chosen, why, listbox };

  // Report the failure rather than the attempt. Returning success here was the
  // same mistake as the old `(setValue(...), true)`: the panel said a required
  // sponsorship question was answered while the form still had it empty.
  setValue(el, "");
  return { ok: false, why: `"${chosen}" was clicked but the dropdown didn't take it`, listbox };
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
  const want = normText(chosen);
  const matches = (text) => {
    const now = normText(String(text ?? "").trim());
    return Boolean(now) && (now === want || now.includes(want) || want.includes(now));
  };

  if (matches(displayedValue(el))) return true;

  // Some builds mirror the value into a hidden input for form submission.
  let node2 = el.parentElement;
  for (let depth = 0; node2 && depth < 5; depth += 1, node2 = node2.parentElement) {
    for (const hidden of node2.querySelectorAll?.("input[type='hidden'],input[aria-hidden='true']") || []) {
      if (matches(hidden.value)) return true;
    }
  }
  return false;
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
  // A record of every decision, for when the panel's summary is not enough to
  // explain what went wrong. Costs nothing to build and has repeatedly been the
  // difference between diagnosing a fill and guessing at it.
  const trace = [];

  for (const { el, raw, label } of controls()) {
    const skip = window.HIRECRAFT_SKIP.find((group) =>
      group.match.some((re) => re.test(label))
    );
    if (skip) {
      trace.push({ label: raw.trim().slice(0, 70), at: pathTo(el), outcome: "skipped", why: skip.why });
      // Say *why* it was left. "Left for you" on a demographic question and on
      // a salary question mean different things, and the reader needs to know
      // which they are looking at.
      skipped.push({ label: raw.trim().slice(0, 60), why: skip.why });
      continue;
    }

    // Don't overwrite something already on the form — the user may have typed
    // it, or the page may have restored a draft. Traced, because a field that
    // vanishes from the report entirely is the hardest kind to notice: Phone
    // and End-year were dropped here for two runs without appearing in filled,
    // missing, skipped or the trace.
    const already = displayedValue(el);
    if (already) {
      trace.push({
        label: raw.trim().slice(0, 70),
        at: pathTo(el),
        outcome: "left alone",
        why: `already holds "${already.slice(0, 40)}"`,
      });
      continue;
    }

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
      result = await chooseFromCombobox(el, value, field.kind, field.unit, field.context?.(profile));
      if (result.ok) result.actual = result.chosen;
    } else {
      result = await setAndVerify(el, value);
    }

    trace.push({
      label: raw.trim().slice(0, 70),
      at: pathTo(el),
      field: field.key,
      control: el instanceof HTMLSelectElement ? "select" : isCombobox(el) ? "combobox" : "text",
      wanted: value,
      outcome: result.ok ? "filled" : "failed",
      got: result.actual ?? result.chosen ?? null,
      why: result.why ?? null,
      listbox: result.listbox ?? null,
    });

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
  return { filled, skipped, missing, required: requiredGaps(), trace };
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
      node.querySelector?.(
        'input[name="latitude"],input[name="longitude"],input[name="selectedLocation"],' +
          '[name*="lat"][type="hidden"],[name*="placeId"]'
      )
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
      empty = !displayedValue(el);
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
  // Exported to be tested directly: choosing which list belongs to which
  // control has now been the cause of three separate wrong answers.
  listboxFor,
  optionNodes,
};
