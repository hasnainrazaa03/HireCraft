/**
 * Phone input: a searchable country-code dropdown (flag + dial code) joined to a
 * number field. Stores a single string like "+1 2139945086" so the backend
 * schema is unchanged; parses that back into country + number on load.
 */
import { useEffect, useRef, useState } from "react";

import { COUNTRIES, DEFAULT_COUNTRY, flagOf } from "../lib/countries";
import { IconChevronDown, IconSearch } from "./icons";

function parsePhone(value: string | null): { iso: string; number: string } {
  const v = (value || "").trim();
  if (v.startsWith("+")) {
    const raw = v.slice(1).replace(/\D/g, "");
    // Longest dial code first so "+1" doesn't shadow "+1264", etc. Stable sort
    // keeps the priority order (US before CA) for same-length codes like "1".
    const byLen = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);
    for (const c of byLen) {
      if (raw.startsWith(c.dial)) return { iso: c.iso, number: raw.slice(c.dial.length) };
    }
  }
  return { iso: DEFAULT_COUNTRY.iso, number: (value || "").replace(/\D/g, "") };
}

export function PhoneInput({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string) => void;
}) {
  const [iso, setIso] = useState(DEFAULT_COUNTRY.iso);
  const [number, setNumber] = useState("");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = parsePhone(value);
    setIso(p.iso);
    setNumber(p.number);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const country = COUNTRIES.find((c) => c.iso === iso) ?? DEFAULT_COUNTRY;

  function emit(nextIso: string, nextNumber: string) {
    const digits = nextNumber.replace(/\D/g, "");
    const c = COUNTRIES.find((x) => x.iso === nextIso) ?? DEFAULT_COUNTRY;
    onChange(digits ? `+${c.dial} ${digits}` : "");
  }

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? COUNTRIES.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) || c.dial.includes(needle.replace(/\D/g, "")),
      )
    : COUNTRIES;

  return (
    <div ref={ref} className="relative flex">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="input flex w-auto shrink-0 items-center gap-1.5 rounded-r-none border-r-0 pr-2"
        aria-label={`Country code: ${country.name} +${country.dial}`}
        aria-expanded={open}
      >
        <span className="text-base leading-none">{flagOf(country.iso)}</span>
        <span className="text-sm text-content">+{country.dial}</span>
        <IconChevronDown className="h-3.5 w-3.5 text-subtle" />
      </button>
      <input
        type="tel"
        inputMode="tel"
        aria-label="Phone number"
        className="input rounded-l-none"
        placeholder="Phone number"
        value={number}
        onChange={(e) => {
          const n = e.target.value.replace(/[^\d\s()-]/g, "");
          setNumber(n);
          emit(iso, n);
        }}
      />

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-xl border border-white/[0.1] bg-canvas-raised shadow-soft">
          <div className="border-b border-white/[0.06] p-2">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <input
                autoFocus
                className="input py-1.5 pl-8 text-sm"
                placeholder="Search country…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
          <ul className="max-h-60 overflow-y-auto py-1">
            {filtered.map((c) => (
              <li key={c.iso}>
                <button
                  type="button"
                  onClick={() => {
                    setIso(c.iso);
                    emit(c.iso, number);
                    setOpen(false);
                    setQ("");
                  }}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition hover:bg-surface-2 ${
                    c.iso === iso ? "bg-surface-2" : ""
                  }`}
                >
                  <span className="text-base leading-none">{flagOf(c.iso)}</span>
                  <span className="flex-1 truncate text-content">{c.name}</span>
                  <span className="text-subtle">+{c.dial}</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-subtle">No match.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
