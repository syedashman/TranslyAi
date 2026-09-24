// Shared by the assistant-response action row (App.jsx) and the meeting result view (MeetingChat.jsx) - moved
// here unchanged so both reuse the exact same Gmail-compose behavior instead of duplicating it.

// Translation + summary, using exactly the values already shown on screen - nothing is regenerated or re-requested.
// The '**' strip matches the existing "Copy response" button, which already treats that as the plain-text form of
// the summary for contexts outside the markdown-aware SummaryText renderer.
export const buildEmailBody = (translation, summary) => {
  const cleanSummary = (summary || '').replace(/\*\*/g, '').trim();
  return cleanSummary ? `Translation:\n\n${translation}\n\nSummary:\n\n${cleanSummary}` : `Translation:\n\n${translation}`;
};

// Gmail's own compose URL, not mailto: - opens Gmail web directly (no OS chooser, no default-mail-client
// dependency). No "to" param on purpose: the user picks the recipient themselves inside Gmail. su/body are
// percent-encoded via encodeURIComponent, which correctly handles spaces, line breaks, punctuation, and any
// Unicode script (Urdu/Roman Urdu included).
export const buildGmailComposeUrl = (subject, body) =>
  `https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

// Opened in a new tab, directly from the click handler (not after an await) so browser popup blockers treat it as
// a genuine user-initiated navigation. Deliberately no fallback: if a blocker suppresses the new tab, this must
// stay a no-op rather than ever navigating the current TranslyAi tab away.
export function openGmailCompose(subject, body) {
  window.open(buildGmailComposeUrl(subject, body), '_blank', 'noopener,noreferrer');
}
