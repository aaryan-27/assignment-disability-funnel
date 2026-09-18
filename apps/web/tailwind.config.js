/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A single accent ramp. The reference funnel uses one saturated purple;
        // we keep that identity but add the tonal range a real design system
        // needs for hover, focus, borders and disabled states.
        brand: {
          50: '#f3f0ff',
          100: '#e9e3ff',
          200: '#d5cbff',
          300: '#b9a6ff',
          400: '#9875ff',
          500: '#7c43ff',
          600: '#6d28f5',
          700: '#5b1bd6',
          800: '#4c18ae',
          900: '#40178b',
        },
        ink: {
          DEFAULT: '#12101a',
          soft: '#3f3b52',
          muted: '#6b6780',
        },
        canvas: '#f7f5f2',
      },
      fontFamily: {
        sans: [
          'Inter var',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgba(18,16,26,0.04), 0 12px 32px -12px rgba(18,16,26,0.12)',
        option: '0 1px 2px rgba(18,16,26,0.05)',
        'option-hover': '0 4px 16px -4px rgba(124,67,255,0.28)',
      },
      keyframes: {
        // Fast, short-distance motion. Long slides feel sluggish on a funnel
        // where a user answers 15 questions in under a minute.
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-back': {
          from: { opacity: '0', transform: 'translateX(-16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.3)', opacity: '0' },
          '100%': { transform: 'scale(1.3)', opacity: '0' },
        },
      },
      animation: {
        'slide-in': 'slide-in 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        'slide-in-back': 'slide-in-back 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        'fade-up': 'fade-up 260ms cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.22, 1, 0.36, 1) infinite',
      },
    },
  },
  plugins: [],
};
