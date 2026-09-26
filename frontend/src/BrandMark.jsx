// The in-app TranslyAi logo: a green tile with a dark "T" (the same "T" as the favicon). Uses only theme tokens, so it works in
// light and dark mode; sized by .brand-mark in index.css.
export default function BrandMark({ className = '' }) {
  return (
    <div className={`brand-mark ${className}`.trim()} aria-hidden="true">
      <svg width="16" height="16" viewBox="6 6 20 20" fill="currentColor"><path d="M8 8.5h16v4.6h-5.7V24h-4.6V13.1H8z" /></svg>
    </div>
  );
}
