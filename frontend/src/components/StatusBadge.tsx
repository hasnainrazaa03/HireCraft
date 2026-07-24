import type { PipelineStatus, TrackerStatus } from "../lib/api";

const PIPELINE_STYLES: Record<PipelineStatus, string> = {
  pending: "bg-ink-100 text-ink-700",
  scraping: "bg-amber-100 text-amber-800",
  extracting: "bg-amber-100 text-amber-800",
  optimizing: "bg-amber-100 text-amber-800",
  rendering: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
};

const PIPELINE_LABELS: Record<PipelineStatus, string> = {
  pending: "Queued",
  scraping: "Reading job",
  extracting: "Extracting",
  optimizing: "Tailoring",
  rendering: "Typesetting",
  completed: "Ready",
  failed: "Failed",
};

export const TRACKER_STYLES: Record<TrackerStatus, string> = {
  draft: "bg-ink-100 text-ink-700",
  applied: "bg-blue-100 text-blue-800",
  screening: "bg-indigo-100 text-indigo-800",
  interviewing: "bg-violet-100 text-violet-800",
  offer: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  ghosted: "bg-ink-100 text-ink-500",
  withdrawn: "bg-ink-100 text-ink-500",
};

const IN_PROGRESS: PipelineStatus[] = [
  "pending",
  "scraping",
  "extracting",
  "optimizing",
  "rendering",
];

export function PipelineBadge({ status }: { status: PipelineStatus }) {
  const busy = IN_PROGRESS.includes(status);
  return (
    <span className={`badge ${PIPELINE_STYLES[status]}`}>
      {busy && (
        <span className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {PIPELINE_LABELS[status]}
    </span>
  );
}

export function TrackerBadge({ status }: { status: TrackerStatus }) {
  return (
    <span className={`badge capitalize ${TRACKER_STYLES[status]}`}>{status}</span>
  );
}
