/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"] ,
  theme: {
    extend: {
      colors: {
        ink: "#0b1b22",
        steel: "#0f2a34",
        lake: "#1d4553",
        mint: "#7ad1c4",
        sand: "#f4f1e8",
        alert: "#ef4444"
      }
    }
  },
  plugins: []
};
