module.exports = {
  content: ["./src/renderer/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        navy: "#2c2825",
        slatecopy: "#78716c",
        brand: { DEFAULT: "#b45309", light: "#d97706" },
      },
      fontFamily: {
        monoDisplay: ['"SFMono-Regular"', '"Cascadia Code"', '"Roboto Mono"', "monospace"],
      },
      boxShadow: {
        glass: "0 24px 70px rgba(120, 113, 108, 0.15)",
      },
    },
  },
};
