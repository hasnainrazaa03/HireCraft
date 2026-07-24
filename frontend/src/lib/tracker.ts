import type { TrackerStatus } from "./api";

/**
 * Single source of truth for the tracker's stages: how each renders, the Kanban
 * columns, and how legacy/secondary statuses fold into a visible column. The
 * backend enum is a 17-stage superset; the board shows a curated 12, and every
 * status maps to exactly one column so no card ever goes missing.
 */

export interface StageMeta {
  label: string;
  badge: string;
  dot: string;
}

export const TRACKER_META: Record<TrackerStatus, StageMeta> = {
  wishlist: { label: "Wishlist", badge: "badge-muted", dot: "bg-white/30" },
  saved: { label: "Saved", badge: "badge-muted", dot: "bg-white/40" },
  preparing: { label: "Preparing", badge: "badge-coral", dot: "bg-coral" },
  draft: { label: "Draft", badge: "badge-muted", dot: "bg-white/30" },
  applied: { label: "Applied", badge: "badge-blue", dot: "bg-electric" },
  assessment: { label: "Assessment", badge: "badge-blue", dot: "bg-electric" },
  screening: { label: "Screening", badge: "badge-brand", dot: "bg-brand-400" },
  interviewing: { label: "Interviewing", badge: "badge-brand", dot: "bg-hotpink" },
  technical: { label: "Technical", badge: "badge-brand", dot: "bg-hotpink" },
  behavioral: { label: "Behavioral", badge: "badge-brand", dot: "bg-hotpink" },
  final: { label: "Final round", badge: "badge-brand", dot: "bg-brand-300" },
  offer: { label: "Offer", badge: "badge-emerald", dot: "bg-emerald" },
  accepted: { label: "Accepted", badge: "badge-emerald", dot: "bg-emerald" },
  rejected: { label: "Rejected", badge: "badge-danger", dot: "bg-danger" },
  ghosted: { label: "Ghosted", badge: "badge-muted", dot: "bg-white/25" },
  withdrawn: { label: "Withdrawn", badge: "badge-muted", dot: "bg-white/25" },
  archived: { label: "Archived", badge: "badge-muted", dot: "bg-white/25" },
};

export function trackerLabel(status: TrackerStatus): string {
  return TRACKER_META[status]?.label ?? status;
}

/** The ordered set of columns shown on the Kanban board (each is a settable status). */
export const BOARD_COLUMNS: { status: TrackerStatus; label: string; accent: string }[] = [
  { status: "wishlist", label: "Wishlist", accent: "bg-white/30" },
  { status: "saved", label: "Saved", accent: "bg-white/40" },
  { status: "preparing", label: "Preparing", accent: "bg-coral" },
  { status: "applied", label: "Applied", accent: "bg-electric" },
  { status: "assessment", label: "Assessment", accent: "bg-electric" },
  { status: "screening", label: "Screening", accent: "bg-brand-400" },
  { status: "interviewing", label: "Interviewing", accent: "bg-hotpink" },
  { status: "final", label: "Final", accent: "bg-brand-300" },
  { status: "offer", label: "Offer", accent: "bg-emerald" },
  { status: "accepted", label: "Accepted", accent: "bg-emerald" },
  { status: "rejected", label: "Rejected", accent: "bg-danger" },
  { status: "archived", label: "Archived", accent: "bg-white/25" },
];

// Statuses that are valid but aren't their own board column fold into one.
const COLUMN_FOR: Partial<Record<TrackerStatus, TrackerStatus>> = {
  draft: "preparing",
  technical: "interviewing",
  behavioral: "interviewing",
  ghosted: "archived",
  withdrawn: "archived",
};

export function columnFor(status: TrackerStatus): TrackerStatus {
  return COLUMN_FOR[status] ?? status;
}

/** All stages, in pipeline order — for dropdowns and manual selection. */
export const ALL_STAGES: TrackerStatus[] = [
  "wishlist", "saved", "preparing", "applied", "assessment", "screening",
  "interviewing", "technical", "behavioral", "final", "offer", "accepted",
  "rejected", "ghosted", "withdrawn", "archived",
];
