/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // VS Code / Linear-inspired neutral palette
        surface: {
          DEFAULT: "#1e1e2e",
          raised: "#2a2a3d",
          overlay: "#313147",
        },
        accent: {
          DEFAULT: "#7c6af7",
          hover: "#6a58e3",
        },
        muted: "#6b7280",
      },
    },
  },
  plugins: [],
};
