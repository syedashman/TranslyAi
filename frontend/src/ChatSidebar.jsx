import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive, ArchiveRestore, ChevronDown, ChevronRight, LoaderCircle, MessageCircle, MoreHorizontal,
  PanelLeftClose, Pin, PinOff, Search, SquarePen, Trash2, Users, X,
} from 'lucide-react';
import AccountMenu from './AccountMenu';
import BrandMark from './BrandMark';
import { CTA_LOGIN, CTA_SIGNUP } from './lib/authCta';
import { formatDurationShort } from './lib/duration';

const MENU_WIDTH = 190;

function ChatMenu({ chat, anchor, onClose, onTogglePin, onToggleArchive, onDelete }) {
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
  const estimatedHeight = chat.is_archived ? 92 : 132;
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
          {chat.is_pinned ? <PinOff size={15} /> : <Pin size={15} />}{chat.is_pinned ? 'Unpin' : 'Pin'}
        </button>
      )}
      <button type="button" role="menuitem" onClick={() => { onToggleArchive(chat); onClose(); }}>
        {chat.is_archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{chat.is_archived ? 'Unarchive' : 'Archive'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => { onDelete(chat); onClose(); }}
      >
        <Trash2 size={15} />Delete
      </button>
    </div>,
    document.body,
  );
}

function ChatItem({ chat, active, withIcon, menuOpen, onSelect, onOpenMenu }) {
  return (
    <div
      className={`session-item ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}
      onContextMenu={(event) => { event.preventDefault(); onOpenMenu(chat, event.currentTarget.querySelector('.chat-more')); }}
    >
      <button type="button" className="session-select" onClick={() => onSelect(chat.id)} title={chat.title}>
        {withIcon && <span className="session-icon"><MessageCircle size={16} /></span>}<span>{chat.title}</span>
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

// One saved meeting: date, duration, and a plain-text preview of its summary (bullets/markdown stripped) -
// visually distinct from ChatItem (a mic icon instead of the chat bubble icon, no pin/archive/delete menu) so it
// clearly reads as a meeting, not a translation chat.
function MeetingItem({ meeting, onSelect }) {
  const date = new Date(meeting.created_at);
  const dateLabel = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const preview = (meeting.summary || '').replace(/[•*]/g, '').replace(/\s+/g, ' ').trim();
  return (
    <button type="button" className="session-item meeting-item" onClick={() => onSelect(meeting.id)}>
      <span className="session-icon"><Users size={16} /></span>
      <span className="meeting-item-body">
        <span className="meeting-item-meta">
          {dateLabel}{meeting.duration_seconds != null && ` · ${formatDurationShort(meeting.duration_seconds)}`}
        </span>
        {preview && <span className="meeting-item-preview">"{preview.length > 90 ? `${preview.slice(0, 90).trimEnd()}...` : preview}"</span>}
      </span>
    </button>
  );
}

export default function ChatSidebar({
  chats, loading, error, onRetry, activeId, isOpen, user, guest = false, onRequestAuth = () => {},
  onSignOut, onProfileChange, onNew, onSelect, onClose, onTogglePin, onToggleArchive, onDelete,
  historyTab = 'translations', onHistoryTabChange = () => {}, meetings = [], meetingsLoading = false,
  meetingsError = '', onRetryMeetings, onSelectMeeting = () => {},
}) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const searchInputRef = useRef(null);

  const term = query.trim().toLowerCase();
  const { pinned, recent, archived } = useMemo(() => {
    const matches = term ? chats.filter((chat) => chat.title.toLowerCase().includes(term)) : chats;
    return {
      pinned: matches.filter((chat) => chat.is_pinned && !chat.is_archived),
      recent: matches.filter((chat) => !chat.is_pinned && !chat.is_archived),
      archived: matches.filter((chat) => chat.is_archived),
    };
  }, [chats, term]);

  const showArchived = archivedOpen || (term && archived.length > 0);
  const nothingMatches = !pinned.length && !recent.length && !archived.length;
  const menuChat = menu ? chats.find((chat) => chat.id === menu.chatId) : null;
  const closeMenu = useRef(() => setMenu(null)).current;
  const openMenu = (chat, anchor) => setMenu(menu?.chatId === chat.id ? null : { chatId: chat.id, anchor });

  const toggleSearch = () => { if (searchOpen) setQuery(''); setSearchOpen((open) => !open); };
  const renderItem = (chat, withIcon = false) => (
    <ChatItem key={chat.id} chat={chat} active={chat.id === activeId} withIcon={withIcon} menuOpen={menu?.chatId === chat.id} onSelect={onSelect} onOpenMenu={openMenu} />
  );

  return (
    <aside className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-header">
        <div className="brand"><BrandMark /><span>TranslyAi</span></div>
        <div className="sidebar-header-actions">
          {historyTab === 'translations' && (
            <button type="button" className={`icon-button ${searchOpen ? 'active' : ''}`} onClick={toggleSearch} aria-label="Search chats" aria-pressed={searchOpen}><Search size={18} /></button>
          )}
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close sidebar"><PanelLeftClose size={18} /></button>
        </div>
      </div>

      <button type="button" className="new-chat-button" onClick={() => { onHistoryTabChange('translations'); onNew(); }}><SquarePen size={17} />New chat</button>

      <div className="history-tabs" role="tablist" aria-label="History type">
        <button type="button" role="tab" aria-selected={historyTab === 'translations'} className={`history-tab ${historyTab === 'translations' ? 'active' : ''}`} onClick={() => onHistoryTabChange('translations')}>Translations</button>
        <button type="button" role="tab" aria-selected={historyTab === 'meetings'} className={`history-tab ${historyTab === 'meetings' ? 'active' : ''}`} onClick={() => onHistoryTabChange('meetings')}>Meetings</button>
      </div>

      {historyTab === 'translations' && searchOpen && (
        <div className="sidebar-search">
          <Search size={14} />
          <input
            ref={searchInputRef} type="text" value={query} autoFocus placeholder="Search chats" aria-label="Search chats"
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
          {meetings.map((meeting) => <MeetingItem key={meeting.id} meeting={meeting} onSelect={onSelectMeeting} />)}
          {!meetingsLoading && !meetingsError && !meetings.length && (
            <p className="empty-history">{guest ? 'Meetings are saved when you sign up.' : 'Meetings you record will appear here once processed.'}</p>
          )}
        </nav>
      )}

      {menu && menuChat && (
        <ChatMenu chat={menuChat} anchor={menu.anchor} onClose={closeMenu} onTogglePin={onTogglePin} onToggleArchive={onToggleArchive} onDelete={onDelete} />
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
