import type { BulletConfidence, DiffEntry } from "../lib/api";

/**
 * Shared review panels for any before/after résumé change — used by both the
 * tailoring result view (against a job) and the standalone AI rewrite flow.
 * Keeping one implementation means the diff and the truthfulness confidence
 * always look and behave identically wherever a résumé is transformed.
 */

export const CONFIDENCE_META: Record<
  BulletConfidence["confidence"],
  { label: string; badge: string; dot: string }
> = {
  verified: { label: "Verified", badge: "badge-emerald", dot: "bg-emerald" },
  likely: { label: "Likely", badge: "badge-blue", dot: "bg-electric" },
  needs_review: { label: "Review", badge: "badge-coral", dot: "bg-coral" },
  blocked: { label: "Blocked", badge: "badge-danger", dot: "bg-danger" },
};

// How each verdict is determined — surfaced as badge tooltips and an inline legend.
const CONFIDENCE_HELP: Record<BulletConfidence["confidence"], string> = {
  verified: "Every number, tool, and claim in this line is present in your master résumé.",
  likely: "Closely supported by your résumé — the phrasing generalizes slightly but invents nothing.",
  needs_review: "Worth a quick check — the wording drifts a little from your source material.",
  blocked: "Made a claim your résumé doesn't support, so it was removed automatically — never shown.",
};

const CONFIDENCE_TONE: Record<BulletConfidence["confidence"], string> = {
  verified: "text-emerald",
  likely: "text-electric",
  needs_review: "text-coral",
  blocked: "text-danger",
};

type Tok = { text: string; type: "eq" | "add" | "del" };

/** Word-level LCS diff so inserted/removed words are highlighted, not just the
 * whole bullet. Whitespace is kept as its own tokens (rendered un-highlighted)
 * so spacing survives and highlight blocks don't bleed across gaps. */
function wordDiff(before: string, after: string): { before: Tok[]; after: Tok[] } {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const bt: Tok[] = [];
  const at: Tok[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      bt.push({ text: a[i], type: "eq" });
      at.push({ text: b[j], type: "eq" });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      bt.push({ text: a[i], type: "del" });
      i++;
    } else {
      at.push({ text: b[j], type: "add" });
      j++;
    }
  }
  while (i < m) bt.push({ text: a[i++], type: "del" });
  while (j < n) at.push({ text: b[j++], type: "add" });
  return { before: bt, after: at };
}

function toItems(value: string | string[] | null): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function TokenSpan({ t }: { t: Tok }) {
  if (t.type === "eq" || /^\s+$/.test(t.text)) return <span>{t.text}</span>;
  if (t.type === "del")
    return <span className="rounded bg-danger/10 text-danger/80 line-through decoration-danger/50">{t.text}</span>;
  return <span className="rounded bg-emerald/20 text-emerald">{t.text}</span>;
}

export function DiffView({
  diff,
  afterLabel = "Tailored",
  emptyMessage = "No changes were made.",
}: {
  diff: DiffEntry[];
  afterLabel?: string;
  emptyMessage?: string;
}) {
  if (diff.length === 0) {
    return <p className="text-sm text-muted">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-4">
      {diff.map((entry, index) => {
        const before = toItems(entry.before);
        const after = toItems(entry.after);
        const rows = Math.max(before.length, after.length);
        const pairs = Array.from({ length: rows }, (_, r) =>
          wordDiff(before[r] ?? "", after[r] ?? ""),
        );
        return (
          <div key={index} className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/[0.08] bg-surface-2 px-4 py-2">
              <span className="text-sm font-medium">{entry.label}</span>
              <span className="text-xs uppercase tracking-wide text-subtle">
                {entry.section} · {entry.change}
              </span>
            </div>
            <div className="grid gap-px bg-white/[0.06] md:grid-cols-2">
              <DiffSide title="Original" tone="before" empty={before.length === 0} rows={pairs.map((p) => p.before)} />
              <DiffSide title={afterLabel} tone="after" empty={after.length === 0} rows={pairs.map((p) => p.after)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DiffSide({
  title,
  tone,
  empty,
  rows,
}: {
  title: string;
  tone: "before" | "after";
  empty: boolean;
  rows: Tok[][];
}) {
  return (
    <div className={`p-4 ${tone === "after" ? "bg-emerald/[0.05]" : "bg-surface"}`}>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
        {title}
      </div>
      {empty ? (
        <p className="text-sm italic text-subtle">{tone === "after" ? "— removed —" : "— new —"}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((toks, index) => (
            <li key={index} className="text-sm leading-relaxed text-content">
              {toks.length === 0
                ? <span className="italic text-subtle">—</span>
                : toks.map((t, k) => <TokenSpan key={k} t={t} />)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Per-bullet truthfulness verdicts (Guardrails v2). Blocked bullets never made
 * it into the résumé, so they're summarised in the counts but not listed as if
 * they survived.
 */
export function ConfidencePanel({
  confidence,
  intro = "Every line, verified against your master résumé.",
}: {
  confidence: BulletConfidence[];
  intro?: string;
}) {
  if (confidence.length === 0) return null;
  const counts = confidence.reduce<Record<string, number>>((acc, c) => {
    acc[c.confidence] = (acc[c.confidence] ?? 0) + 1;
    return acc;
  }, {});
  const survived = confidence.filter((c) => c.confidence !== "blocked");

  return (
    <div>
      <h3 className="text-sm font-medium">Bullet-by-bullet confidence</h3>
      <p className="mt-1 text-xs text-subtle">{intro}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {(["verified", "likely", "needs_review", "blocked"] as const).map((k) =>
          counts[k] ? (
            <span key={k} className={CONFIDENCE_META[k].badge} title={CONFIDENCE_HELP[k]}>
              {counts[k]} {CONFIDENCE_META[k].label}
            </span>
          ) : null,
        )}
      </div>
      <details className="group mt-2">
        <summary className="inline-flex cursor-pointer list-none select-none items-center gap-1 text-xs text-brand-300/80 transition hover:text-brand-300">
          <span className="transition group-open:rotate-90">›</span>
          What do these mean?
        </summary>
        <dl className="mt-1.5 space-y-1 pl-3.5 text-xs leading-relaxed text-muted">
          {(["verified", "likely", "needs_review", "blocked"] as const).map((k) => (
            <div key={k} className="flex gap-2">
              <dt className={`shrink-0 font-medium ${CONFIDENCE_TONE[k]}`}>{CONFIDENCE_META[k].label}</dt>
              <dd>{CONFIDENCE_HELP[k]}</dd>
            </div>
          ))}
        </dl>
      </details>
      <div className="mt-3 space-y-1.5">
        {survived.map((c, i) => (
          <div
            key={i}
            className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-surface-2 px-3 py-2"
          >
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${CONFIDENCE_META[c.confidence].dot}`}
            />
            <div className="min-w-0">
              <div className="text-sm text-content">{c.text}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
                <span>{CONFIDENCE_META[c.confidence].label} · {c.reason}</span>
                {c.label && (
                  <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted" title="Source entry in your résumé">
                    {c.label}
                  </span>
                )}
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    c.source === "brag_bank" ? "bg-brand-500/15 text-brand-200" : "bg-emerald/12 text-emerald"
                  }`}
                  title={c.source === "brag_bank" ? "Grounded in a fact you attested in your brag bank" : "Grounded in your résumé"}
                >
                  {c.source === "brag_bank" ? "✦ Brag bank" : "✓ Résumé"}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
