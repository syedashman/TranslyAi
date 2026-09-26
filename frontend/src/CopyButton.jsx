import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

const TICK_MS = 2000;

// A Copy icon button that confirms in place: the icon turns into a tick for a couple of seconds (like ChatGPT) instead of
// showing a message. onCopy(text, null) must resolve true when the text really reached the clipboard (App's copyWithToast,
// where a null label means "no toast"); on failure the icon stays a Copy icon and the app's own error message is shown.
export default function CopyButton({ text, onCopy, className = '', label = 'Copy response', size = 15 }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const handleClick = async () => {
    if (await onCopy(text, null) === false) return;
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), TICK_MS);
  };

  return (
    <button type="button" className={className || undefined} aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label} onClick={handleClick}>
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
