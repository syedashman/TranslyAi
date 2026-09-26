// Renders a meeting summary. New Live Meeting summaries are sections ("### Heading" + "• bullet" lines); anything
// else - every summary saved before this existed - renders exactly as it always did (one plain paragraph).

import { withBold } from './lib/richText';

export function parseSummarySections(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { current = { heading: heading[1].trim(), points: [] }; sections.push(current); continue; }
    if (!current) { current = { heading: '', points: [] }; sections.push(current); }
    current.points.push(line.startsWith('• ') ? line.slice(2) : line);
  }
  return sections;
}

export default function StructuredSummary({ text }) {
  if (!/^#{1,6}\s+\S/m.test(String(text || ''))) return <p>{withBold(text)}</p>;
  return (
    <div className="summary-sections">
      {parseSummarySections(text).map((section, index) => (
        <div className="summary-section" key={index}>
          {section.heading && <h4>{withBold(section.heading)}</h4>}
          <ul className="summary-points">{section.points.map((point, i) => <li key={i}>{withBold(point)}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}
