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
      {diff.map((entry, index) => (
        <div key={index} className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/[0.08] bg-surface-2 px-4 py-2">
            <span className="text-sm font-medium">{entry.label}</span>
            <span className="text-xs uppercase tracking-wide text-subtle">
              {entry.section} · {entry.change}
            </span>
          </div>
          <div className="grid gap-px bg-white/[0.06] md:grid-cols-2">
            <DiffSide title="Original" value={entry.before} tone="before" />
            <DiffSide title={afterLabel} value={entry.after} tone="after" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffSide({
  title,
  value,
  tone,
}: {
  title: string;
  value: string | string[] | null;
  tone: "before" | "after";
}) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return (
    <div className={`p-4 ${tone === "after" ? "bg-emerald/[0.05]" : "bg-surface"}`}>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
        {title}
      </div>
      {items.length === 0 ? (
        <p className="text-sm italic text-subtle">— removed —</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, index) => (
            <li key={index} className="text-sm leading-relaxed text-content">
              {item}
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
            <span key={k} className={CONFIDENCE_META[k].badge}>
              {counts[k]} {CONFIDENCE_META[k].label}
            </span>
          ) : null,
        )}
      </div>
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
              <div className="mt-0.5 text-xs text-subtle">
                {CONFIDENCE_META[c.confidence].label} · {c.reason}{" "}
                {c.label ? `· ${c.label}` : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
