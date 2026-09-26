// Turns **bold** markers in model-written text into real bold text - one implementation for every place that shows summaries or
// translations (Translation Chat, Meeting Chat, Live Meeting viewer), so a raw "**" never reaches the screen.
//  - **Label:** text          -> <strong>Label:</strong> text
//  - an unmatched/stray "**"  -> removed (it is never shown)
export function withBold(text) {
  return String(text ?? '').split(/(\*\*[^\n]+?\*\*)/g).map((part, index) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2).trim()}</strong>;
    return part.replace(/\*\*/g, '');
  });
}
