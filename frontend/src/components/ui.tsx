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

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
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
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`glass relative z-10 w-full animate-fade-in ${
          wide ? "max-w-2xl" : "max-w-md"
        }`}
      >
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
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
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-white/[0.07] px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// -- Stat card ----------------------------------------------------------------

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
  const toneRing: Record<string, string> = {
    brand: "bg-brand-500/12 text-brand-300",
    blue: "bg-electric/12 text-electric",
    pink: "bg-hotpink/12 text-hotpink",
    emerald: "bg-emerald/12 text-emerald",
    coral: "bg-coral/12 text-coral",
  };
  return (
    <div className="card card-hover p-5">
      <div className="flex items-start justify-between">
        {icon && (
          <div className={`grid h-11 w-11 place-items-center rounded-xl ${toneRing[tone]}`}>
            {icon}
          </div>
        )}
        {trend && (
          <span
            className={`text-xs font-medium ${
              trend.positive === false ? "text-danger" : "text-emerald"
            }`}
          >
            {trend.value}
          </span>
        )}
      </div>
      <div className="mt-4 text-2xl font-semibold tabular-nums text-content">
        {value}
      </div>
      <div className="mt-0.5 text-sm text-muted">{label}</div>
    </div>
  );
}
