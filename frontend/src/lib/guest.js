// Guests can try TranslyAi for a few messages before they are asked to sign up.
// The count lives in localStorage, so it is a friendly limit for the UI, not a security control.
export const GUEST_LIMIT = 5;
const KEY = 'guest_chat_count';

export function getGuestCount() {
  try {
    const value = parseInt(localStorage.getItem(KEY), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch { return 0; }
}

export function bumpGuestCount() {
  const next = getGuestCount() + 1;
  try { localStorage.setItem(KEY, String(next)); } catch { /* the in-memory count still applies for this visit */ }
  return next;
}
