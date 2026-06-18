/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
    './mt5Api.ts',
    './types.ts',
  ],
  theme: {
    extend: {
      colors: {
        gold: {
          50: '#fdf8e9',
          100: '#fbeec6',
          200: '#f8df93',
          300: '#f5cd5a',
          400: '#f2ba26',
          500: '#eab308',
          600: '#ca8a04',
          700: '#a16207',
          800: '#854d0e',
          900: '#713f12',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        soft: '0 4px 20px -2px rgba(0, 0, 0, 0.03)',
        card: '0 2px 10px -1px rgba(0, 0, 0, 0.04), 0 1px 3px -1px rgba(0, 0, 0, 0.02)',
        floating: '0 10px 40px -10px rgba(0,0,0,0.08)',
      },
    },
  },
  plugins: [],
};
