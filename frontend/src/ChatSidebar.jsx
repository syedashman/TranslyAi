import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive, ArchiveRestore, ChevronDown, ChevronRight, LoaderCircle, MessageCircle, MoreHorizontal,
  PanelLeftClose, Pencil, Pin, PinOff, Search, SquarePen, Trash2, Users, X,
} from 'lucide-react';
import AccountMenu from './AccountMenu';
import BrandMark from './BrandMark';
import { CTA_LOGIN, CTA_SIGNUP } from './lib/authCta';

const MENU_WIDTH = 190;

// Generic pin/archive/rename/delete menu - used for both a Translation chat and a Meeting Chat (they only differ in
// which callbacks the caller passes in).
function ChatMenu({ chat, anchor, onClose, onTogglePin, onToggleArchive, onRename, onDelete }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const onPointerDown = (event) => { if (!menuRef.current?.contains(event.target)) onClose(); };
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const rect = anchor.getBoundingClientRect();
  const estimatedHeight = chat.is_archived ? 132 : 172;
  const flipUp = rect.bottom + estimatedHeight + 8 > window.innerHeight;
  const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
  const style = {
    width,
    left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    ...(flipUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
  };

  return createPortal(
    <div className="chat-menu" role="menu" ref={menuRef} style={style}>
      {!chat.is_archived && (
        <button type="button" role="menuitem" onClick={() => { onTogglePin(chat); onClose(); }}>
          {chat.is_pinned ? <PinOff size={15} /> : <Pin size={15} />}{chat.is_pinned ? 'Unpin Chat' : 'Pin Chat'}
        </button>
      )}
      <button type="button" role="menuitem" onClick={() => { onToggleArchive(chat); onClose(); }}>
        {chat.is_archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{chat.is_archived ? 'Unarchive Chat' : 'Archive Chat'}
      </button>
      <button type="button" role="menuitem" onClick={() => { onRename(chat); onClose(); }}>
        <Pencil size={15} />Rename Chat
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => { onDelete(chat); onClose(); }}
      >
        <Trash2 size={15} />Delete Chat
      </button>
    </div>,
    document.body,
  );
}

// Small rename dialog (same modal look as the rest of the app): pre-filled with the current name, Save is only enabled for a
// new, non-empty name of at most 120 characters.
function RenameModal({ chat, onSave, onCancel }) {
  const [value, setValue] = useState(chat.title);
  const inputRef = useRef(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKeyDown = (event) => { if (event.key === 'Escape') cancelRef.current(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== chat.title;
  const submit = (event) => { event.preventDefault(); if (canSave) onSave(trimmed); };
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <form className="modal rename-modal" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={submit}>
        <div className="modal-header"><h2 id="rename-title">Rename chat</h2></div>
        <input ref={inputRef} className="rename-input" type="text" value={value} maxLength={120} aria-label="Chat name" onChange={(event) => setValue(event.target.value)} />
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!canSave}>Save</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function ChatItem({ chat, active, withIcon, icon: Icon = MessageCircle, menuOpen, onSelect, onOpenMenu }) {
  return (
    <div
      className={`session-item ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}
      onContextMenu={(event) => { event.preventDefault(); onOpenMenu(chat, event.currentTarget.querySelector('.chat-more')); }}
    >
      <button type="button" className="session-select" onClick={() => onSelect(chat.id)} title={chat.title}>
        {withIcon && <span className="session-icon"><Icon size={16} /></span>}<span>{chat.title}</span>
      </button>
      <button
        type="button"
        className={`chat-more ${menuOpen ? 'open' : ''}`}
        onClick={(event) => onOpenMenu(chat, event.currentTarget)}
        aria-label={`Options for ${chat.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        <MoreHorizontal size={16} />
      </button>
    </div>
  );
}

function groupByState(list, term) {
  const matches = term ? list.filter((item) => item.title.toLowerCase().includes(term)) : list;
  return {
    pinned: matches.filter((item) => item.is_pinned && !item.is_archived),
    recent: matches.filter((item) => !item.is_pinned && !item.is_archived),
    archived: matches.filter((item) => item.is_archived),
  };
}

export default function ChatSidebar({
  chats, loading, error, onRetry, activeId, isOpen, user, guest = false, onRequestAuth = () => {},
  onSignOut, onProfileChange, onNew, onSelect, onClose, onTogglePin, onToggleArchive, onDelete, onRenameChat = () => {},
  historyTab = 'translations', onHistoryTabChange = () => {},
  // Meeting Chats: same shape/behavior as chats (id/title/is_pinned/is_archived), just a separate list and a
  // separate set of callbacks - see App.jsx's meetingChats state and toggleMeetingChatPin/etc handlers.
  meetings = [], meetingsLoading = false, meetingsError = '', onRetryMeetings,
  activeMeetingChatId = null, onNewMeeting = () => {}, onSelectMeeting = () => {},
  onToggleMeetingPin = () => {}, onToggleMeetingArchive = () => {}, onDeleteMeeting = () => {}, onRenameMeeting = () => {},
}) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [meetingsArchivedOpen, setMeetingsArchivedOpen] = useState(false);
  const [menu, setMenu] = useState(null); // { kind: 'chat' | 'meeting', chatId, anchor }
  const [renameTarget, setRenameTarget] = useState(null); // { kind: 'chat' | 'meeting', chat }
  const searchInputRef = useRef(null);

  const term = query.trim().toLowerCase();
  const { pinned, recent, archived } = useMemo(() => groupByState(chats, term), [chats, term]);
  const { pinned: meetingsPinned, recent: meetingsRecent, archived: meetingsArchived } = useMemo(() => groupByState(meetings, term), [meetings, term]);

  const showArchived = archivedOpen || (term && archived.length > 0);
  const showMeetingsArchived = meetingsArchivedOpen || (term && meetingsArchived.length > 0);
  const meetingsNothingMatches = Boolean(term) && meetings.length > 0 && !meetingsPinned.length && !meetingsRecent.length && !meetingsArchived.length;
  const nothingMatches = !pinned.length && !recent.length && !archived.length;
  const menuChat = menu?.kind === 'chat' ? chats.find((chat) => chat.id === menu.chatId) : null;
  const menuMeeting = menu?.kind === 'meeting' ? meetings.find((chat) => chat.id === menu.chatId) : null;
  const closeMenu = useRef(() => setMenu(null)).current;
  const openMenu = (chat, anchor) => setMenu(menu?.kind === 'chat' && menu.chatId === chat.id ? null : { kind: 'chat', chatId: chat.id, anchor });
  const openMeetingMenu = (chat, anchor) => setMenu(menu?.kind === 'meeting' && menu.chatId === chat.id ? null : { kind: 'meeting', chatId: chat.id, anchor });

  const toggleSearch = () => { if (searchOpen) setQuery(''); setSearchOpen((open) => !open); };
  const renderItem = (chat, withIcon = false) => (
    <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} withIcon={withIcon} menuOpen={menu?.kind === 'chat' && menu.chatId === chat.id} onSelect={onSelect} onOpenMenu={openMenu} />
  );
  const renderMeetingItem = (chat) => (
    <ChatItem key={chat.id} chat={chat} active={chat.id === activeMeetingChatId} withIcon icon={Users} menuOpen={menu?.kind === 'meeting' && menu.chatId === chat.id} onSelect={onSelectMeeting} onOpenMenu={openMeetingMenu} />
  );

  // "New chat" is context-aware: on the Meetings tab it opens a brand-new Meeting Chat instead of forcing the
  // Translations tab and starting a translation chat.
  const handleNewChat = () => {
    if (historyTab === 'meetings') { onNewMeeting(); return; }
    onHistoryTabChange('translations');
    onNew();
  };

  return (
    <aside className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-header">
        <div className="brand"><BrandMark /><span>TranslyAi</span></div>
        <div className="sidebar-header-actions">
          <button type="button" className={`icon-button ${searchOpen ? 'active' : ''}`} onClick={toggleSearch} aria-label={historyTab === 'meetings' ? 'Search meetings' : 'Search chats'} aria-pressed={searchOpen}><Search size={18} /></button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close sidebar"><PanelLeftClose size={18} /></button>
        </div>
      </div>

      <button type="button" className="new-chat-button" onClick={handleNewChat}><SquarePen size={17} />New chat</button>

      <div className="history-tabs" role="tablist" aria-label="History type">
        <button type="button" role="tab" aria-selected={historyTab === 'translations'} className={`history-tab ${historyTab === 'translations' ? 'active' : ''}`} onClick={() => { setQuery(''); onHistoryTabChange('translations'); }}><MessageCircle size={14} />Translations</button>
        <button type="button" role="tab" aria-selected={historyTab === 'meetings'} className={`history-tab ${historyTab === 'meetings' ? 'active' : ''}`} onClick={() => { setQuery(''); onHistoryTabChange('meetings'); }}><Users size={14} />Meetings</button>
      </div>

      {searchOpen && (
        <div className="sidebar-search">
          <Search size={14} />
          <input
            ref={searchInputRef} type="text" value={query} autoFocus placeholder={historyTab === 'meetings' ? 'Search meetings' : 'Search chats'} aria-label={historyTab === 'meetings' ? 'Search meetings' : 'Search chats'}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') toggleSearch(); }}
          />
          {query && <button type="button" onClick={() => { setQuery(''); searchInputRef.current?.focus(); }} aria-label="Clear search"><X size={13} /></button>}
        </div>
      )}

      {historyTab === 'translations' ? (
        <nav className="session-list" aria-label="Chats">
          {error && <div className="sidebar-error" role="alert">{error}{onRetry && <button type="button" onClick={onRetry}>Retry</button>}</div>}
          {loading && !chats.length && <p className="empty-history sidebar-loading"><LoaderCircle size={14} className="spin" />Loading chats...</p>}

          {pinned.length > 0 && <div className="history-label">Pinned</div>}
          {pinned.map((chat) => renderItem(chat, true))}

          {recent.length > 0 && <div className="history-label">Recents</div>}
          {recent.map((chat) => renderItem(chat))}

          {!loading && !error && !chats.length && <p className="empty-history">{guest ? 'Chats are saved when you sign up.' : 'Your saved chats will appear here.'}</p>}
          {term && nothingMatches && <p className="empty-history">No chats match "{query.trim()}".</p>}

          {archived.length > 0 && (
            <>
              <button type="button" className="history-label archived-toggle" onClick={() => setArchivedOpen((open) => !open)} aria-expanded={Boolean(showArchived)}>
                {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}Archived ({archived.length})
              </button>
              {showArchived && archived.map((chat) => renderItem(chat))}
            </>
          )}
        </nav>
      ) : (
        <nav className="session-list" aria-label="Meetings">
          {meetingsError && <div className="sidebar-error" role="alert">{meetingsError}{onRetryMeetings && <button type="button" onClick={onRetryMeetings}>Retry</button>}</div>}
          {meetingsLoading && !meetings.length && <p className="empty-history sidebar-loading"><LoaderCircle size={14} className="spin" />Loading meetings...</p>}

          {meetingsPinned.length > 0 && <div className="history-label">Pinned</div>}
          {meetingsPinned.map(renderMeetingItem)}

          {meetingsRecent.length > 0 && <div className="history-label">Recents</div>}
          {meetingsRecent.map(renderMeetingItem)}

          {meetingsNothingMatches && <p className="empty-history">No meetings match "{query.trim()}".</p>}
          {!meetingsLoading && !meetingsError && !meetings.length && (
            <p className="empty-history">{guest ? 'Meetings are saved when you sign up.' : 'Your meeting chats will appear here.'}</p>
          )}

          {meetingsArchived.length > 0 && (
            <>
              <button type="button" className="history-label archived-toggle" onClick={() => setMeetingsArchivedOpen((open) => !open)} aria-expanded={Boolean(showMeetingsArchived)}>
                {showMeetingsArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}Archived ({meetingsArchived.length})
              </button>
              {showMeetingsArchived && meetingsArchived.map(renderMeetingItem)}
            </>
          )}
        </nav>
      )}

      {menu && menuChat && (
        <ChatMenu chat={menuChat} anchor={menu.anchor} onClose={closeMenu} onTogglePin={onTogglePin} onToggleArchive={onToggleArchive} onRename={(chat) => setRenameTarget({ kind: 'chat', chat })} onDelete={onDelete} />
      )}
      {menu && menuMeeting && (
        <ChatMenu chat={menuMeeting} anchor={menu.anchor} onClose={closeMenu} onTogglePin={onToggleMeetingPin} onToggleArchive={onToggleMeetingArchive} onRename={(chat) => setRenameTarget({ kind: 'meeting', chat })} onDelete={onDeleteMeeting} />
      )}
      {renameTarget && (
        <RenameModal
          chat={renameTarget.chat} onCancel={() => setRenameTarget(null)}
          onSave={(title) => { (renameTarget.kind === 'meeting' ? onRenameMeeting : onRenameChat)(renameTarget.chat, title); setRenameTarget(null); }}
        />
      )}

      {guest ? (
        <div className="guest-card">
          <p>Sign up to save your chats and pick up where you left off on any device.</p>
          <div><button type="button" className={`${CTA_LOGIN} flex-1`} onClick={() => onRequestAuth('login')}>Log in</button><button type="button" className={`${CTA_SIGNUP} flex-1`} onClick={() => onRequestAuth('signup')}>Sign up</button></div>
        </div>
      ) : <AccountMenu user={user} onSignOut={onSignOut} onProfileChange={onProfileChange} />}
    </aside>
  );
}
