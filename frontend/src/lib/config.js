export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://virtual-ai-translator.onrender.com';

// The public web app's origin. Used only to build a shareable chat link on native Android, where
// window.location.href points at Capacitor's internal https://localhost origin - meaningless outside the app.
export const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN || 'https://translyai.netlify.app';
