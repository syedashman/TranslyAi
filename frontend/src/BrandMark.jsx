// The TranslyAi logo: a bold white "T" in a dark rounded square (the same "T" is used for the favicon and PWA icons).
export default function BrandMark({ className = '' }) {
  return <div className={`brand-mark ${className}`.trim()} aria-hidden="true"><span className="t-glyph">T</span></div>;
}
