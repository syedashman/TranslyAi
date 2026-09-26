import { useEffect, useRef } from 'react';

// ChatGPT-style confirmation shown before a saved chat is removed.
// detail: optional extra sentence (used for Meeting Chats, whose saved meetings are deleted with them).
export default function DeleteModal({ chat, detail = '', onCancel, onConfirm }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="modal delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-body">
        <h2 id="delete-title">Delete chat?</h2>
        <p id="delete-body">This will delete <strong>{chat.title}</strong>.{detail ? ` ${detail}` : ''}</p>
        <div className="delete-modal-actions">
          <button type="button" className="cancel" ref={cancelRef} onClick={onCancel}>Cancel</button>
          <button type="button" className="confirm" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}
