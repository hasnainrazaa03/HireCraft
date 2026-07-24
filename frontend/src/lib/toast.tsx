/**
 * Lightweight toast system. A provider holds the queue; useToast() pushes
 * messages from anywhere. Toasts auto-dismiss and stack bottom-right, styled to
 * match the neo-dark surfaces with a colored accent bar per kind.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastState {
  toast: (t: Omit<Toast, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastState | null>(null);

const ACCENT: Record<ToastKind, string> = {
  success: "before:bg-emerald",
  error: "before:bg-danger",
  info: "before:bg-electric",
};

const ICON: Record<ToastKind, string> = {
  success: "M20 6 9 17l-5-5",
  error: "M18 6 6 18M6 6l12 12",
  info: "M12 16v-4M12 8h.01",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { ...t, id }].slice(-4));
      window.setTimeout(() => dismiss(id), t.kind === "error" ? 7000 : 4500);
    },
    [dismiss],
  );

  const value = useMemo<ToastState>(
    () => ({
      toast,
      success: (title, description) => toast({ kind: "success", title, description }),
      error: (title, description) => toast({ kind: "error", title, description }),
      info: (title, description) => toast({ kind: "info", title, description }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`glass pointer-events-auto relative animate-slide-in overflow-hidden py-3 pl-4 pr-9
              before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${ACCENT[t.kind]}`}
          >
            <div className="flex items-start gap-2.5">
              <svg
                className={`mt-0.5 h-4 w-4 shrink-0 ${
                  t.kind === "success"
                    ? "text-emerald"
                    : t.kind === "error"
                      ? "text-danger"
                      : "text-electric"
                }`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={ICON[t.kind]} />
                {t.kind === "info" && <circle cx="12" cy="12" r="10" />}
              </svg>
              <div className="min-w-0">
                <div className="text-sm font-medium text-content">{t.title}</div>
                {t.description && (
                  <div className="mt-0.5 text-xs text-muted">{t.description}</div>
                )}
              </div>
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="absolute right-2.5 top-2.5 text-subtle transition hover:text-content"
              aria-label="Dismiss"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
