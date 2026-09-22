import { useEffect, useRef, useState } from 'react';
import { Check, Link2, Sparkles, X } from 'lucide-react';
import { copyText } from './lib/clipboard';
import { WEB_ORIGIN } from './lib/config';
import { isNative, openExternal } from './lib/native';

const PREVIEW_LIMIT = 4;
const PREVIEW_CHARS = 170;

const XLogo = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
const LinkedInLogo = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" /></svg>;
const RedditLogo = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286A.72.72 0 0 0 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0zm4.388 3.199a1.999 1.999 0 1 1-1.947 2.46v.002a2.368 2.368 0 0 0-2.232 2.12 10.384 10.384 0 0 1 4.437 1.4 2.865 2.865 0 1 1 3.2 4.66c.011.13.017.262.017.394 0 3.593-4.185 6.507-9.349 6.507S3.164 17.828 3.164 14.235c0-.132.006-.264.017-.394a2.865 2.865 0 1 1 3.2-4.66 10.4 10.4 0 0 1 4.51-1.4 3.66 3.66 0 0 1 3.2-3.376 2 2 0 0 1 2.297-1.206zM8.113 12.62a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7.774 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-7.05 4.93a.4.4 0 0 0-.28.68 5.2 5.2 0 0 0 6.886 0 .4.4 0 0 0-.566-.566 4.4 4.4 0 0 1-5.754 0 .4.4 0 0 0-.286-.114z" /></svg>;

const clip = (text) => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}...` : text);

// Share dialog: a glass preview card of the chat plus quick actions for the chat's link.
export default function ShareModal({ chat, messages, onClose, onCopied, onError, onToggleShare }) {
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const timerRef = useRef(null);
  // On native, window.location.href is Capacitor's internal https://localhost origin - swap in the real public
  // site so a link shared from inside the Android app actually opens the chat for whoever receives it.
  const url = isNative ? `${WEB_ORIGIN}/${window.location.search}` : window.location.href;
  const isShared = Boolean(chat.is_shared);

  const flipShare = async () => {
    setSharing(true);
    try { await onToggleShare(!isShared); } finally { setSharing(false); }
  };

  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); window.clearTimeout(timerRef.current); };
  }, []);

  const preview = messages
    .filter((message) => (message.role === 'user' ? message.content || message.audioName : message.result?.english_translation))
    .slice(0, PREVIEW_LIMIT)
    .map((message) => (message.role === 'user'
      ? { id: message.id, who: 'You', text: message.content || 'Voice message' }
      : { id: message.id, who: 'TranslyAi', text: message.result.english_translation }));

  const copyLink = async () => {
    if (await copyText(url)) {
      setCopied(true); onCopied();
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } else onError();
  };

  const encoded = encodeURIComponent(url);
  const title = encodeURIComponent(chat.title);
  const open = (href) => openExternal(href);
  const targets = [
    { label: 'X', icon: <XLogo />, href: `https://twitter.com/intent/tweet?url=${encoded}&text=${title}` },
    { label: 'LinkedIn', icon: <LinkedInLogo />, href: `https://www.linkedin.com/sharing/share-offsite/?url=${encoded}` },
    { label: 'Reddit', icon: <RedditLogo />, href: `https://www.reddit.com/submit?url=${encoded}&title=${title}` },
  ];

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="share-head">
          <h2 id="share-title">Share chat</h2>
          <button type="button" className="share-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="share-preview">
          <div className="share-preview-title"><Sparkles size={14} />{chat.title}</div>
          <div className="share-preview-body">
            {preview.length
              ? preview.map((item) => <p key={item.id}><strong>{item.who}</strong>{clip(item.text)}</p>)
              : <p className="share-empty">This conversation is empty.</p>}
          </div>
        </div>

        <div className="share-toggle-row">
          <span>{isShared ? 'Anyone with the link can view this chat' : 'Only you can currently open this link'}</span>
          <button type="button" className={`share-toggle ${isShared ? 'on' : ''}`} role="switch" aria-checked={isShared} aria-label="Allow anyone with the link to view this chat" disabled={sharing} onClick={flipShare}>
            <span className="share-toggle-knob" />
          </button>
        </div>

        <div className="share-link">
          <Link2 size={15} />
          <input type="text" readOnly value={url} aria-label="Chat link" onFocus={(event) => event.target.select()} />
        </div>

        <div className="share-actions">
          <button type="button" className="share-action primary" onClick={copyLink}>
            {copied ? <Check size={16} /> : <Link2 size={16} />}{copied ? 'Copied' : 'Copy link'}
          </button>
          {targets.map((target) => (
            <button key={target.label} type="button" className="share-action" onClick={() => open(target.href)}>{target.icon}{target.label}</button>
          ))}
        </div>

        <p className="share-note">
          {isShared
            ? 'Anyone signed in with this link can view this conversation (read-only). Turn sharing off to make it private again.'
            : 'Turn sharing on so this link works for other people too. Until then it only opens for you.'}
        </p>
      </div>
    </div>
  );
}
