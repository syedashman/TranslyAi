// formatDuration: the live meeting timer's exact original format (MeetingChat) - always HH:MM:SS, unchanged.
export function formatDuration(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// formatDurationShort: a compact form for the Meeting History list preview (e.g. "03:12" for a 3-minute-12-second
// meeting, "1:14:02" once it runs past an hour) - a separate function so the live timer's format is never changed.
export function formatDurationShort(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
