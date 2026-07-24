import { useState, type KeyboardEvent } from "react";

/**
 * A chip-style multi-value input. Enter or comma commits the current text as a
 * tag; Backspace on an empty field removes the last one. De-dupes
 * case-insensitively so the same tag can't be added twice.
 */
export function TagInput({
  value,
  onChange,
  placeholder,
  max = 20,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max?: number;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const tag = draft.trim();
    if (!tag) return;
    if (!value.some((v) => v.toLowerCase() === tag.toLowerCase()) && value.length < max) {
      onChange([...value, tag]);
    }
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.08] bg-surface-3 px-2.5 py-2 focus-within:border-brand-500/60 focus-within:ring-2 focus-within:ring-brand-500/25">
      {value.map((tag) => (
        <span key={tag} className="badge-brand gap-1 pr-1">
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="grid h-4 w-4 place-items-center rounded-full text-brand-200 hover:bg-white/10"
            aria-label={`Remove ${tag}`}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      <input
        className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm text-content placeholder:text-subtle focus:outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={value.length === 0 ? placeholder : ""}
      />
    </div>
  );
}
