import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Archive, ArrowUp, CircleStop, ChevronDown, Copy, Languages, LoaderCircle,
  Menu, Mic, Paperclip, Plus, Search, Sparkles, Trash2, Volume2, X,
} from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://virtual-ai-translator.onrender.com';
const STORAGE_KEY = 'aura-translate-sessions';
const AUDIO_TIMEOUT_MS = 60000;
const TIMEOUT_MESSAGE = 'Connection timed out. Please try again';
const languages = [
  ['auto', 'Auto-detect'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'],
  ['ur', 'Urdu'], ['en', 'English'],
];

const makeSession = () => ({ id: crypto.randomUUID(), title: 'New conversation', createdAt: Date.now(), messages: [] });

function App() {
  const [sessions, setSessions] = useState(() => loadSessions());
  const [activeId, setActiveId] = useState(() => loadSessions()[0]?.id || null);
  const [text, setText] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [health, setHealth] = useState('checking');
  const [error, setError] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const activeSession = sessions.find((session) => session.id === activeId) || null;

  useEffect(() => {
    if (sessions.length && !sessions.some((session) => session.id === activeId)) setActiveId(sessions[0].id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions, activeId]);

  useEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
  }, [text]);

  useEffect(() => {
    let mounted = true;
    if (isLoading) return () => { mounted = false; };
    const checkHealth = async () => {
      try { await axios.get(`${API_BASE_URL}/health`, { timeout: 4000 }); if (mounted) setHealth('connected'); }
      catch { }
    };
    checkHealth();
    const interval = window.setInterval(checkHealth, 30000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, [isLoading]);

  const createNewChat = () => {
    const session = makeSession();
    setSessions((current) => [session, ...current]); setActiveId(session.id);
    setText(''); setAudioFile(null); setError(''); setSidebarOpen(false);
  };

  const deleteSession = (sessionId) => {
    const remaining = sessions.filter((session) => session.id !== sessionId);
    setSessions(remaining);
    if (sessionId === activeId) { setActiveId(remaining[0]?.id || null); setText(''); setAudioFile(null); setError(''); }
  };

  const ensureActiveSession = () => {
    if (activeId) return activeId;
    const session = makeSession();
    setSessions((current) => [session, ...current]); setActiveId(session.id);
    return session.id;
  };

  const appendConversation = (userMessage, result, sessionId = activeId) => {
    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) return session;
      const title = session.messages.length === 0 ? makeTitle(userMessage.content || userMessage.audioName || '') : session.title;
      return { ...session, title, messages: [...session.messages, userMessage, { id: crypto.randomUUID(), role: 'assistant', result, createdAt: Date.now() }] };
    }));
  };

  const submitText = async (event) => {
    event?.preventDefault();
    if (audioFile) { submitAudio(audioFile); return; }
    if (!text.trim()) { setError('Write a message or attach an audio clip to begin.'); return; }
    const sessionId = ensureActiveSession();
    const input = text.trim();
    const payload = { text: input, source_lang: 'auto' };
    setIsLoading(true); setError('');
    try {
      console.log('Sending translate request with payload:', payload);
      const response = await fetch(`${API_BASE_URL}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
      const data = await response.json();
      appendConversation({ id: crypto.randomUUID(), role: 'user', content: input, createdAt: Date.now() }, data, sessionId);
      setText('');
    } catch (err) {
      console.error('API Call Failed Details:', err);
      setError(isNetworkOrTimeoutError(err) ? TIMEOUT_MESSAGE : `Translation failed: ${err.message}`);
    }
    finally { setIsLoading(false); }
  };

  const submitAudio = async (file) => {
    if (!file) return;
    const sessionId = ensureActiveSession();
    setIsLoading(true); setError('');
    const formData = new FormData(); formData.append('file', file);
    if (sourceLanguage !== 'auto') formData.append('source_language', sourceLanguage);
    try {
      const response = await axios.post(`${API_BASE_URL}/api/audio`, formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: AUDIO_TIMEOUT_MS });
      const transcript = (response.data.original_text || '').trim();
      appendConversation({ id: crypto.randomUUID(), role: 'user', content: hasNonLatinScript(transcript) ? '' : transcript, audioName: file.name, createdAt: Date.now() }, response.data, sessionId);
      setAudioFile(null);
    } catch (requestError) { setError(isNetworkOrTimeoutError(requestError) ? TIMEOUT_MESSAGE : requestError.response?.data?.detail || 'Audio processing failed.'); }
    finally { setIsLoading(false); }
  };

  const handleRecording = async () => {
    if (isRecording) { mediaRecorderRef.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setError('Microphone recording is not supported in this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream); audioChunksRef.current = []; mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => audioChunksRef.current.push(event.data);
      recorder.onstop = () => { stream.getTracks().forEach((track) => track.stop()); submitAudio(new File([new Blob(audioChunksRef.current, { type: 'audio/webm' })], 'recording.webm', { type: 'audio/webm' })); setIsRecording(false); };
      recorder.start(); setIsRecording(true); setError('');
    } catch { setError('Microphone access was not granted.'); }
  };

  return (
    <div className="app-shell">
      <Sidebar sessions={sessions} activeId={activeId} health={health} isOpen={sidebarOpen} onNew={createNewChat} onSelect={(id) => { setActiveId(id); setSidebarOpen(false); }} onDelete={deleteSession} />
      <main className="chat-layout">
        <header className="topbar"><button type="button" className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={19} /></button><div className="mobile-title"><Sparkles size={16} /><span>{activeSession?.title || 'New conversation'}</span></div><div className="topbar-actions"><button type="button" className="icon-button" aria-label="Search conversations"><Search size={17} /></button><button type="button" className="icon-button" aria-label="Conversation options"><Archive size={17} /></button></div></header>
        <section className="conversation" aria-live="polite">
          {activeSession?.messages.length ? activeSession.messages.map((message) => <Message key={message.id} message={message} />) : <EmptyState onPrompt={(prompt) => setText(prompt)} />}
          {isLoading && <div className="message-row assistant-row"><div className="avatar assistant-avatar"><Sparkles size={15} /></div><div className="typing"><span /><span /><span /></div></div>}
        </section>
        <div className="composer-wrap"><form className="composer" onSubmit={submitText}>{audioFile && <div className="attachment-chip"><Paperclip size={13} />{shortenFileName(audioFile.name)}<button type="button" onClick={() => setAudioFile(null)} aria-label="Remove attachment"><X size={13} /></button></div>}<textarea ref={textareaRef} value={text} onChange={(event) => { setText(event.target.value); resizeTextarea(event.target); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitText(event); } }} rows={1} placeholder="Message Aura Translate..." aria-label="Message" /><div className="composer-controls"><div className="composer-tools"><input ref={fileInputRef} type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) { setAudioFile(file); setError(''); } event.target.value = ''; }} hidden /><button type="button" className="tool-button" onClick={() => fileInputRef.current?.click()} aria-label="Attach audio"><Paperclip size={18} /></button><button type="button" className={`tool-button ${isRecording ? 'recording' : ''}`} onClick={handleRecording} aria-label={isRecording ? 'Stop recording' : 'Record audio'}>{isRecording ? <CircleStop size={18} /> : <Mic size={18} />}</button><label className="language-select"><Languages size={14} /><select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)} aria-label="Source language">{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={13} /></label></div><button type="submit" className="send-button" disabled={isLoading || (!text.trim() && !audioFile)} aria-label="Send message">{isLoading ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}</button></div></form>{error && <div className="error-line"><X size={14} />{error}</div>}<p className="composer-note">Aura can make mistakes. Check important translations.</p></div>
      </main>
    </div>
  );
}

function Sidebar({ sessions, activeId, health, isOpen, onNew, onSelect, onDelete }) {
  return <aside className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}><div className="sidebar-header"><div className="brand"><div className="brand-mark"><Sparkles size={16} /></div><span>Aura Translate</span></div><button type="button" className="icon-button sidebar-close" onClick={() => onSelect(activeId)} aria-label="Close sidebar"><X size={18} /></button></div><button type="button" className="new-chat-button" onClick={onNew}><Plus size={17} />New chat</button><div className="history-label">Your conversations</div><nav className="session-list">{sessions.length ? sessions.map((session) => <div key={session.id} className={`session-item ${session.id === activeId ? 'active' : ''}`}><button type="button" className="session-select" onClick={() => onSelect(session.id)}><span className="session-icon"><Languages size={15} /></span><span>{session.title}</span></button><button type="button" className="delete-button" onClick={() => onDelete(session.id)} aria-label={`Delete ${session.title}`}><Trash2 size={14} /></button></div>) : <p className="empty-history">Your saved chats will appear here.</p>}</nav><div className="sidebar-footer"><div className={`status-dot ${health}`} /><span>{health === 'connected' ? 'Backend connected' : health === 'checking' ? 'Checking connection' : 'Backend offline'}</span></div></aside>;
}

function Message({ message }) {
  if (message.role === 'user') return <div className="message-row user-row"><div className="user-bubble">{message.audioName && <span className="audio-badge"><Paperclip size={13} />{shortenFileName(message.audioName)}</span>}{message.content}</div></div>;
  const { result } = message;
  return <div className="message-row assistant-row"><div className="avatar assistant-avatar"><Sparkles size={15} /></div><div className="assistant-content"><div className="assistant-label">Aura Translate <span>· just now</span></div><div className="translation-card"><div className="result-heading"><span>English translation</span><button type="button" className="mini-action" aria-label="Copy translation" onClick={() => navigator.clipboard?.writeText(result.english_translation)}><Copy size={14} /></button></div><p>{result.english_translation}</p></div><div className="summary-card"><div className="summary-heading"><Sparkles size={14} />Claude summary</div><p>{result.summary}</p></div><div className="message-actions"><button type="button" aria-label="Read translation aloud"><Volume2 size={14} /></button><button type="button" aria-label="Copy response" onClick={() => navigator.clipboard?.writeText(`${result.english_translation}\n\n${result.summary}`)}><Copy size={14} /></button></div></div></div>;
}

function EmptyState({ onPrompt }) {
  return <div className="empty-state"><div className="empty-icon"><Languages size={24} /></div><h1>Where should we start?</h1><p>Translate text or voice into clear English, then get a concise Claude summary.</p><div className="prompt-suggestions">{['Translate a meeting note', 'Summarize my voice memo', 'Help me understand this'].map((prompt) => <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>{prompt}<ArrowUp size={14} /></button>)}</div></div>;
}

function isNetworkOrTimeoutError(err) {
  if (err instanceof TypeError) return true; // fetch rejects with TypeError on network failure
  return ['ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK'].includes(err?.code) || Boolean(err?.request && !err?.response);
}
function hasNonLatinScript(text) { return /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text); }
function shortenFileName(name, max = 22) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return `${name.slice(0, max - ext.length - 3).trimEnd()}...${ext}`;
}
function makeTitle(text) { const words = text.trim().split(/\s+/).slice(0, 5).join(' '); return words.length < text.trim().length ? `${words}...` : words || 'New conversation'; }
function loadSessions() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function resizeTextarea(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`; textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden'; }

export default App;
