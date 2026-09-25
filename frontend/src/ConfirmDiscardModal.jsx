import { useEffect, useRef } from 'react';

// Same look as the delete-chat confirmation (DeleteModal.jsx). Used before a meeting/recording is DISCARDED:
// the safe choice ("keep going") is focused by default and Escape/backdrop also mean "keep going".
export default function ConfirmDiscardModal({ title, body, keepLabel = 'Keep going', discardLabel = 'Discard', onKeep, onDiscard }) {
  const keepRef = useRef(null);

  useEffect(() => {
    keepRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === 'Escape') onKeep(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeep]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onKeep(); }}>
      <div className="modal delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-body">
        <h2 id="discard-title">{title}</h2>
        <p id="discard-body">{body}</p>
        <div className="delete-modal-actions">
          <button type="button" className="cancel" ref={keepRef} onClick={onKeep}>{keepLabel}</button>
          <button type="button" className="confirm" onClick={onDiscard}>{discardLabel}</button>
        </div>
      </div>
    </div>
  );
}
