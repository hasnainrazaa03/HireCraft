import type { PipelineStatus, TrackerStatus } from "../lib/api";
import { TRACKER_META, trackerLabel } from "../lib/tracker";

// Each entry is a full badge class string built on the theme's accent tokens.
const PIPELINE_STYLES: Record<PipelineStatus, string> = {
  pending: "badge-muted",
  scraping: "badge-coral",
  extracting: "badge-coral",
  optimizing: "badge-coral",
  rendering: "badge-coral",
  completed: "badge-emerald",
  failed: "badge-danger",
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

// Tracker stages map onto the accent palette; terminal/negative use danger/muted.
// Derived from the single source of truth in lib/tracker.
export const TRACKER_STYLES = Object.fromEntries(
  Object.entries(TRACKER_META).map(([status, meta]) => [status, meta.badge]),
) as Record<TrackerStatus, string>;

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
    <span className={PIPELINE_STYLES[status]}>
      {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {PIPELINE_LABELS[status]}
    </span>
  );
}

export function TrackerBadge({ status }: { status: TrackerStatus }) {
  return <span className={TRACKER_STYLES[status]}>{trackerLabel(status)}</span>;
}
