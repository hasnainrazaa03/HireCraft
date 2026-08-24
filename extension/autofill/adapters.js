/**
 * Per-ATS corrections to the generic label matcher.
 *
 * Intentionally thin, and it should stay that way. Every entry here is a place
 * the label-driven matcher was proven wrong on a real page — not a guess made in
 * advance. Adding speculative selectors is how this file becomes the brittle
 * per-ATS map the design set out to avoid.
 *
 * An override maps a *normalised* label (see fill.js `normalise`) to a field
 * definition, so it wins over the generic patterns for that exact label.
 */

const BY_HOST = [
  {
    host: /greenhouse\.io/,
    name: "Greenhouse",
    overrides: {},
  },
  {
    host: /ashbyhq\.com/,
    name: "Ashby",
    overrides: {},
  },
  {
    host: /lever\.co/,
    name: "Lever",
    overrides: {
      // Lever labels the employer box "Current company", which reads as a
      // company-name question the generic matcher rightly refuses to answer with
      // the candidate's own name. There is nothing to fill it from, so it is
      // named here only to be reported as an unfilled field rather than passed
      // over in silence.
      "current company": {
        key: "current_company",
        label: "Current company",
        from: () => "",
        match: [],
      },
    },
  },
];

function adapterFor(host) {
  return BY_HOST.find((a) => a.host.test(host)) || { name: "", overrides: {} };
}

window.HIRECRAFT_ADAPTER = adapterFor(location.host);
