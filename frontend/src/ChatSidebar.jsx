import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive, ArchiveRestore, ChevronDown, ChevronRight, LoaderCircle, MessageCircle, MoreHorizontal,
  PanelLeftClose, Pin, PinOff, Search, Sparkles, SquarePen, Trash2, X,
} from 'lucide-react';
import AccountMenu from './AccountMenu';

const MENU_WIDTH = 190;

function ChatMenu({ chat, anchor, onClose, onTogglePin, onToggleArchive, onDelete }) {
  const [confirming, setConfirming] = useState(false);
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
  const style = {
    width: MENU_WIDTH,
    left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
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
        onClick={() => { if (confirming) { onDelete(chat); onClose(); } else setConfirming(true); }}
      >
        <Trash2 size={15} />{confirming ? 'Click again to delete' : 'Delete'}
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

export default function ChatSidebar({
  chats, loading, error, onRetry, activeId, health, isOpen, user,
  onSignOut, onProfileChange, onNew, onSelect, onClose, onTogglePin, onToggleArchive, onDelete,
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
        <div className="brand"><div className="brand-mark"><Sparkles size={16} /></div><span>LinguaAI</span></div>
        <div className="sidebar-header-actions">
          <button type="button" className={`icon-button ${searchOpen ? 'active' : ''}`} onClick={toggleSearch} aria-label="Search chats" aria-pressed={searchOpen}><Search size={18} /></button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close sidebar"><PanelLeftClose size={18} /></button>
        </div>
      </div>

      <button type="button" className="new-chat-button" onClick={onNew}><SquarePen size={17} />New chat</button>

      {searchOpen && (
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

      <nav className="session-list" aria-label="Chats">
        {error && <div className="sidebar-error" role="alert">{error}{onRetry && <button type="button" onClick={onRetry}>Retry</button>}</div>}
        {loading && !chats.length && <p className="empty-history sidebar-loading"><LoaderCircle size={14} className="spin" />Loading chats...</p>}

        {pinned.length > 0 && <div className="history-label">Pinned</div>}
        {pinned.map((chat) => renderItem(chat, true))}

        {recent.length > 0 && <div className="history-label">Recents</div>}
        {recent.map((chat) => renderItem(chat))}

        {!loading && !error && !chats.length && <p className="empty-history">Your saved chats will appear here.</p>}
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

      {menu && menuChat && (
        <ChatMenu chat={menuChat} anchor={menu.anchor} onClose={closeMenu} onTogglePin={onTogglePin} onToggleArchive={onToggleArchive} onDelete={onDelete} />
      )}

      <AccountMenu user={user} onSignOut={onSignOut} onProfileChange={onProfileChange} />
      <div className="sidebar-footer">
        <div className={`status-dot ${health}`} />
        <span>{health === 'connected' ? 'Backend connected' : health === 'checking' ? 'Checking connection' : 'Backend offline'}</span>
      </div>
    </aside>
  );
}
