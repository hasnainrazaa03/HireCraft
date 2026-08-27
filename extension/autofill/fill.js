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
 * Which build of the engine is running in the page.
 *
 * The panel already stamps itself, and the engine is the half that gets
 * blamed — a report says "the fill did nothing", not "the panel did nothing".
 * They are loaded together but they are separate files, and a tab left open
 * across a reload keeps whichever pair it started with, so a dump has to say
 * which pair that was.
 */
const BUILD = "2026-08-27.panel-redesign";

/**
 * When the current fill has to stop.
 *
 * Every wait here is bounded and none of them were bounded together. A dropdown
 * that never resolves costs six and a half seconds of polling, four of them
 * cost twenty-six, and a page like Workday's has more than four — so a fill
 * could run for minutes with the panel saying "Filling…" the whole time, which
 * is indistinguishable from a hang and was reported as one.
 *
 * Module-level because every poll below needs it and threading a deadline
 * through eight call sites would obscure more than it explains. It is set once
 * per fill and read nowhere else.
 */
let fillDeadline = Infinity;
const outOfTime = () => Date.now() > fillDeadline;

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
 * What a control says about itself when nothing else names it.
 *
 * A <select>'s prompt is its first option — "Month…" — not a placeholder
 * attribute, which it does not have. Reading only the attribute is why Ashby's
 * four date pickers resolved to no label at all and were dropped by the scan.
 */
function ownHint(el) {
  const attr = (el.getAttribute?.("placeholder") || el.getAttribute?.("aria-label") || "").trim();
  if (attr) return attr;
  const first = el.options?.[0];
  return (first?.text || "").trim();
}

/**
 * The label a human would read for this control.
 *
 * Tries the accessible sources in the order a screen reader would, then falls
 * back to nearby text — some forms render a styled <div> as the label with no
 * association at all, and those are exactly the ones a selector map misses.
 */
function labelFor(el) {
  // Called over arbitrary elements since the widget scan widened, and not every
  // node in a page answers the whole Element interface.
  if (!el?.getAttribute) return "";
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
    if (explicit?.innerText?.trim()) return explicit.innerText;
  }

  const wrapping = el.closest?.("label");
  if (wrapping?.innerText?.trim()) return wrapping.innerText;

  // Nearest label-ish text, walking outward. One level is not enough: Ashby
  // nests a combobox input a few divs inside its field wrapper, so the single
  // `closest("div")` found only the inner shell, fell through to the
  // placeholder, and asked the catalogue to match "Search schools…" and "Start
  // typing…" — which describe the widget rather than the question.
  //
  // The walk stops at the first ancestor holding another visible control, for
  // the same reason every other walk here does: past that point the nearest
  // label belongs to the field next door.
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    const others = Array.from(node.querySelectorAll?.("input,select,textarea") || []).filter(
      (c) => c !== el && (c.getBoundingClientRect?.()?.width ?? 1) > 0
    );
    if (others.length) {
      // A "Start Date" heading sits above a Month box and a Year box, and
      // neither half carries a label of its own — so the walk hit the pair,
      // stopped, and fell through to the placeholder, leaving the catalogue
      // matching "Month…". The group's heading plus the box's own hint names it.
      const heading =
        node.querySelector?.("label,legend,[class*='label'],[class*='Label']")?.innerText?.trim() ||
        // Ashby names the pair's wrapper with an id and gives it no label at
        // all: `_systemfield_education_history-startDate` holds a Month select
        // and a Year select, and the words are in the id or nowhere.
        node.id ||
        "";
      const own = ownHint(el);
      if (heading && own) return `${heading} ${own}`;
      break;
    }
    const candidate = node.querySelector?.(
      "label,legend,[class*='label'],[class*='Label'],[class*='question'],[class*='Question']"
    );
    const text = candidate?.innerText?.trim();
    if (text) return text;
  }

  // Workday names every control with a data-automation-id, and the names are
  // semantic rather than generated: legalNameSection_firstName, email,
  // phone-number. That is a better label than a placeholder, and it is the
  // hook Workday itself keeps stable across releases.
  //
  // Separators become spaces first: the camelCase split leaves
  // "section_first name", and an underscore is a word character, so \bfirst
  // never matches across it.
  const automation = el.getAttribute("data-automation-id");
  if (automation) return automation.replace(/[_-]+/g, " ");

  // The placeholder last. It is a hint about how to use the box, not a name for
  // what it holds, and preferring it over a real label was the whole bug above.
  return el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "";
}

/**
 * A label with the widget's own prompt taken off the end.
 *
 * Workday builds a dropdown's accessible name out of the question and its
 * current state: "Degree Select One Required". The question is "Degree", and
 * the catalogue asks for exactly that — so the Degree box on both education
 * blocks matched nothing and stayed empty, on a form that marks it required.
 *
 * State already worked, but only by luck: its pattern happens to be anchored at
 * the start rather than at both ends. Taking the prompt off makes that true on
 * purpose.
 */
function withoutPrompt(text) {
  return String(text || "")
    .replace(/\s*\b(select|choose)\s+(one|an?\s+\w+)\s*$/i, "")
    .replace(/\s*\bselect\s*(\.\.\.|…)\s*$/i, "")
    .trim();
}

/**
 * Things the filler must never click, whatever a label match might suggest.
 *
 * The whole design rests on never submitting an application, and a widened scan
 * is one bad label match away from breaking that. Refused by name as well as by
 * the field gate, because two independent reasons to not press Submit is the
 * right number.
 */
/** What counts as clickable when looking for a row of choices. */
const CLICKABLE = 'button,[role="button"],[role="radio"],[role="option"]';

/**
 * What kind of element is this?
 *
 * By tag rather than by instanceof. An element from another document — an
 * iframe, which is how several ATSs build their forms — is not an instance of
 * *this* window's HTMLSelectElement, so instanceof quietly answers "no" and the
 * control gets driven as though it were a text box.
 */
const isTag = (el, tag) => String(el?.tagName || "").toUpperCase() === tag;

const NEVER_TOUCH =
  /^(submit|apply|send|continue|next|back|previous|save|delete|remove|sign\s*in|log\s*in|register)\b/i;

const IGNORED_TYPES = new Set([
  "hidden", "submit", "button", "reset", "image", "checkbox", "radio",
  // Never a password. Workday puts a sign-in ahead of its form, so the filler
  // now runs on pages that have one, and nothing here holds a credential to
  // type into it — but a scan that can reach a password field is a scan one
  // bad label match away from writing something into it, and that is not a
  // risk worth carrying for a field we would never fill.
  "password",
]);

/**
 * Is this control part of HireCraft's own panel rather than the employer's form?
 *
 * The panel carries a résumé picker, and it was turning up in the form scan —
 * harmless so far only because no field pattern happened to match its label.
 * A filler that can reach into its own interface is one edit away from
 * answering an employer's question with its own dropdown.
 */
function isOurs(el) {
  return Boolean(el.closest?.("#hirecraft-root"));
}

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
  // Widgets that behave like a control without being one. Ashby's month and
  // year pickers appeared in no scan at all — not filled, not reported, not
  // even listed by Inspect — because they declare no ARIA whatsoever. So the
  // net is wider than "says it is a combobox": anything focusable and short
  // enough to be a value rather than a paragraph.
  //
  // Widening it is only safe because of the gate below — a control is clicked
  // only once its label has matched a field we hold an answer for. Nothing
  // named Submit or Apply can match one, and NEVER_TOUCH refuses them outright
  // regardless, because not submitting is the promise this whole thing rests on.
  const widgets = Array.from(
    document.querySelectorAll(
      '[role="combobox"],[aria-haspopup],[aria-expanded],button,[role="button"],[tabindex]'
    ) || []
  ).filter((el) => {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return false;
    if (isOurs(el) || el.closest?.("nav,[role='tablist'],header,footer")) return false;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length > 40) return false;
    if (NEVER_TOUCH.test(text)) return false;
    // Near a real control, or it is page furniture. Workday's chrome is all
    // focusable — a skip link, the nav, a settings menu, decorative spans —
    // and every one of them was being scanned, labelled and reported. Nothing
    // matched them, which is luck rather than design.
    let near = el.parentElement;
    let hasControl = Boolean(el.closest?.("form"));
    for (let depth = 0; !hasControl && near && depth < 5; depth += 1, near = near.parentElement) {
      if (near.querySelector?.("input,select,textarea")) hasControl = true;
    }
    if (!hasControl) return false;
    // One of a row of choices belongs to its group, not to this scan. Taking it
    // here as well would have the same question answered twice, by two
    // different mechanisms, with no way to tell which one landed.
    const siblings = Array.from(el.parentElement?.children || []).filter((child) =>
      child.matches?.(CLICKABLE)
    );
    return siblings.length < 2;
  });

  for (const el of [...document.querySelectorAll("input, select, textarea"), ...widgets]) {
    const widget = !["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (!widget && IGNORED_TYPES.has(type)) continue;
    if (el.disabled || el.readOnly) continue;
    if (isOurs(el)) continue;
    // Off-screen controls are usually a hidden duplicate form or a widget's
    // internals; filling those does nothing visible and can confuse the page.
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const raw = labelFor(el);
    // Normalised first, then de-prompted: Workday's name is "Degree Select One
    // Required", and the prompt is only at the end once `normalise` has taken
    // the "Required" off. The raw label keeps both, since that is what the page
    // actually says and the report should not pretend otherwise.
    const label = withoutPrompt(normalise(raw));
    if (!label) continue;
    out.push({ el, raw, label, widget });
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
  const proto = isTag(el, "TEXTAREA")
    ? HTMLTextAreaElement.prototype
    : isTag(el, "SELECT")
      ? HTMLSelectElement.prototype
      : isTag(el, "INPUT")
        ? HTMLInputElement.prototype
        : null;
  // Not a form control at all, and there is no writing to one that isn't.
  // Falling through to HTMLInputElement's setter and calling it on a <button>
  // throws "Illegal invocation" — the browser refusing a native method handed
  // the wrong kind of receiver. That is what took Workday's State field down,
  // and it would have taken every field after it too.
  //
  // Workday builds each of its dropdowns as a <button> with the popup's search
  // box as a separate element, so this is not an edge case there; it is how the
  // whole form is made.
  if (!proto) return false;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * Where typing goes for a control that cannot itself be typed into.
 *
 * A react-select is a text input, so probing it means writing to the element we
 * already have. Workday's prompt is a <button>, and the box you type in appears
 * beside it only once the popup is open — a different element, with no id, no
 * name and no label, which is why the scan discarded all three of them and the
 * diagnostics could only list them as "skipped by the scan".
 *
 * Found by looking, not by a selector map: the search box is the one visible
 * text input inside the popup or sharing the button's wrapper. Two candidates
 * means the wrapper holds a second field, and reaching into that is the mistake
 * this file has made three times already — so ambiguity gives up instead.
 */
function searchBoxFor(el) {
  if (isTag(el, "INPUT") || isTag(el, "TEXTAREA")) return el;

  // Inside the widget itself, first of all. Workday's date fields are a div per
  // segment with the real input inside it, and the walk below starts at the
  // parent — which holds the month box *and* the year box, so two candidates
  // came back, the ambiguity rule refused both, and all four date fields on a
  // work-experience block reported "nothing we could type into".
  const within = typeableIn(el, el);
  if (within.length === 1) return within[0];

  // Inside the popup this control names, if it names one.
  const inside = typeableIn(namedListbox(el), el);
  if (inside.length === 1) return inside[0];

  // Otherwise a sibling: Workday puts the search box next to the button that
  // opens it, under the same wrapper.
  let node = el.parentElement;
  for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
    const found = typeableIn(node, el);
    if (found.length === 1) return found[0];
    if (found.length > 1) return null;
  }
  return null;
}

/** Every box inside `root` that a person could type into, excluding `self`. */
function typeableIn(root, self) {
  return Array.from(root?.querySelectorAll?.("input,textarea") || []).filter(
    (c) =>
      c !== self &&
      !isOurs(c) &&
      !c.disabled &&
      !c.readOnly &&
      (c.getBoundingClientRect?.()?.width ?? 0) > 0 &&
      !["hidden", "checkbox", "radio", "submit", "button", "file"].includes(
        (c.getAttribute("type") || "text").toLowerCase()
      )
  );
}

/** Months, so a name can be written as a number and back. */
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Does this box want a month as "05" rather than as "May"?
 *
 * A dropdown of month names wants the name. A segmented date field wants two
 * digits, and says so: Workday's reads "MM / YYYY" beside it and its month
 * segment takes exactly two characters. Sending "May" to that box types nothing
 * at all — the field silently rejects what it cannot parse, so the failure
 * arrives as an empty date rather than as an error.
 */
function wantsDigits(el) {
  const own = `${el.getAttribute?.("placeholder") || ""} ${el.getAttribute?.("aria-label") || ""}`;
  if (/\bmm\b/i.test(own)) return true;
  const max = Number(el.getAttribute?.("maxlength") || 0);
  if (max > 0 && max <= 2) return true;
  let node = el.parentElement;
  for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
    if (/\bmm\s*\/\s*(dd\s*\/\s*)?yyyy\b/i.test((node.textContent || "").slice(0, 200))) return true;
  }
  return false;
}

/** "May" as "05", when the box asked for digits. */
function asDigits(value) {
  const name = normalise(value);
  const index = MONTH_NAMES.findIndex((month) => month.startsWith(name.slice(0, 3)));
  if (index < 0) return value;
  return String(index + 1).padStart(2, "0");
}

/**
 * The text a widget shows, unless what it shows is an invitation to choose.
 *
 * "Month…", "Select One", "Choose one" — every dropdown displays something
 * before it holds anything, and treating that as an answer means never filling
 * the field. Workday's is "Select One" with no ellipsis to give it away.
 */
function unlessPrompt(text) {
  const shown = String(text || "").replace(/\s+/g, " ").trim();
  if (/(…|\.\.\.)$/.test(shown)) return "";
  return /^(-+\s*)?(select|choose|pick)\b.{0,12}$/i.test(shown) ? "" : shown;
}

/**
 * A selection this control holds as a chip beside itself.
 *
 * A multi-select renders each answer as a removable pill and leaves its input
 * empty, so the input alone says nothing about whether the question has been
 * answered.
 */
function pillValue(el) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    // The boundary is checked before the pill rather than after, and the order
    // matters: the Phone Number box shares a section with the Country Phone
    // Code's pill, so looking for a pill first would have Phone Number read as
    // already holding "United States of America (+1)" and passed over. That is
    // this walk's oldest mistake and it has been made twice.
    const others = Array.from(node.querySelectorAll?.("input,select,textarea") || []).filter(
      (c) => c !== el && (c.getBoundingClientRect?.()?.width ?? 1) > 0
    );
    if (others.length) return "";
    const chip = node.querySelector?.("[id^='pill-'],[data-automation-id='selectedItem']");
    const text = chip && String(chip.textContent ?? "").replace(/\s+/g, " ").trim();
    // The accessible text carries its own instructions: "United States of
    // America (+1), press delete to clear value."
    if (text) return text.replace(/,\s*press delete.*$/i, "").trim();
  }
  return "";
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
  if (el.value === undefined) return unlessPrompt(el.innerText);

  // A <button> that opens a menu shows its selection as its own text, and its
  // `value` is a key from someone's database. Workday's Country button reads
  // "bc33aa3152ec42d4995f4791a106ed09" and its Phone Device Type button
  // "6d752225dbc64db4922d8b3cea770394" — neither empty nor an answer anybody
  // could check, and both went into the report exactly like that.
  //
  // Right for the wrong reason until now: a key is a non-empty string, so the
  // field read as already answered, which it was. A button showing "Select One"
  // over an empty value would have read as answered too.
  if (isTag(el, "BUTTON")) return unlessPrompt(el.innerText);

  const own = String(el.value ?? "").trim();
  if (own) return own;

  // A selection shown as a removable chip rather than as text in the box.
  // Workday's Country Phone Code is a text input holding nothing, beside a pill
  // reading "United States of America (+1)" — so it was named in the
  // required-still-empty list on a form where it is plainly answered, sending
  // the user hunting the page for a box that is already full. Which is the harm
  // that list exists to prevent, arriving from the other direction.
  const pill = pillValue(el);
  if (pill) return pill;

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
  if (isTag(el, "SELECT")) return false;
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
    if (!node || seen.has(node) || isOurs(node)) return;
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
async function closeListbox(el) {
  // The open marker sits on the widget's control element, not on the input —
  // react-select writes `select__control--menu-is-open` two levels above the
  // box you type in. Checking only the nearest classed ancestor read the wrong
  // element and would have called a stuck menu closed.
  const control = () =>
    el.closest?.("[class*='control'],[class*='select-shell'],[class*='container']") ||
    el.parentElement ||
    el;
  const stillOpen = () => {
    if (el.getAttribute("aria-expanded") === "true") return true;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      if (/menu-is-open|--is-open|\bis-open\b/.test(String(node.className || ""))) return true;
    }
    return false;
  };

  // Escape while focused is what most widgets listen for.
  pressKey(el, "Escape");
  await pause(40);
  if (!stillOpen()) return true;

  // Then a mousedown on the control itself. A mousedown on an *open*
  // react-select toggles it shut — the same behaviour that made this the wrong
  // way to open one, and therefore exactly the right way to close one.
  clickLike(control());
  await pause(60);
  if (!stillOpen()) return true;

  // Then outside, for widgets that only listen for a click elsewhere.
  try {
    document.body?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  } catch {
    /* no MouseEvent in a bare test DOM */
  }
  await pause(40);
  if (!stillOpen()) return true;

  // Then give up the focus, which closes the ones that ignore all of it.
  el.blur?.();
  await pause(40);
  // Reported rather than assumed. A dropdown left hanging open sits over the
  // next field on the page, and every version of this before the check said it
  // had closed without ever looking.
  return !stillOpen();
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

/**
 * The readable text of one option.
 *
 * innerText rather than textContent: Ashby renders a school as three separate
 * elements — name, country, domain — and textContent glues them into
 * "University of Southern CaliforniaUnited Statesusc.edu", which is what the
 * report then showed the user.
 */
/** Run a DOM read that may throw on a detached node, treating a throw as "gone". */
function safely(read) {
  try {
    return read();
  } catch {
    return false;
  }
}

const optionText = (node) => {
  const raw = (node.innerText ?? node.textContent) || "";
  // The first line is the option; the rest is detail beneath it. Ashby prints a
  // school's country and domain on their own lines, and joining all three made
  // the report read "University of Southern California United States usc.edu"
  // for a field the form had filled correctly.
  const [first] = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return (first || raw).replace(/\s+/g, " ").trim();
};

/** Click the way a component library expects: many commit on mousedown. */
function clickLike(node) {
  if (!node) return;
  // The precursors first, for libraries that commit on mousedown.
  for (const type of ["pointerdown", "mousedown", "mouseup"]) {
    try {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    } catch {
      // MouseEvent is unavailable in a bare test DOM.
    }
  }
  // Then exactly one click. Dispatching a click event *and* calling click()
  // fires a button's handler twice — harmless on an input, but it pressed "Add
  // Education" twice and produced two identical bachelor's entries on a form
  // that needed one.
  if (typeof node.click === "function") {
    node.click();
    return;
  }
  try {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  } catch {
    /* nothing left to try */
  }
}

function pressKey(el, key) {
  try {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key }));
  } catch {
    /* same as above */
  }
}

/**
 * Open the popup and wait for it to render.
 *
 * Returns the list *and* the way it was found, because finding it once is not
 * enough. A search-backed dropdown opens empty and renders its rows only after
 * something is typed, so the caller has to look again — and looking again by
 * ARIA alone fails on a widget that never named its popup in the first place.
 * Workday is one: its list appeared on open, then the poll after typing looked
 * only at `aria-controls`, found nothing, and would have gone round twelve
 * times reporting a dropdown that never opened while it stood open on screen.
 */
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
    if (box || isOpen()) return { box, find: mine };
    await pause(70);
  }

  // Only if it is still shut. A mousedown on an *open* react-select closes it —
  // so the fallback used to undo the keyboard, and a search-backed select (open
  // but empty until typed into) was toggled shut every single time.
  if (!isOpen()) {
    clickLike(el.closest?.("[class*='control'],[class*='select-shell'],[role='combobox']") || el);
    for (let tries = 0; tries < 10; tries += 1) {
      const box = mine();
      if (box || isOpen()) return { box, find: mine };
      await pause(70);
    }
  }
  return { box: mine(), find: mine };
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
  let result = null;
  try {
    result = await chooseFromComboboxInner(el, value, kind, unit, context);
    return result;
  } finally {
    // Recorded, not assumed. A menu that refuses to close hangs over the next
    // field on the page, and the Point72 country picker did exactly that for
    // several runs while every version of this function reported success by
    // saying nothing.
    const closed = await closeListbox(el);
    if (result && !closed) result.leftOpen = true;
  }
}

async function chooseFromComboboxInner(el, value, kind, unit, context) {
  const opened = await openListbox(el);
  let box = opened.box;
  let nodes = optionNodes(box);

  // Where to type, resolved after opening rather than before: Workday's search
  // box does not exist until the popup that holds it is on screen.
  const typing = searchBoxFor(el);

  // An empty list means it filters as you type; a very long one means the match
  // we want may not be rendered yet.
  const probes = [];
  if ((!nodes.length || nodes.length > 60) && typing) {
    for (const probe of probesFor(value, kind)) {
      if (outOfTime()) break;
      setValue(typing, probe);
      pressKey(typing, probe.slice(-1) || "a");
      // Poll rather than wait once: these lists are fetched, and a single
      // 180ms guess was shorter than the round trip on every one of them.
      for (let tries = 0; tries < 12 && !outOfTime(); tries += 1) {
        await pause(110);
        // The same way it was found the first time, not by ARIA alone. A widget
        // that never named its popup would otherwise have its rows arrive and
        // go unseen, which is a list standing open on screen being reported as
        // one that never opened.
        box = opened.find() || box;
        nodes = optionNodes(box);
        if (nodes.length && nodes.length <= 60) break;
      }
      probes.push({ typed: probe, options: nodes.length });
      if (nodes.length && nodes.length <= 60) break;
    }
  }

  if (!nodes.length) {
    if (typing) setValue(typing, "");
    return {
      ok: false,
      // Distinguished, because they need different fixes and the report is
      // where that gets decided. A list that never opened is a click that went
      // nowhere; a list with nowhere to type is a widget shaped unlike any yet
      // met, and it should say so rather than blame the click.
      why: typing ? "the dropdown never opened" : "the dropdown opened onto nothing we could type into",
      listbox: null,
      probes,
    };
  }

  const texts = nodes.map(optionText);
  // Where the list came from, in the report. When a field is offered the wrong
  // options, this is the line that says which control's list it actually read.
  const listbox = {
    from: namedListbox(el) === box ? "aria-controls" : "appeared-on-open",
    typedInto: typing === el ? "the control itself" : typing ? pathTo(typing) : "nothing",
    at: pathTo(box),
    count: texts.length,
    sample: texts.slice(0, 4),
    probes,
  };
  const { index, why } = window.HIRECRAFT_OPTIONS.chooseOption(value, texts, { kind, unit, context });
  if (index < 0) {
    // Only the probe text is cleared here; the wrapper does the closing.
    if (typing) setValue(typing, "");
    return { ok: false, why, offered: texts.slice(0, 12), listbox };
  }

  const chosen = texts[index];
  nodes[index].scrollIntoView?.({ block: "nearest" });
  clickLike(nodes[index]);
  await pause(120);
  if (committed(el, nodes[index], chosen)) {
    return { ok: true, chosen, why, listbox, node: nodes[index] };
  }

  // The click was ignored. Some libraries only commit from the keyboard, so
  // try that once before giving up — arrow into the list and press Enter.
  // Aimed at whatever has the focus: on Workday that is the search box, and
  // keys sent to the button behind an open popup go nowhere.
  const keys = typing || el;
  keys.focus?.();
  pressKey(keys, "ArrowDown");
  await pause(60);
  pressKey(keys, "Enter");
  await pause(120);
  if (committed(el, nodes[index], chosen)) {
    return { ok: true, chosen, why, listbox, node: nodes[index] };
  }

  // Report the failure rather than the attempt. Returning success here was the
  // same mistake as the old `(setValue(...), true)`: the panel said a required
  // sponsorship question was answered while the form still had it empty.
  if (typing) setValue(typing, "");
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
  if (node?.getAttribute?.("aria-selected") === "true") return true;

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
  // Forty seconds was set for a page of boxes. Workday's My Experience is three
  // sections the fill has to build first — two education blocks, a job, and a
  // skills list picked one at a time — and each dropdown on it costs a click, a
  // wait and a search. The run that prompted this had used the whole budget
  // before it reached the skills, then reported them as though the employer had
  // never heard of any of them.
  //
  // Long is safe now in a way it was not before: every field announces itself as
  // it is attempted, so a slow fill reads as a working one rather than a hung
  // one, and whatever is left says "press Fill again to carry on".
  { resumeFile = null, overrides = {}, onProgress = null, stepDelay = 90, budgetMs = 90000 } = {}
) {
  // A fill that cannot finish should say so rather than appear to hang. What
  // is left is reported and Fill can be pressed again — already-filled boxes
  // are left alone, so a second pass costs nothing and picks up where this one
  // stopped.
  fillDeadline = Date.now() + budgetMs;
  const filled = [];
  const skipped = [];
  const missing = [];
  const claimed = new Set();
  // A record of every decision, for when the panel's summary is not enough to
  // explain what went wrong. Costs nothing to build and has repeatedly been the
  // difference between diagnosing a fill and guessing at it.
  const trace = [];

  // What the form held before anything was touched.
  //
  // "Leave it alone if it already has something" exists to protect what the
  // *user* typed, and it was reading the live value instead — so when picking a
  // start month made Ashby default the year beside it to 2026, that default was
  // taken for an existing answer and 2025 was never written. A side effect of
  // our own filling is not somebody's answer, and the difference is only
  // visible from a snapshot taken first.
  const beforeFill = new Map();
  for (const { el } of controls()) beforeFill.set(el, displayedValue(el));

  // Single yes/no boxes, answered first. "Still Student?" decides whether the
  // end date is a question at all — the form disables it once the box is
  // ticked, and a disabled control is skipped by the scan below, which is the
  // right answer rather than a missed one.
  for (const { el, question } of checkboxQuestions()) {
    const label = normalise(question);
    if (!label) continue;
    const shown = question.replace(/\s+/g, " ").trim().slice(0, 70);

    const field = window.HIRECRAFT_FIELDS.find((f) => f.match.some((re) => re.test(label)));
    if (!field || claimed.has(field.key)) continue;
    const value = String(field.from(profile) ?? "").trim().toLowerCase();
    if (value !== "yes" && value !== "no") continue;
    claimed.add(field.key);

    // This loop runs before the main scan, so a throw here cost the entire
    // fill rather than one box — and these are the tick-boxes a page puts at
    // the top, which means the failure looked like Fill doing nothing at all.
    let how = null;
    let threw = null;
    try {
      how = await setCheckbox(el, value === "yes");
    } catch (error) {
      threw = error?.message || String(error);
    }
    const why = how ? `set by ${how}` : threw ? `this box threw: ${threw}` : "the box would not change";
    trace.push({
      label: shown,
      at: pathTo(el),
      field: field.key,
      control: "checkbox",
      wanted: value,
      outcome: how ? "filled" : "failed",
      got: how ? (value === "yes" ? "checked" : "unchecked") : null,
      why,
    });
    if (how) {
      filled.push({
        label: field.label,
        value: value === "yes" ? "Yes" : "No",
        holds: () => Boolean(el.checked) === (value === "yes"),
      });
    } else {
      missing.push({ label: field.label, why });
    }
  }

  const scanned = controls();
  for (const { el, raw, label, widget } of scanned) {
    if (outOfTime()) {
      missing.push({
        label: raw.trim().slice(0, 60) || "the rest of this form",
        why: "the fill ran out of time — press Fill again to carry on",
      });
      continue;
    }
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
    const already = beforeFill.has(el) ? beforeFill.get(el) : displayedValue(el);
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
    // Second guard, independent of the label match above.
    if (NEVER_TOUCH.test((el.innerText || "").trim()) || NEVER_TOUCH.test(raw.trim())) continue;
    // Left unclaimed on purpose, so a genuine country question later on the
    // form can still be answered. The label is checked as well as the markup:
    // the neighbour test looks for a telephone input, and Workday's phone
    // number box is type="text", so "Country Phone Code" reached the country
    // field and would have been sent a country name.
    if (
      field.key === "country" &&
      (isPhoneCountryPicker(el) || /\b(phone|dial|calling)\s*code\b/.test(label))
    ) {
      continue;
    }

    const value = String(field.from(profile) ?? "").trim();
    if (!value) {
      missing.push({ label: field.label, why: field.whenEmpty || "nothing stored for this" });
      claimed.add(field.key);
      continue;
    }

    claimed.add(field.key);

    // Say what is being attempted, not only what succeeded. A dropdown that
    // takes seconds to resolve left the status on the field before it, so the
    // panel looked frozen for exactly as long as the slowest control took.
    if (onProgress) onProgress({ el, label: field.label, attempting: true });

    // Every kind of control, through one place that knows how to reach each —
    // and each reporting what it actually managed rather than that it tried.
    //
    // Behind a catch, because one control must not cost the rest of the form.
    // This runs on pages nobody has seen, so a widget that throws when it is
    // driven is an ordinary thing to meet rather than a remote one — and until
    // now it ended the fill where it stood. Every field after it then went
    // unreported rather than unfilled, which from outside is a fill that hung.
    let result;
    try {
      result = await applyTo(el, field, value, profile, widget);
    } catch (error) {
      result = { ok: false, why: `this control threw: ${error?.message || error}` };
    }

    trace.push({
      label: raw.trim().slice(0, 70),
      at: pathTo(el),
      field: field.key,
      control: isTag(el, "SELECT") ? "select" : widget || isCombobox(el) ? "combobox" : "text",
      wanted: value,
      outcome: result.ok ? "filled" : "failed",
      got: result.actual ?? result.chosen ?? null,
      why: result.why ?? null,
      listbox: result.listbox ?? null,
      leftOpen: result.leftOpen ?? false,
    });

    if (result.ok) {
      filled.push({
        label: field.label,
        value: result.actual ?? value,
        note: result.note,
        // Re-checked the same way it was checked the first time. Asking a
        // weaker question here would drop a correct fill on a widget that
        // marks its chosen row rather than filling its input.
        holds: () =>
          result.node
            ? committed(el, result.node, result.chosen ?? value)
            : stillHolds(el, result.actual ?? value),
      });
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

  // Questions asked as a set of choices, which the loop above cannot see.
  for (const group of [...radioGroups(), ...buttonGroups()]) {
    const label = normalise(group.question);
    if (!label) continue;
    const shown = group.question.replace(/\s+/g, " ").trim().slice(0, 70);

    const alreadyAnswered = group.buttons
      ? group.options.some((option) => buttonChosen(option.el))
      : group.options.some((option) => option.el.checked);
    if (alreadyAnswered) {
      trace.push({ label: shown, outcome: "left alone", why: "already answered" });
      continue;
    }

    const skip = window.HIRECRAFT_SKIP.find((entry) => entry.match.some((re) => re.test(label)));
    if (skip) {
      skipped.push({ label: shown, why: skip.why });
      trace.push({ label: shown, outcome: "skipped", why: skip.why });
      continue;
    }

    const field = window.HIRECRAFT_FIELDS.find((f) => f.match.some((re) => re.test(label)));
    if (!field || claimed.has(field.key)) continue;

    const value = String(field.from(profile) ?? "").trim();
    if (!value) {
      missing.push({ label: field.label, why: field.whenEmpty || "nothing stored for this" });
      claimed.add(field.key);
      continue;
    }
    claimed.add(field.key);

    const texts = group.options.map((option) => option.text);
    const { index, why } = window.HIRECRAFT_OPTIONS.chooseOption(value, texts, {
      kind: field.kind,
      unit: field.unit,
      context: field.context?.(profile),
    });

    if (index < 0) {
      missing.push({ label: field.label, why, offered: texts.slice(0, 12) });
      trace.push({ label: shown, field: field.key, control: "radio", wanted: value, outcome: "failed", why });
      continue;
    }

    // Same catch as above, for the same reason: a row of choices is clicked
    // rather than written to, and clicking is the part that reaches furthest
    // into a page's own code.
    let how = null;
    let threw = null;
    try {
      how = group.buttons
        ? await pickButton(group.options[index])
        : await pickRadio(group.options[index]);
    } catch (error) {
      threw = error?.message || String(error);
    }
    const took = Boolean(how);
    trace.push({
      label: shown,
      at: pathTo(group.options[index].el),
      field: field.key,
      control: group.buttons ? "buttons" : "radio",
      wanted: value,
      outcome: took ? "filled" : "failed",
      got: took ? texts[index] : null,
      why: took ? why : threw ? `this control threw: ${threw}` : "the option would not take",
      listbox: {
        from: group.buttons ? "button-group" : "radio-group",
        count: texts.length,
        sample: texts.slice(0, 4),
        picked: how || null,
      },
    });

    if (took) {
      const chosen = group.options[index].el;
      filled.push({
        label: field.label,
        value: texts[index],
        holds: () => {
          if (group.buttons) return buttonChosen(chosen) || buttonChosen(chosen.parentElement);
          const node = (chosen.id ? document.getElementById(chosen.id) : null) || chosen;
          if (node?.getAttribute?.("aria-checked") === "true") return true;
          if (!node?.checked) return false;
          const row = node.closest?.("[class*='option'],[class*='Option'],[class*='choice']");
          return !(row && /(^|\s)false(\s|$)/.test(String(row.className || "")));
        },
      });
      if (onProgress) {
        onProgress({ el: group.options[index].el, label: field.label, value: texts[index] });
        if (stepDelay) await pause(stepDelay);
      }
    } else {
      missing.push({
        label: field.label,
        why: threw ? `this control threw: ${threw}` : "the option would not take",
      });
    }
  }

  // Sections a form starts without and grows on request.
  //
  // Two different situations wear the same shape. Greenhouse and Ashby put one
  // education block on the page and offer to add a second, so the first degree
  // is filled by the loop above and only the rest need adding. Workday's
  // Education section starts with nothing at all — there is no block until a
  // button makes one — so every degree needs adding, including the first.
  //
  // Told apart by looking rather than by knowing which board this is: if the
  // form has no School box, the loop above filled no degree, and entry zero is
  // still owed.
  const degrees = profile.education_all || [];
  const haveInlineEducation = blocksPresent(window.HIRECRAFT_FIELDS, "school") > 0;
  const owedDegrees = haveInlineEducation ? degrees.slice(1) : degrees;
  const ordinal = ["1st", "2nd", "3rd", "4th"];

  for (const [index, entry] of owedDegrees.entries()) {
    if (outOfTime()) break;
    const nth = ordinal[haveInlineEducation ? index + 1 : index] || `${index + 1}th`;
    try {
      await addEducation(entry, { trace, filled, missing, onProgress, stepDelay, nth });
    } catch (error) {
      // Pressing Add makes a form grow a whole new section, which is the most
      // page-specific thing this engine does. A failure there used to take the
      // résumé upload down with it — the single most valuable field on the
      // form, lost to the least important one.
      trace.push({
        label: `${nth} degree`,
        outcome: "failed",
        why: `adding it threw: ${error?.message || error}`,
      });
      break;
    }
  }

  // Work experience, which no board has ever put on the page ready to fill.
  const jobs = profile.experience || [];
  const haveInlineJobs = blocksPresent(window.HIRECRAFT_EXPERIENCE_FIELDS, "job_title") > 0;
  if (!haveInlineJobs) {
    for (const [index, entry] of jobs.entries()) {
      // Bounded at three. A block is a click, a wait and six fields, and an
      // application asking for employment history is asking for the recent
      // part of it — the rest is what the résumé attached above is for.
      if (outOfTime() || index >= 3) break;
      try {
        await addExperience(entry, {
          trace, filled, missing, onProgress, stepDelay, nth: ordinal[index] || `${index + 1}th`,
        });
      } catch (error) {
        trace.push({
          label: `${ordinal[index]} job`,
          outcome: "failed",
          why: `adding it threw: ${error?.message || error}`,
        });
        break;
      }
    }
  }

  // Skills, which are a list rather than an answer.
  if ((profile.skills || []).length) {
    try {
      await fillSkills(profile.skills, { trace, filled, onProgress });
    } catch (error) {
      trace.push({
        label: "Skills",
        outcome: "failed",
        why: `this control threw: ${error?.message || error}`,
      });
    }
  }

  // Résumé upload, handled separately: file inputs are excluded from `controls`
  // because everything above them assumes a text value.
  if (resumeFile) {
    const target = findUploadInput(window.HIRECRAFT_RESUME_FILE, window.HIRECRAFT_NOT_RESUME, {
      soleIsThis: true,
    });
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

  // One last look at everything claimed, after the page has had time to settle.
  //
  // A controlled component can accept a value, re-render from its own state,
  // and put the field back as it was — and a check made immediately after
  // writing reads the gap in between. That is how a Veteran Status question
  // came to be reported as answered on a form where nothing was selected. A
  // report that overstates is worse than one that admits a failure, because
  // only one of the two gets checked by hand before submitting.
  await pause(250);
  const survived = [];
  for (const entry of filled) {
    const held = entry.holds ? safely(entry.holds) : true;
    delete entry.holds;
    if (held) {
      survived.push(entry);
    } else {
      missing.push({ label: entry.label, why: "it was set, then the page put it back" });
      const row = trace.find((e) => e.field && e.got === entry.value);
      if (row) {
        row.outcome = "reverted";
        row.why = "the page put it back after it was set";
      }
    }
  }
  filled.length = 0;
  filled.push(...survived);

  // Checked last, so anything the fill just satisfied no longer counts.
  return { filled, skipped, missing, required: requiredGaps(), trace };
}

/**
 * Has the page shown that a file went in, whatever the input now holds?
 *
 * The filename is what a person reads as "this is attached", and it is what an
 * uploader puts on screen: a row naming the file, a Delete button beside it.
 * Looked for as a filename rather than as any particular markup, since every
 * uploader renders that differently and all of them show the name.
 */
function attachedNearby(el) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    const text = (node.textContent || "").slice(0, 600);
    if (/\.(pdf|docx?|rtf|txt|odt|htm|html)\b/i.test(text)) return true;
  }
  return false;
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
function findUploadInput(want, reject = [], { soleIsThis = false } = {}) {
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

  // One box on the whole page, and nothing saying it is for something else.
  //
  // Everything above exists because a real form has four uploads and putting
  // the résumé in the cover-letter box is worse than filling nothing. With one
  // box that care has nothing to do and starts costing instead: Workday's
  // upload sits behind a "Select Files" button with the input hidden, unnamed
  // and unlabelled, and the words "Resume/CV" live further up the page than the
  // walk reaches. So the single most valuable field on the form was reported as
  // "couldn't tell which upload box" on a page that offers exactly one.
  //
  // Only for the résumé. A lone upload box on an application form is a résumé
  // box; a lone box is not a cover-letter box, and guessing it into one would
  // attach the wrong document under the right name.
  if (soleIsThis && inputs.length === 1) {
    const [only] = inputs;
    // Not over something already attached — including a file the user chose by
    // hand before pressing Fill.
    if (only.files?.length) return null;
    const around = normalise(
      (only.closest?.("form,section,div")?.textContent || "").slice(0, 400)
    );
    if (reject.some((re) => re.test(around))) return null;
    return only;
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

  for (let tries = 0; tries < 12 && !outOfTime(); tries += 1) {
    await pause(110);
    const nodes = optionNodes(namedListbox(el) || listboxFor(el));
    if (!nodes.length) continue;

    // Matched by parts rather than taken from the top of the list. A place
    // autocomplete ranks well but not infallibly, and a wrong city on an
    // application is not a near miss — the same list that offered "Los Angeles,
    // California" also offered "Los Ángeles, Campeche, Mexico".
    const texts = nodes.map(optionText);
    const { index, why } = window.HIRECRAFT_OPTIONS.chooseOption(value, texts, {
      kind: "location",
    });
    if (index < 0) return { ok: false, why, offered: texts.slice(0, 8) };

    nodes[index].scrollIntoView?.({ block: "nearest" });
    clickLike(nodes[index]);
    await pause(140);
    if (displayedValue(el)) return { ok: true, actual: texts[index] };
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
 * Questions asked as a set of choices rather than a dropdown.
 *
 * Excluded from the main scan because everything there assumes a text value,
 * which meant a form built this way had its questions passed over in silence —
 * they were not filled, not reported, and not even listed by Inspect. Ashby
 * asks about sponsorship this way, and about being in the office five days a
 * week, and both are required.
 */
function radioGroups() {
  const byName = new Map();
  for (const el of document.querySelectorAll('input[type="radio"]')) {
    if (isOurs(el) || el.disabled) continue;
    const key = el.getAttribute("name") || "";
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(el);
  }

  const groups = [];
  for (const els of byName.values()) {
    // One radio is not a choice, and a group whose options have no readable
    // text cannot be matched against anything.
    if (els.length < 2) continue;
    const options = els
      .map((el) => ({ el, text: radioOptionText(el) }))
      .filter((option) => option.text);
    if (options.length < 2) continue;
    const question = radioQuestion(els[0], options.map((o) => o.text));
    if (question) groups.push({ question, options });
  }
  return groups;
}

/** The text beside one radio — its own label, not the question's. */
function radioOptionText(el) {
  const wrapping = el.closest?.("label");
  if (wrapping?.innerText?.trim()) return wrapping.innerText.trim();
  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit?.innerText?.trim()) return explicit.innerText.trim();
  }
  return (el.getAttribute("aria-label") || el.value || "").trim();
}

/**
 * The question a group of radios is answering.
 *
 * Found by walking outward and taking the first label-ish text that is not one
 * of the options themselves — without that exclusion the answer "Yes" gets
 * mistaken for the question.
 */
function radioQuestion(el, optionTexts) {
  const taken = new Set(optionTexts.map((text) => normalise(text)));
  let node = el.parentElement;
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    const legend = node.querySelector?.("legend");
    const legendText = legend?.innerText?.trim();
    if (legendText) return legendText;

    const aria = node.getAttribute?.("aria-label");
    if (aria?.trim() && !taken.has(normalise(aria))) return aria.trim();

    for (const candidate of node.querySelectorAll?.(
      "label,[class*='label'],[class*='Label'],[class*='question'],[class*='Question'],h2,h3,h4,h5"
    ) || []) {
      const text = candidate.innerText?.trim();
      if (text && text.length > 3 && text.length < 300 && !taken.has(normalise(text))) {
        return text;
      }
    }
  }
  return "";
}

/**
 * Choose one radio in a group, the way a person would.
 *
 * Two hard parts, both learned the wrong way round.
 *
 * React keeps a cache of each input's last value and swallows a change event
 * that matches it, so setting `checked` and dispatching produces nothing: the
 * component's own state never moves and the next render puts the radio back.
 * The cache has to be told the value differed, which is the checkbox
 * equivalent of the native-setter trick used for text.
 *
 * And verifying `el.checked` is not verifying anything. It is true for the
 * moment between the write and the re-render that undoes it — which is exactly
 * long enough to be read, reported as success, and be wrong. Ashby writes the
 * selected flag into the option row's class, so the rendered row is checked
 * instead: that is the state that gets submitted.
 */
async function pickRadio(option) {
  const fresh = () =>
    (option.el.id ? document.getElementById(option.el.id) : null) || option.el;

  const took = () => {
    const node = fresh();
    if (!node) return false;
    if (node.getAttribute?.("aria-checked") === "true") return true;
    if (!node.checked) return false;
    // A row still marked unselected means the component rejected the write,
    // whatever the DOM property currently says.
    const row = node.closest?.("[class*='option'],[class*='Option'],[class*='choice']");
    if (row && /(^|\s)false(\s|$)/.test(String(row.className || ""))) return false;
    return true;
  };

  const settle = async (ms) => {
    await pause(ms);
    return took();
  };

  if (took()) return "already";

  const el = fresh();
  const targets = [
    ["label", el.closest?.("label")],
    ["option row", el.closest?.("[class*='option'],[class*='Option'],[class*='choice']")],
    ["input", el],
  ];
  for (const [how, target] of targets) {
    if (!target) continue;
    clickLike(target);
    // Long enough for a re-render to undo it if it is going to.
    if (await settle(180)) return how;
  }

  const node = fresh();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  if (setter) setter.call(node, true);
  else node.checked = true;
  // Tell React the value moved, or it discards the event as a no-op.
  try {
    node._valueTracker?.setValue?.("false");
  } catch {
    /* not a React-managed input */
  }
  node.dispatchEvent(new Event("click", { bubbles: true }));
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
  return (await settle(200)) ? "setter" : "";
}

/**
 * Single yes/no boxes, which are a question rather than one option among many.
 *
 * "Still Student?" sits beside an end date and is answered by the dates
 * themselves — a December 2027 course has not finished. Checkboxes are excluded
 * from the main scan because everything there assumes a text value.
 */
function checkboxQuestions() {
  const out = [];
  for (const el of document.querySelectorAll('input[type="checkbox"]') || []) {
    // Checked rather than assumed from the selector: this function only knows
    // how to drive a checkbox, and being handed anything else would have it
    // setting `checked` on a control that has no such thing.
    if ((el.getAttribute?.("type") || "").toLowerCase() !== "checkbox") continue;
    if (isOurs(el) || el.disabled) continue;
    const question = radioOptionText(el) || labelFor(el);
    if (question) out.push({ el, question });
  }
  return out;
}

/** Set a checkbox, past React's cache, and confirm it stayed. */
async function setCheckbox(el, wanted) {
  if (Boolean(el.checked) === wanted) return "already";
  clickLike(el.closest?.("label") || el);
  await pause(160);
  if (Boolean(el.checked) === wanted) return "click";

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  if (setter) setter.call(el, wanted);
  else el.checked = wanted;
  try {
    el._valueTracker?.setValue?.(wanted ? "false" : "true");
  } catch {
    /* not a React-managed input */
  }
  el.dispatchEvent(new Event("click", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await pause(180);
  return Boolean(el.checked) === wanted ? "setter" : "";
}

/**
 * Questions answered by clicking one of a row of buttons.
 *
 * Ashby asks about sponsorship, being in the office, and immigration status
 * this way: two boxes reading Yes and No, which are neither inputs nor radios
 * and so appeared nowhere at all — not filled, not reported, not even in the
 * form scan.
 *
 * The detection is deliberately loose, because a false positive costs nothing:
 * a group is only ever acted on when its question matches a field we hold an
 * answer for, so a tab bar or a pagination row is found, ignored, and forgotten.
 */

function buttonGroups() {
  const groups = [];
  const seen = new Set();

  for (const node of document.querySelectorAll(CLICKABLE) || []) {
    if (isOurs(node)) continue;
    // A site's own navigation is a row of clickable siblings too. Ashby's
    // Overview/Application tabs were found and reported as a question called
    // "Autofill from resume", which is a button somewhere else on the page.
    if (node.closest?.("nav,[role='tablist'],header,footer")) continue;
    const parent = node.parentElement;
    if (!parent || seen.has(parent)) continue;
    seen.add(parent);

    const siblings = Array.from(parent.children || []).filter((child) =>
      child.matches?.(CLICKABLE)
    );
    if (siblings.length < 2 || siblings.length > 10) continue;

    const options = siblings
      .map((el) => ({ el, text: (el.innerText || "").replace(/\s+/g, " ").trim() }))
      .filter((option) => option.text && option.text.length <= 80);
    if (options.length < 2) continue;

    const question = radioQuestion(siblings[0], options.map((o) => o.text));
    if (question) groups.push({ question, options, buttons: true });
  }
  return groups;
}

/** Has this button ended up in the chosen state? */
function buttonChosen(el) {
  if (el.getAttribute?.("aria-pressed") === "true") return true;
  if (el.getAttribute?.("aria-checked") === "true") return true;
  if (el.getAttribute?.("aria-selected") === "true") return true;
  const cls = String(el.className || "");
  if (/(^|\s)(selected|active|checked|true)(\s|$)/i.test(cls)) return true;
  return /_selected_|_active_|_checked_/.test(cls);
}

/** Click one button in a group and confirm it took. */
async function pickButton(option) {
  if (buttonChosen(option.el)) return "already";
  clickLike(option.el);
  await pause(180);
  if (buttonChosen(option.el)) return "click";
  // Some render the state on the wrapper rather than the button itself.
  const wrapper = option.el.parentElement;
  if (wrapper && buttonChosen(wrapper)) return "wrapper";
  return "";
}

/**
 * Choice-shaped questions we can see but cannot yet drive.
 *
 * Reported by Inspect rather than acted on. Ashby renders its yes/no questions
 * as something other than radios, and rather than guess at markup I have not
 * seen — which has produced a wrong answer every time this session — this puts
 * the real structure in the diagnostics so the next dump settles it.
 */
function choiceCandidates() {
  const out = [];
  const seen = new Set();

  // Button-style groups, which carry no role and no fieldset.
  for (const group of buttonGroups()) {
    out.push({
      at: pathTo(group.options[0].el),
      role: "buttons",
      text: group.question.replace(/\s+/g, " ").trim().slice(0, 140),
      options: group.options.map((o) => o.text),
    });
  }

  for (const group of document.querySelectorAll('[role="radiogroup"],[role="group"],fieldset')) {
    if (isOurs(group) || seen.has(group)) continue;
    seen.add(group);
    const options = Array.from(
      group.querySelectorAll('[role="radio"],[role="option"],button,input[type="radio"]')
    )
      .map((node) =>
        (node.getAttribute?.("type") === "radio" ? radioOptionText(node) : node.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
      )
      .filter(Boolean)
      .slice(0, 10);
    if (options.length < 2) continue;
    out.push({
      at: pathTo(group),
      role: group.getAttribute("role") || group.tagName.toLowerCase(),
      text: (group.innerText || "").replace(/\s+/g, " ").trim().slice(0, 140),
      options,
    });
  }
  return out;
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
  // De-duplicated by label, since one question can reach here as several
  // controls — a radio group is a box per option.
  return [...new Set(gapDetails().map((gap) => gap.label))];
}

/**
 * The same gaps, each with the control it belongs to.
 *
 * Kept apart from `requiredGaps` so the report's shape does not change: it
 * carries labels, everything downstream reads labels, and a list of objects
 * where a list of strings used to be would break the dump and the panel at
 * once. This is for the one thing a label cannot do — take you to the question.
 */
function gapDetails() {
  const gaps = [];
  const groupChecked = new Map();

  for (const el of document.querySelectorAll("input, select, textarea")) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
    if (el.disabled || isOurs(el)) continue;

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
      // Not `el.files` alone. An uploader that sends the file straight away
      // clears the input afterwards so you can pick another — Workday does,
      // and answered "MHR_AIML.pdf successfully uploaded" while the input went
      // back to holding nothing. The résumé was attached, accepted, and still
      // reported as a required box left empty.
      empty = !(el.files && el.files.length) && !attachedNearby(el);
    } else if (type === "radio" || type === "checkbox") {
      // One answer satisfies the whole group, so judge the group, not the box.
      const name = el.getAttribute("name") || raw;
      if (!groupChecked.has(name)) {
        const peers = name
          ? Array.from(document.querySelectorAll(`[name="${CSS.escape(name)}"]`))
          : [el];
        groupChecked.set(name, peers.some((p) => p.checked));
      }
      // A styled radio is often invisible with its label doing the work, so the
      // visibility test above would drop the whole group; radios reach here
      // regardless and are judged on whether the group has an answer.
      empty = !groupChecked.get(name);
    } else {
      empty = !displayedValue(el);
    }
    if (empty) gaps.push({ label: raw.replace(/[*✱]/g, "").trim().slice(0, 70), el });
  }

  // Questions asked as a row of choices, which the loop above cannot see. The
  // asterisk sits on the group's heading and the boxes themselves carry no
  // label of their own, so "Have you ever worked at Applied Materials as a
  // regular employee…" — required, unanswered, and the thing that would have
  // bounced the form on submit — appeared in no list anywhere: not filled, not
  // missing, not skipped, not even in the gaps this function exists to find.
  for (const group of [...radioGroups(), ...buttonGroups()]) {
    const question = (group.question || "").replace(/\s+/g, " ").trim();
    if (!question || !/[*✱]|\brequired\b/i.test(question)) continue;
    const answered = group.buttons
      ? group.options.some((option) => buttonChosen(option.el))
      : group.options.some((option) => option.el.checked);
    if (!answered) {
      gaps.push({
        label: question.replace(/[*✱]/g, "").replace(/\s+/g, " ").trim().slice(0, 70),
        el: group.options[0]?.el,
      });
    }
  }
  return gaps;
}

/**
 * Does this control still hold the value we put in it?
 *
 * Checking only that it holds *something* is not a check: a month box left
 * reading August was reported as filled with July, because August is something.
 * A reformatted value still passes — a phone mask is the field agreeing, not
 * refusing — since the comparison is against what was displayed after writing.
 */
function stillHolds(el, expected) {
  const { normText } = window.HIRECRAFT_OPTIONS;
  const want = normText(expected);
  const now = normText(
    isTag(el, "SELECT")
      ? el.options?.[el.selectedIndex]?.text ?? ""
      : displayedValue(el)
  );
  if (!now) return false;
  if (!want) return true;
  return now === want || now.includes(want) || want.includes(now);
}

/**
 * Put a value into whatever kind of control this is.
 *
 * Shared, because it was not: the second-education pass had its own two-way
 * branch and no case for a <select>, so it called setValue with "July" on a
 * control whose option value is "7". The month was discarded and reported as
 * discarded, while the year beside it — where the option value happens to equal
 * its text — worked, which made the failure look like a mystery rather than a
 * missing branch.
 */
async function applyTo(el, field, value, profile, widget) {
  if (isTag(el, "SELECT")) {
    const texts = Array.from(el.options || []).map((o) => o.text);
    const choice = window.HIRECRAFT_OPTIONS.chooseOption(value, texts, {
      kind: field.kind,
      unit: field.unit,
      context: field.context?.(profile),
    });
    if (choice.index < 0) {
      return { ok: false, why: choice.why, offered: texts.slice(0, 12) };
    }
    setValue(el, el.options[choice.index].value);
    return { ok: true, actual: texts[choice.index] };
  }
  if (widget || isCombobox(el)) {
    // A wrapper around a plain box is a plain box, whatever ARIA it carries.
    // Workday's date fields are a div per segment with the real input inside;
    // driven as dropdowns they looked for an option list that does not exist
    // and reported all four as unfillable.
    const inner = isTag(el, "SELECT") ? null : typeableIn(el, el);
    if (inner?.length === 1 && !optionNodes(namedListbox(el)).length) {
      return setAndVerify(inner[0], forBox(inner[0], field, value));
    }
    const result = await chooseFromCombobox(
      el, value, field.kind, field.unit, field.context?.(profile)
    );
    if (result.ok) result.actual = result.chosen;
    return result;
  }
  return setAndVerify(el, forBox(el, field, value));
}

/** The value in the form this particular box will accept. */
function forBox(el, field, value) {
  const isMonth = field.key === "start_month" || field.key === "end_month";
  return isMonth && wantsDigits(el) ? asDigits(value) : value;
}

/** The button that adds another education block, if the form offers one. */
function addEducationButton() {
  for (const el of document.querySelectorAll("button,[role='button'],a") || []) {
    if (isOurs(el)) continue;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (/^\+?\s*add\s+(another\s+)?(education|school|degree)\b/i.test(text)) return el;
  }
  return sectionAddButton(/\b(education|school|degree|university)\b/);
}

/**
 * The "Add" button belonging to a named section.
 *
 * Workday's My Experience step has three and they all say "Add" — same
 * automation id, same class, no distinguishing mark on any of them. The only
 * thing that says which is which is the heading above it, which is exactly what
 * a person reads: Work Experience / Add / Education / Add / Skills.
 *
 * So a button belongs to the last heading before it, taken in document order
 * rather than by nesting. Document order is what the eye follows and it holds
 * however deeply either one happens to be wrapped, which is not something the
 * markup here would let us rely on: the button sits four divs down from
 * anything named.
 */
function sectionAddButton(wanted) {
  let section = "";
  for (const node of document.querySelectorAll(
    "h1,h2,h3,h4,h5,h6,legend,[role='heading'],button,[role='button']"
  ) || []) {
    if (isOurs(node)) continue;
    const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    const isButton = isTag(node, "BUTTON") || node.getAttribute?.("role") === "button";
    if (!isButton) {
      // A heading, if it is short enough to be one rather than a paragraph that
      // happens to carry a heading role.
      if (text.length <= 60) section = text;
      continue;
    }
    if (text.length > 30 || !/^\+?\s*add\b/i.test(text)) continue;
    // The heading and the button's own words together, so both "Education" over
    // "Add" and a bare "+ Add Another Education" are answered by one rule.
    if (wanted.test(normalise(`${section} ${text}`))) return node;
  }
  return null;
}

/** How many blocks of this kind the form already holds. */
function blocksPresent(fields, key) {
  return controls().filter(
    ({ label }) => fields.find((f) => f.match.some((re) => re.test(label)))?.key === key
  ).length;
}

/**
 * Fill a second education block from the next entry on the résumé.
 *
 * A form that offers to add one is asking for the rest of them, and the résumé
 * has them — a master's above a bachelor's. Which controls are new is worked
 * out by comparing the form before and after the click rather than by guessing
 * at how the block is numbered, which is the same approach that finally sorted
 * out which dropdown belonged to which field.
 */
async function addEducation(entry, { trace, filled, missing, onProgress, stepDelay, nth = "2nd" }) {
  const button = addEducationButton();
  if (!button) return false;

  // Belt as well as braces: even with the click fixed, adding a block the form
  // already has would duplicate a degree, and a duplicated degree on an
  // application is the user's problem to clean up.
  if (blocksPresent(window.HIRECRAFT_FIELDS, "school") > 1) {
    trace.push({ label: "Add education", outcome: "left alone", why: "the form already has a second block" });
    return false;
  }

  return addBlock({
    button,
    what: `${nth} education`,
    nth,
    stand_in: { education: entry },
    fields: window.HIRECRAFT_FIELDS,
    // Only the education questions, answered from this entry rather than from
    // the profile's most recent degree.
    keys: new Set([
      "school", "degree", "field_of_study", "start_month", "start_year",
      "end_month", "end_year", "gpa", "still_student",
    ]),
    trace,
    filled,
    missing,
    onProgress,
    stepDelay,
  });
}

/**
 * Add one job, from the résumé.
 *
 * Workday's Work Experience section starts empty: there is no block to fill
 * until an Add button makes one, and the button says nothing but "Add".
 *
 * The questions inside are matched against their own small catalogue rather
 * than the main one. "Company", "Title" and "Location" are ordinary enough
 * words to appear on any form for other reasons, and a pattern loose enough to
 * catch them inside an experience block would be loose enough to answer the
 * wrong question outside one. Keeping the list separate means it can only ever
 * be consulted for a block this function just created.
 */
async function addExperience(entry, { trace, filled, missing, onProgress, stepDelay, nth }) {
  const button = sectionAddButton(/\b(work\s*experience|employment|job\s*history)\b/);
  if (!button) return false;

  return addBlock({
    button,
    what: `${nth} job`,
    nth,
    stand_in: entry,
    fields: window.HIRECRAFT_EXPERIENCE_FIELDS,
    keys: null, // the whole list is about experience already
    trace,
    filled,
    missing,
    onProgress,
    stepDelay,
  });
}

/**
 * One control per question, and the last one on the page.
 *
 * Identity alone cannot tell a new block from an old one. Adding the second
 * degree made Workday re-render the first, so its School box came back as a
 * different node, matched nothing in the before-set, counted as new, and was
 * written over — the finished form said RV College where it should have said
 * USC. Both blocks then named the same school, which is not an empty field
 * anyone would notice; it is a wrong answer that reads as a filled one.
 *
 * A form appends the block it has just added, so the last School box on the
 * page is the one that block owns. Taking only that leaves every earlier block
 * holding what it was given.
 */
function oneEach(controls, fields) {
  const own = new Map();
  for (const control of controls) {
    const field = fields.find((f) => f.match.some((re) => re.test(control.label)));
    if (field) own.set(field.key, control);
  }
  return own;
}

/**
 * Press an Add button and fill whatever block appears.
 *
 * Which controls are new is worked out by comparing the form before and after
 * the click rather than by guessing at how the block is numbered — the same
 * approach that sorted out which dropdown belonged to which field.
 */
async function addBlock({
  button, what, nth, stand_in, fields, keys, trace, filled, missing, onProgress, stepDelay,
}) {
  const before = new Set(controls().map((c) => c.el));
  const beforeBoxes = new Set(checkboxQuestions().map((c) => c.el));
  clickLike(button);

  let fresh = [];
  for (let tries = 0; tries < 12 && !outOfTime(); tries += 1) {
    await pause(120);
    fresh = controls().filter((c) => !before.has(c.el));
    if (fresh.length >= 2) break;
  }
  if (!fresh.length) {
    trace.push({ label: `Add ${what}`, outcome: "failed", why: "no new fields appeared" });
    return false;
  }

  // One box per question, and the last one on the page.
  //
  // Identity is not enough to tell a new block from an old one. Adding the
  // second degree made Workday re-render the first, so its School box came back
  // as a different node, matched nothing in `before`, counted as new, and was
  // written over — the finished form said RV College where it should have said
  // USC. Both blocks then named the same school, which is not an empty field
  // anyone would notice; it is a wrong answer that reads as a filled one.
  //
  // A form appends the block it has just added, so the last School box on the
  // page is the one that block owns. Taking only that leaves every earlier
  // block holding what it was given.
  for (const { el, raw, label, widget } of oneEach(fresh, fields).values()) {
    if (outOfTime()) break;
    const field = fields.find((f) => f.match.some((re) => re.test(label)));
    if (!field || (keys && !keys.has(field.key))) continue;
    // No "leave it alone if it already holds something" here. This block did
    // not exist a moment ago — the filler created it — so nothing in it is the
    // user's answer, and everything in it is a default the form chose. Ashby
    // pre-sets both year boxes to the current year, and honouring that skipped
    // 2018 and 2022 and left a bachelor's dated 2026.

    const value = String(field.from(stand_in) ?? "").trim();
    if (!value) continue;

    let result;
    try {
      result = await applyTo(el, field, value, stand_in, widget);
    } catch (error) {
      result = { ok: false, why: `this control threw: ${error?.message || error}` };
    }

    trace.push({
      label: `${raw.trim().slice(0, 50)} (${what})`,
      at: pathTo(el),
      field: field.key,
      control: isTag(el, "SELECT") ? "select" : widget || isCombobox(el) ? "combobox" : "text",
      wanted: value,
      outcome: result.ok ? "filled" : "failed",
      got: result.actual ?? result.chosen ?? null,
      why: result.why ?? null,
    });

    if (result.ok) {
      filled.push({
        label: `${field.label} (${nth})`,
        value: result.actual ?? result.chosen ?? value,
        holds: () => stillHolds(el, result.actual ?? result.chosen ?? value),
      });
      if (onProgress) {
        onProgress({ el, label: `${field.label} (${nth})`, value: result.actual ?? value });
        if (stepDelay) await pause(stepDelay);
      }
    } else {
      // Reported rather than dropped. A block the filler opened and could not
      // finish is worse than one it never opened, so what is left inside it has
      // to be visible without anyone reading the trace to find it.
      missing.push({
        label: `${field.label} (${nth})`,
        why: result.why || "this one is still empty",
        offered: result.offered,
      });
    }
  }

  // "I currently work here" and "I am still studying here" are checkboxes,
  // which the scan above excludes because everything there assumes a text
  // value. They decide whether the end date is a question at all.
  for (const { el, question } of checkboxQuestions()) {
    if (beforeBoxes.has(el) || outOfTime()) continue;
    const label = normalise(question);
    const field = fields.find((f) => f.match.some((re) => re.test(label)));
    if (!field || (keys && !keys.has(field.key))) continue;
    const value = String(field.from(stand_in) ?? "").trim().toLowerCase();
    if (value !== "yes" && value !== "no") continue;
    const how = await setCheckbox(el, value === "yes");
    trace.push({
      label: `${question.replace(/\s+/g, " ").trim().slice(0, 50)} (${what})`,
      at: pathTo(el),
      field: field.key,
      control: "checkbox",
      wanted: value,
      outcome: how ? "filled" : "failed",
      why: how ? `set by ${how}` : "the box would not change",
    });
    if (how) {
      filled.push({
        label: `${field.label} (${nth})`,
        value: value === "yes" ? "Yes" : "No",
        holds: () => Boolean(el.checked) === (value === "yes"),
      });
    }
  }
  return true;
}


/**
 * The box a form offers for skills, if it has one.
 *
 * Every other control this engine drives holds one answer. This one holds a
 * list, which is a different job: pick, wait for the pill, pick again — and
 * knowing when to stop, because the résumé has forty and a form does not want
 * forty.
 */
function skillsBox() {
  for (const { el, label } of controls()) {
    if (/\bskills?\b/.test(label) && !/\bsoft\s*skills?\b/.test(label)) return el;
  }
  return null;
}

/**
 * Add skills, one at a time, from the résumé.
 *
 * Workday's list is a controlled vocabulary: you type, it offers what it knows,
 * and anything it does not know cannot be added at all. So a skill that finds
 * no match is not a failure to report loudly — it is a word this employer's
 * taxonomy does not carry, and there will be several. What matters is how many
 * went in.
 *
 * Bounded twice over: by `wanted`, since a form asking for skills wants the
 * ones that matter rather than the whole résumé, and by the fill's own
 * deadline, because each one costs a type, a wait and a click.
 */
async function fillSkills(skills, { trace, filled, onProgress }) {
  const el = skillsBox();
  if (!el || !skills.length) return false;

  const added = [];
  const refused = [];
  let ranOut = false;
  for (const skill of skills) {
    if (added.length >= 12) break;
    if (outOfTime()) {
      ranOut = true;
      break;
    }
    const already = normalise(nearbyPills(el).join(" "));
    if (already.includes(normalise(skill))) continue;

    let result;
    try {
      result = await chooseFromCombobox(el, skill, "skill", null, null);
    } catch (error) {
      result = { ok: false, why: `this control threw: ${error?.message || error}` };
    }
    if (result.ok) added.push(result.chosen ?? skill);
    // Each refusal keeps its own reason. Counting them and reporting one
    // sentence for the lot said "none of them were on this employer's list" for
    // a run that had simply run out of time before trying any — a guess dressed
    // as a finding, and the sort that sends the next round to the wrong place.
    else refused.push({ skill, why: result.why, listbox: result.listbox ?? null });
  }

  trace.push({
    label: "Skills",
    at: pathTo(el),
    field: "skills",
    control: "multi-select",
    wanted: skills.slice(0, 12).join(", "),
    outcome: added.length ? "filled" : "failed",
    got: added.join(", ") || null,
    why: [
      added.length ? `${added.length} added` : "none added",
      refused.length ? `${refused.length} refused` : "",
      ranOut ? "then the fill ran out of time" : "",
    ]
      .filter(Boolean)
      .join(", "),
    refused: refused.slice(0, 4),
  });

  if (!added.length) return false;
  filled.push({
    label: "Skills",
    value: added.join(", "),
    // Counted against the pills on screen, not against what we think we did:
    // a multi-select that quietly drops one is exactly the failure the single
    // -value path had to learn to catch.
    holds: () => nearbyPills(el).length >= added.length,
  });
  if (onProgress) onProgress({ el, label: "Skills", value: `${added.length} added` });
  return true;
}

/** The chips a multi-select is currently showing. */
function nearbyPills(el) {
  let node = el.parentElement;
  for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
    const pills = Array.from(
      node.querySelectorAll?.("[id^='pill-'],[data-automation-id='selectedItem'],[class*='multi-value']") || []
    );
    if (pills.length) {
      return pills.map((p) =>
        String(p.textContent ?? "").replace(/,\s*press delete.*$/i, "").replace(/\s+/g, " ").trim()
      );
    }
  }
  return [];
}

/**
 * Interactive things the scan could not classify.
 *
 * Purely diagnostic. Three runs went by with Ashby's month and year pickers
 * absent from every list — inspect, choices, trace — and absent is the one
 * state that gives nothing to work from.
 */
function unclassified() {
  const known = new Set(controls().map((c) => c.el));
  const out = [];

  // Form controls the scan dropped, which is where the month and year pickers
  // have been hiding: a control with no resolvable label is skipped by the
  // scan, and was skipped here too for being a form control. Between the two it
  // appeared in nothing at all, three runs running.
  for (const el of document.querySelectorAll("input,select,textarea") || []) {
    if (known.has(el) || isOurs(el)) continue;
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      cls: String(el.className || "").slice(0, 70),
      placeholder: el.getAttribute("placeholder") || "",
      why: "skipped by the scan",
      at: pathTo(el),
    });
  }

  for (const el of document.querySelectorAll("button,[role],[tabindex],[class*='select'],[class*='picker']") || []) {
    if (known.has(el) || isOurs(el)) continue;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) continue;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 40) continue;
    if (el.querySelector?.("input,select,textarea,button")) continue;  // a container, not a control
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      cls: String(el.className || "").slice(0, 70),
      text: text.slice(0, 40),
      label: (labelFor(el) || "").replace(/\s+/g, " ").trim().slice(0, 60),
      at: pathTo(el),
    });
    if (out.length >= 25) break;
  }
  return out;
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
  BUILD,
  fillForm,
  inspectForm,
  fileFromDataUrl,
  normalise,
  labelFor,
  isCombobox,
  setAndVerify,
  requiredGaps,
  gapDetails,
  // Exported to be tested directly. Both were caused by the same assumption —
  // that a dropdown is a text input — which Workday does not share.
  setValue,
  displayedValue,
  searchBoxFor,
  findUploadInput,
  attachFile,
  needsPlacePick,
  // Exported to be tested directly: choosing which list belongs to which
  // control has now been the cause of three separate wrong answers.
  listboxFor,
  optionNodes,
  radioGroups,
  buttonGroups,
  checkboxQuestions,
  unclassified,
  addEducationButton,
  clickLike,
  choiceCandidates,
  // Workday's My Experience step: three identical Add buttons, an uploader that
  // clears its own input, and a box that holds a list rather than an answer.
  sectionAddButton,
  blocksPresent,
  attachedNearby,
  skillsBox,
  fillSkills,
  // A date field that is a wrapper round a two-character box, and a dropdown
  // whose accessible name carries its own prompt.
  wantsDigits,
  asDigits,
  withoutPrompt,
  oneEach,
};
