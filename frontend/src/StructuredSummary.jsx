// Renders a meeting summary. New Live Meeting summaries are sections ("### Heading" + "• bullet" lines); anything
// else - every summary saved before this existed - renders exactly as it always did (one plain paragraph).

function withBold(text) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).map((part, index) => (
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={index}>{part.slice(2, -2)}</strong> : part
  ));
}

export function parseSummarySections(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('### ')) { current = { heading: line.slice(4).trim(), points: [] }; sections.push(current); continue; }
    if (!current) { current = { heading: '', points: [] }; sections.push(current); }
    current.points.push(line.startsWith('• ') ? line.slice(2) : line);
  }
  return sections;
}

export default function StructuredSummary({ text }) {
  if (!/^### /m.test(String(text || ''))) return <p>{text}</p>;
  return (
    <div className="summary-sections">
      {parseSummarySections(text).map((section, index) => (
        <div className="summary-section" key={index}>
          {section.heading && <h4>{section.heading}</h4>}
          <ul className="summary-points">{section.points.map((point, i) => <li key={i}>{withBold(point)}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}
