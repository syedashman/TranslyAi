import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, ChevronsUpDown, LoaderCircle, Lock, LogOut, Moon, Settings, Sun, User, X } from 'lucide-react';
import pkg from '../package.json';
import { supabase } from './lib/supabase';
import { getStoredTheme, setTheme } from './lib/theme';
import { resizeImageToBlob } from './lib/avatar';

const AVATAR_BUCKET = 'avatars';
const NAME_MAX_LENGTH = 60;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function Avatar({ user, className = '' }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [user.avatarUrl]);
  return (
    <div className={`account-avatar ${className}`}>
      {user.avatarUrl && !broken
        ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : (user.name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function friendlyStorageError(error) {
  const message = error?.message || '';
  if (/bucket not found/i.test(message)) return "Photo uploads aren't set up yet. Run the avatar storage SQL in Supabase first.";
  if (/row-level security|policy|not authorized|unauthorized/i.test(message)) return "You're not allowed to upload here yet. Check the avatar storage policies in Supabase.";
  if (/failed to fetch|network/i.test(message)) return 'Network error. Check your connection and try again.';
  return message || 'Something went wrong. Please try again.';
}

function removeOldAvatar(url, userId) {
  const marker = `/object/public/${AVATAR_BUCKET}/`;
  const index = url ? url.indexOf(marker) : -1;
  if (index === -1) return;
  const path = decodeURIComponent(url.slice(index + marker.length).split('?')[0]);
  if (path.startsWith(`${userId}/`)) supabase.storage.from(AVATAR_BUCKET).remove([path]).catch(() => {});
}

function ProfileModal({ user, onClose, onProfileChange }) {
  const [name, setName] = useState(user.name);
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(null);
  const fileInputRef = useRef(null);
  const trimmedName = name.trim();
  const canSaveName = trimmedName.length > 0 && trimmedName !== user.name && !savingName;

  const saveName = async (event) => {
    event.preventDefault();
    if (!canSaveName) return;
    if (trimmedName.length > NAME_MAX_LENGTH) { setMessage({ type: 'error', text: `Name must be ${NAME_MAX_LENGTH} characters or fewer.` }); return; }
    setSavingName(true); setMessage(null);
    const { error } = await supabase.from('profiles').upsert(
      { id: user.id, email: user.email, full_name: trimmedName, updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    );
    setSavingName(false);
    if (error) { setMessage({ type: 'error', text: `Couldn't save your name: ${error.message}` }); return; }
    onProfileChange({ name: trimmedName });
    setMessage({ type: 'success', text: 'Name updated.' });
  };

  const uploadPhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!PHOTO_TYPES.includes(file.type)) { setMessage({ type: 'error', text: 'Please choose a JPG, PNG or WebP image.' }); return; }
    if (file.size > MAX_PHOTO_BYTES) { setMessage({ type: 'error', text: 'That image is too large. Please choose one under 8 MB.' }); return; }

    setUploading(true); setMessage(null);
    try {
      const blob = await resizeImageToBlob(file);
      const path = `${user.id}/avatar-${Date.now()}.jpg`;
      const { error: uploadError } = await supabase.storage.from(AVATAR_BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '3600' });
      if (uploadError) throw uploadError;
      const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
      const { error: saveError } = await supabase.from('profiles').upsert(
        { id: user.id, email: user.email, avatar_url: data.publicUrl, updated_at: new Date().toISOString() },
        { onConflict: 'id' },
      );
      if (saveError) throw saveError;
      removeOldAvatar(user.avatarUrl, user.id);
      onProfileChange({ avatarUrl: data.publicUrl });
      setMessage({ type: 'success', text: 'Profile photo updated.' });
    } catch (error) {
      setMessage({ type: 'error', text: friendlyStorageError(error) });
    } finally { setUploading(false); }
  };

  return (
    <Modal title="Profile" onClose={onClose}>
      <div className="avatar-editor">
        <div className="avatar-large-wrap">
          <Avatar user={user} className="avatar-large" />
          {uploading && <div className="avatar-busy"><LoaderCircle size={22} className="spin" /></div>}
        </div>
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            <Camera size={15} />{uploading ? 'Uploading...' : 'Change photo'}
          </button>
          <p className="field-hint">JPG, PNG or WebP. It will be cropped to a square.</p>
          <input ref={fileInputRef} type="file" accept={PHOTO_TYPES.join(',')} onChange={uploadPhoto} hidden />
        </div>
      </div>

      <form onSubmit={saveName}>
        <label className="field">Name
          <input type="text" value={name} onChange={(event) => { setName(event.target.value); setMessage(null); }} maxLength={NAME_MAX_LENGTH + 20} autoComplete="name" />
        </label>
        <label className="field">Email
          <div className="field-locked">
            <input type="email" value={user.email || ''} readOnly disabled />
            <Lock size={14} />
          </div>
          <span className="field-hint">Your email can't be changed.</span>
        </label>
        {message && <div className={`auth-message ${message.type === 'error' ? 'auth-error' : 'auth-notice'}`} role={message.type === 'error' ? 'alert' : 'status'}>{message.text}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={!canSaveName}>
            {savingName ? <LoaderCircle size={16} className="spin" /> : 'Save name'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsModal({ onClose, onSignOut }) {
  const [theme, setThemeState] = useState(getStoredTheme);
  const chooseTheme = (next) => { setTheme(next); setThemeState(next); };

  return (
    <Modal title="Settings" onClose={onClose}>
      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="theme-options" role="radiogroup" aria-label="Theme">
          {[['dark', 'Dark', Moon], ['light', 'Light', Sun]].map(([value, label, Icon]) => (
            <button key={value} type="button" role="radio" aria-checked={theme === value} className={`theme-option ${theme === value ? 'active' : ''}`} onClick={() => chooseTheme(value)}>
              <Icon size={18} />{label}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <h3>About</h3>
        <div className="about-row"><span>LinguaAI version</span><strong>{pkg.version}</strong></div>
      </section>
      <section className="settings-section">
        <h3>Account</h3>
        <button type="button" className="btn btn-danger" onClick={() => { onClose(); onSignOut(); }}><LogOut size={15} />Log out</button>
      </section>
    </Modal>
  );
}

export default function AccountMenu({ user, onSignOut, onProfileChange }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event) => { if (!wrapRef.current?.contains(event.target)) setMenuOpen(false); };
    const onKeyDown = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [menuOpen]);

  const open = (next) => { setMenuOpen(false); setScreen(next); };
  const closeScreen = () => setScreen(null);

  return (
    <div className="account-wrap" ref={wrapRef}>
      {menuOpen && (
        <div className="account-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => open('profile')}><User size={16} />Profile</button>
          <button type="button" role="menuitem" onClick={() => open('settings')}><Settings size={16} />Settings</button>
        </div>
      )}
      <button type="button" className="account-row account-trigger" onClick={() => setMenuOpen((current) => !current)} aria-haspopup="menu" aria-expanded={menuOpen}>
        <Avatar user={user} />
        <div className="account-info"><strong>{user.name}</strong><span>{user.email}</span></div>
        <ChevronsUpDown size={15} className="account-chevron" />
      </button>
      {screen === 'profile' && <ProfileModal user={user} onClose={closeScreen} onProfileChange={onProfileChange} />}
      {screen === 'settings' && <SettingsModal onClose={closeScreen} onSignOut={onSignOut} />}
    </div>
  );
}
