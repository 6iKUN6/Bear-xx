/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/index.html', './src/**/*.{html,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        td: {
          brand: {
            DEFAULT: '#0052D9',
            hover: '#366EF4',
            active: '#003CAB',
          },
          danger: '#E34D59',
          success: '#00A870',
          warning: '#ED7B2F',
          text: {
            primary: '#1D2129',
            secondary: '#4E5969',
            tertiary: '#86909C',
            disabled: '#C9CDD4',
            inverse: '#FFFFFF',
          },
          border: {
            base: '#DCDCDC',
            strong: '#C9CDD4',
          },
          bg: {
            page: '#F3F5F9',
            card: '#FFFFFF',
            secondary: '#F7F8FA',
            soft: '#EEF3FF',
          },
        },
      },
      borderRadius: {
        'td-sm': '10px',
        td: '16px',
        'td-lg': '20px',
        'td-xl': '24px',
        'td-pill': '9999px',
      },
      boxShadow: {
        'td-sm': '0 2px 10px rgba(17, 24, 39, 0.06)',
        td: '0 8px 24px rgba(17, 24, 39, 0.10)',
        'td-lg': '0 16px 36px rgba(17, 24, 39, 0.14)',
      },
      animation: {
        'fade-in': 'fade-in .3s ease both',
        'fade-in-up': 'fade-in-up .35s ease both',
        'scale-in': 'scale-in .25s ease both',
        blink: 'blink 1s step-start infinite',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(20px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.8)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
      },
    },
  },
  corePlugins: {
    preflight: false, // 小程序不需要 preflight
  },
}
