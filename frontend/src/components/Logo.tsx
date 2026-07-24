/**
 * HireCraft logo — a lowercase "h" whose right stem sweeps into a rounded arc,
 * in the brand purple→blue gradient, with a sparkle to the upper-right. Concept:
 * crafting your career story (the arc) with a standout spark (the star).
 *
 * LogoMark  — the glyph alone (transparent).
 * Logo      — the glyph on a rounded gradient tile (the app-icon look).
 * Wordmark  — Logo + "HireCraft" set in the brand face.
 */

let gradientSeq = 0;

export function LogoMark({ className = "h-6 w-6" }: { className?: string }) {
  // Unique gradient ids so multiple marks on one page don't collide.
  const id = `hc-logo-${gradientSeq++}`;
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="6" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7C4DFF" />
          <stop offset="1" stopColor="#4CC9F0" />
        </linearGradient>
      </defs>
      {/* left stem */}
      <rect x="9" y="6.5" width="7.6" height="35" rx="3.8" fill={`url(#${id})`} />
      {/* shoulder + right leg (the "h" hump sweeping into an arc) */}
      <path
        d="M12.8 25.5 C 12.8 19.5, 18.2 16.6, 23.8 16.6 C 30.2 16.6, 33.4 21, 33.4 27 L 33.4 37.7"
        stroke={`url(#${id})`}
        strokeWidth="7.6"
        strokeLinecap="round"
      />
      {/* sparkle */}
      <path
        d="M37.5 7 C 37.9 10.3 39.2 11.6 42.5 12 C 39.2 12.4 37.9 13.7 37.5 17 C 37.1 13.7 35.8 12.4 32.5 12 C 35.8 11.6 37.1 10.3 37.5 7 Z"
        fill="#B98CFF"
      />
    </svg>
  );
}

export function Logo({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <span
      className={`grid place-items-center rounded-xl bg-[#12101f] shadow-glow-strong ring-1 ring-white/10 ${className}`}
    >
      <LogoMark className="h-[70%] w-[70%]" />
    </span>
  );
}

export function Wordmark({
  className = "",
  size = "text-lg",
  tile = true,
}: {
  className?: string;
  size?: string;
  tile?: boolean;
}) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      {tile ? <Logo className="h-9 w-9" /> : <LogoMark className="h-7 w-7" />}
      <span className={`font-semibold tracking-tight ${size}`}>HireCraft</span>
    </span>
  );
}
