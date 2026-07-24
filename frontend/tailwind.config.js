/**
 * HireCraft design tokens — "Premium Neo-Dark Workspace".
 *
 * Two kinds of color live here:
 *   - Brand/accent scales (purple, blue, pink, orange, emerald, red): fixed
 *     hex, identical in every theme. These are the vibrant focal colors used
 *     sparingly on hero cards, buttons, and charts.
 *   - Semantic surface/text/border colors: driven by CSS variables defined in
 *     index.css so a single [data-theme] switch restyles the whole app between
 *     dark (primary) and light. Never hard-code a surface color in a component;
 *     reach for bg-surface / text-muted / border-hairline instead.
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // --- Semantic, theme-aware (see :root / [data-theme] in index.css) ---
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        "canvas-raised": "rgb(var(--canvas-raised) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2) / <alpha-value>)",
        "surface-3": "rgb(var(--surface-3) / <alpha-value>)",
        content: "rgb(var(--content) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        subtle: "rgb(var(--subtle) / <alpha-value>)",

        // --- Brand: royal purple → electric violet → deep indigo ---
        brand: {
          50: "#F1EEFF",
          100: "#E4DCFF",
          200: "#C9B8FF",
          300: "#AB90FF",
          400: "#8B5CF6",
          500: "#7C5CFF",
          600: "#6D4AFF",
          700: "#5B36FF",
          800: "#4A2CD6",
          900: "#3A22A8",
          950: "#221463",
        },
        indigo: { DEFAULT: "#9D4EDD" },

        // --- Accents (used sparingly) ---
        electric: "#4CC9F0", // secondary glow / info
        hotpink: "#FF4FD8", // graphs, hero highlights
        coral: "#FF9F43", // warm highlight
        emerald: "#2DD4BF", // positive metrics only
        danger: "#FF5C7A", // negative, sparingly
      },
      fontFamily: {
        sans: [
          "Inter",
          "Inter var",
          "SF Pro Display",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        xl: "16px",
        "2xl": "18px",
        "3xl": "22px",
        hero: "26px",
      },
      boxShadow: {
        // Soft, never harsh.
        soft: "0 10px 40px rgba(0,0,0,0.35)",
        card: "0 4px 24px rgba(0,0,0,0.25)",
        // Ambient colored glow — the signature of the theme.
        glow: "0 0 80px rgba(110,70,255,0.12)",
        "glow-strong": "0 8px 40px rgba(110,70,255,0.35)",
        "glow-blue": "0 0 60px rgba(76,201,240,0.15)",
        "glow-pink": "0 0 60px rgba(255,79,216,0.15)",
      },
      backgroundImage: {
        // Primary button + focal gradients.
        "brand-gradient": "linear-gradient(135deg, #7C5CFF 0%, #5B36FF 100%)",
        "brand-gradient-hover": "linear-gradient(135deg, #8B6BFF 0%, #6B46FF 100%)",
        // Large hero card: purple → indigo → blue → warm coral, airbrushed.
        "hero-gradient":
          "linear-gradient(135deg, #6D4AFF 0%, #9D4EDD 38%, #4CC9F0 72%, #FF9F43 100%)",
        "hero-purple":
          "linear-gradient(135deg, #6D4AFF 0%, #8B5CF6 50%, #9D4EDD 100%)",
        "hero-cool": "linear-gradient(135deg, #6D4AFF 0%, #4CC9F0 100%)",
        "hero-warm": "linear-gradient(135deg, #9D4EDD 0%, #FF4FD8 55%, #FF9F43 100%)",
        // Subtle ambient radial glows layered behind sections.
        "ambient-purple":
          "radial-gradient(60% 60% at 50% 0%, rgba(110,70,255,0.18) 0%, rgba(110,70,255,0) 70%)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateX(12px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "slide-in": "slide-in 0.25s ease-out",
      },
    },
  },
  plugins: [],
};
