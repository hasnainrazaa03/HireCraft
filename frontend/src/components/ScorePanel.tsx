import type { ResumeAnalysis, Finding } from "../lib/api";
import { IconCheck, IconShield } from "./icons";

const GRADE_TONE: Record<string, string> = {
  Excellent: "text-emerald",
  Strong: "text-electric",
  Fair: "text-coral",
  "Needs work": "text-danger",
};

const SEVERITY_STYLE: Record<Finding["severity"], string> = {
  critical: "border-danger/30 bg-danger/5",
  warning: "border-coral/30 bg-coral/5",
  info: "border-white/[0.07] bg-surface-2",
  good: "border-emerald/30 bg-emerald/5",
};

const SEVERITY_DOT: Record<Finding["severity"], string> = {
  critical: "bg-danger",
  warning: "bg-coral",
  info: "bg-subtle",
  good: "bg-emerald",
};

function scoreColor(score: number): string {
  if (score >= 80) return "text-emerald";
  if (score >= 60) return "text-electric";
  if (score >= 40) return "text-coral";
  return "text-danger";
}

function ring(score: number): string {
  if (score >= 80) return "#2DD4BF";
  if (score >= 60) return "#4CC9F0";
  if (score >= 40) return "#FF9F43";
  return "#FF5C7A";
}

export function ScoreDial({ score }: { score: number }) {
  const r = 42;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);
  return (
    <div className="relative grid h-28 w-28 place-items-center">
      <svg className="h-28 w-28 -rotate-90" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
        <circle
          cx="50" cy="50" r={r} fill="none" stroke={ring(score)} strokeWidth="8"
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div className="absolute text-center">
        <div className={`text-2xl font-semibold tabular-nums ${scoreColor(score)}`}>{score}</div>
        <div className="text-[10px] text-subtle">/ 100</div>
      </div>
    </div>
  );
}

export function ScorePanel({ analysis }: { analysis: ResumeAnalysis }) {
  const findings = analysis.findings;
  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  const warnCount = findings.filter((f) => f.severity === "warning").length;

  return (
    <div className="space-y-5">
      {/* Overall + ATS */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="card flex items-center gap-5 p-5">
          <ScoreDial score={analysis.overall_score} />
          <div>
            <div className={`text-lg font-semibold ${GRADE_TONE[analysis.grade] ?? ""}`}>{analysis.grade}</div>
            <div className="text-sm text-muted">Overall résumé score</div>
            <div className="mt-2 text-xs text-subtle">
              {analysis.bullet_count} bullets · {analysis.quantified_bullets} quantified · ~{analysis.estimated_pages} page(s)
            </div>
          </div>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <IconShield className="h-4 w-4 text-brand-300" />
              <span className="text-sm font-medium">ATS compatibility</span>
            </div>
            <span className={`text-lg font-semibold tabular-nums ${scoreColor(analysis.ats_score)}`}>{analysis.ats_score}</span>
          </div>
          <div className="mt-3 space-y-1.5">
            {analysis.ats_checks.map((c) => (
              <div key={c.name} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full ${c.passed ? "bg-emerald/15 text-emerald" : "bg-danger/15 text-danger"}`}>
                  {c.passed ? <IconCheck className="h-3 w-3" /> : "×"}
                </span>
                <span className={c.passed ? "text-muted" : "text-content"} title={c.detail}>{c.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Metric bars */}
      <div className="card p-5">
        <h3 className="mb-4 text-sm font-medium">Score breakdown</h3>
        <div className="space-y-3">
          {analysis.metrics.map((m) => (
            <div key={m.key}>
              <div className="flex items-center justify-between text-sm">
                <span className="text-content">{m.label}</span>
                <span className={`tabular-nums ${scoreColor(m.score)}`}>{m.score}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full" style={{ width: `${m.score}%`, background: ring(m.score), transition: "width 0.5s ease" }} />
              </div>
              <div className="mt-0.5 text-xs text-subtle">{m.detail}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Suggestions */}
      <div className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium">Suggestions</h3>
          <span className="text-xs text-subtle">
            {criticalCount > 0 && <span className="text-danger">{criticalCount} critical · </span>}
            {warnCount > 0 && <span className="text-coral">{warnCount} to improve · </span>}
            {findings.length} total
          </span>
        </div>
        {findings.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-emerald/30 bg-emerald/5 px-3 py-2.5 text-sm text-emerald">
            <IconCheck className="h-4 w-4" /> Nothing to fix — this résumé is in great shape.
          </div>
        ) : (
          <div className="space-y-2">
            {findings.map((f, i) => (
              <div key={i} className={`rounded-xl border px-3 py-2.5 ${SEVERITY_STYLE[f.severity]}`}>
                <div className="flex items-start gap-2.5">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[f.severity]}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-content">
                      {f.title}
                      {f.location && <span className="ml-2 text-xs font-normal text-subtle">· {f.location}</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">{f.detail}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
