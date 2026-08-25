/**
 * Recognising that an application was actually submitted.
 *
 * Worth detecting because the alternative is remembering. The moment you submit
 * is the moment you stop thinking about a job and start thinking about the next
 * one, and a tracker filled in from memory a week later is a tracker with holes.
 *
 * The patterns are the whole feature, and both ways of getting them wrong are
 * silent. Too loose and a careers-page footer marks a job as applied, putting a
 * false record into something the user relies on. Too tight and the moment
 * passes unrecorded, which is the problem this exists to solve.
 *
 * Kept apart from the content script so it can be exercised without a DOM.
 */

/** Paths an ATS lands on after a successful submission. */
const CONFIRMATION_URL =
  /\/(?:thank[-_]?you|confirmation|confirmed|submitted|success)(?:\b|\/|$)|\/apply\/complete\b/i;

/**
 * Wording that means the application went through.
 *
 * Anchored on the completed act — "has been submitted", "we received" — rather
 * than on the words "application" or "submit", which appear all over a form
 * that has not been sent yet ("Submit your application when ready").
 */
const CONFIRMATION_TEXT =
  /\b(?:application\s+(?:was\s+|has\s+been\s+)?(?:successfully\s+)?(?:submitted|received)|thank(?:s|\s+you)\s+for\s+applying|thank(?:s|\s+you)\s+for\s+your\s+application|we(?:'ve|\s+have)\s+received\s+your\s+application|your\s+application\s+is\s+complete)\b/i;

/** Does this path look like a post-submission confirmation? */
function isConfirmationUrl(pathname) {
  return CONFIRMATION_URL.test(pathname || "");
}

/**
 * Does this page text say the application went through?
 *
 * Only the first stretch of the page is read: a confirmation is announced at
 * the top, while the same words can appear far below in a privacy notice or an
 * FAQ about how applications are handled.
 */
function isConfirmationText(text) {
  return CONFIRMATION_TEXT.test((text || "").slice(0, 8000));
}

window.HIRECRAFT_SUBMISSION = {
  CONFIRMATION_URL,
  CONFIRMATION_TEXT,
  isConfirmationUrl,
  isConfirmationText,
};
