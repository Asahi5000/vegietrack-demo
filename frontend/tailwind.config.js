/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff8f1',
          100: '#dcefe0',
          200: '#bfe1c7',
          300: '#91cb9f',
          400: '#5dae72',
          500: '#398f54',
          600: '#2c7544',
          700: '#245d39',
          800: '#204b31',
          900: '#1b3d29',
        }
      }
    },
  },
  plugins: [],
}
