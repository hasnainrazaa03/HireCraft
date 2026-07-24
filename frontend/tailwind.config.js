/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f5f7fa",
          100: "#e9eef5",
          200: "#cdd8e6",
          300: "#a4b8d0",
          400: "#7392b4",
          500: "#52739a",
          600: "#3f5b80",
          700: "#344a68",
          800: "#2e3f57",
          900: "#1a3e6f",
          950: "#111f33",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
