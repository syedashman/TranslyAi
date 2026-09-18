/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ember: {
          50: '#fff4ed', 100: '#ffe1cc', 200: '#ffc29a', 300: '#ff9a5c', 400: '#ff7130',
          500: '#ff5500', 600: '#e33d00', 700: '#b92e00', 800: '#7d230d', 900: '#45170d'
        }
      },
      boxShadow: {
        soft: '0 24px 70px rgba(0, 0, 0, 0.42)',
        ember: '0 0 30px rgba(255, 85, 0, 0.22)',
        'ember-lg': '0 0 70px rgba(255, 68, 0, 0.36)'
      },
      backgroundImage: {
        'ember-gradient': 'linear-gradient(135deg, #ff7a18 0%, #ff3d00 52%, #a91500 100%)',
        'ember-radial': 'radial-gradient(circle at 50% 36%, rgba(255, 118, 40, 0.88), rgba(190, 30, 0, 0.38) 34%, transparent 70%)'
      },
      animation: {
        'orb-breathe': 'orb-breathe 4.8s ease-in-out infinite',
        'orb-pulse': 'orb-pulse 1.8s ease-in-out infinite',
        'rise-in': 'rise-in 700ms cubic-bezier(.2,.8,.2,1) both'
      },
      keyframes: {
        'orb-breathe': { '0%, 100%': { transform: 'scale(0.94) rotate(-8deg)', opacity: '0.82' }, '50%': { transform: 'scale(1.05) rotate(8deg)', opacity: '1' } },
        'orb-pulse': { '0%, 100%': { boxShadow: '0 0 25px rgba(255, 85, 0, .28), 0 0 70px rgba(255, 60, 0, .16)' }, '50%': { boxShadow: '0 0 42px rgba(255, 115, 30, .62), 0 0 110px rgba(255, 50, 0, .32)' } },
        'rise-in': { from: { opacity: '0', transform: 'translateY(18px)' }, to: { opacity: '1', transform: 'translateY(0)' } }
      }
    }
  },
  plugins: []
};
