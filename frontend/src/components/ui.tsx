/**
 * Small, reusable presentational primitives shared across pages. Behavioral
 * pieces (theme, toast) live in lib/; these are pure UI.
 */
import { useEffect, type ReactNode } from "react";

// -- Spinner ------------------------------------------------------------------

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-white/15 border-t-brand-400 ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

export function PageLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted">
      <Spinner className="h-7 w-7" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

// -- Skeleton -----------------------------------------------------------------

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

// -- Empty state --------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center px-8 py-14 text-center">
      {icon && (
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-brand-500/12 text-brand-300">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-content">{title}</h3>
      {description && (
        <p className="mt-2 max-w-md text-sm text-muted">{description}</p>
      )}
      {action && <div className="mt-6 flex gap-3">{action}</div>}
    </div>
  );
}

// -- Modal --------------------------------------------------------------------

const MODAL_WIDTHS = {
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-5xl",
} as const;

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  size,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  // Explicit width tier. Falls back to `wide` (lg) / default (md) for callers
  // that haven't opted in. Use "xl" for content-heavy modals (PDF previews,
  // before/after diffs, score breakdowns).
  size?: keyof typeof MODAL_WIDTHS;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-md animate-fade-in"
        onClick={onClose}
      />
      {/* Capped to the viewport and laid out as a column, so tall content
          scrolls inside the body while the title and footer stay put. Without
          the cap the panel overflowed the centred flex container at both ends
          and the top was unreachable — the page itself can't scroll either,
          since opening the modal sets body overflow to hidden. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`glass modal-panel relative z-10 flex w-full flex-col animate-fade-in ${
          MODAL_WIDTHS[size ?? (wide ? "lg" : "md")]
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-base font-semibold text-content">{title}</h2>
          <button
            onClick={onClose}
            className="text-subtle transition hover:text-content"
            aria-label="Close"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-white/[0.07] px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// -- Stat card ----------------------------------------------------------------

const STAT_TONE: Record<string, { tile: string; hex: string }> = {
  brand: { tile: "bg-brand-500/15 text-brand-300", hex: "#7C4DFF" },
  blue: { tile: "bg-electric/15 text-electric", hex: "#4CC9F0" },
  pink: { tile: "bg-hotpink/15 text-hotpink", hex: "#FF4FD8" },
  emerald: { tile: "bg-emerald/15 text-emerald", hex: "#2DD4BF" },
  coral: { tile: "bg-coral/15 text-coral", hex: "#FF9F43" },
};

export function StatCard({
  label,
  value,
  icon,
  trend,
  tone = "brand",
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  trend?: { value: string; positive?: boolean };
  tone?: "brand" | "blue" | "pink" | "emerald" | "coral";
}) {
  const t = STAT_TONE[tone];
  return (
    <div className="card card-hover relative overflow-hidden p-5">
      {/* ambient tone glow */}
      <div
        className="pointer-events-none absolute -right-8 -top-12 h-36 w-36 rounded-full opacity-50 blur-2xl"
        style={{ background: `radial-gradient(circle, ${t.hex}40, transparent 68%)` }}
      />
      <div className="relative flex items-start justify-between">
        {icon && (
          <div
            className={`grid h-12 w-12 place-items-center rounded-2xl ring-1 ring-inset ring-white/10 ${t.tile}`}
            style={{ boxShadow: `0 0 22px -8px ${t.hex}` }}
          >
            {icon}
          </div>
        )}
        {trend && (
          <span className={`text-xs font-medium ${trend.positive === false ? "text-danger" : "text-emerald"}`}>
            {trend.value}
          </span>
        )}
      </div>
      <div className="relative mt-5 text-3xl font-bold tabular-nums text-content">{value}</div>
      <div className="relative mt-0.5 text-sm text-muted">{label}</div>
    </div>
  );
}
