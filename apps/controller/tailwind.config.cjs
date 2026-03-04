/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"] ,
  theme: {
    extend: {
      colors: {
        obsidian: "#121012",
        plum: "#2a1f2d",
        ember: "#ff6a3d",
        cloud: "#f2efe9",
        mist: "#9aa7b2"
      }
    }
  },
  plugins: []
};
