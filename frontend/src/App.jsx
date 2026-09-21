import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import ChatSidebar from './ChatSidebar';
import VoiceBar from './VoiceBar';
import {
  ArrowUp, ChevronDown, Copy, Languages, LoaderCircle,
  Menu, Mic, PanelLeftOpen, Paperclip, Sparkles, Volume2, X,
} from 'lucide-react';
import { API_BASE_URL } from './lib/config';
import {
  createChat, deleteChat, fetchMessages, generateTitle, listChats, saveMessages, setArchived, setPinned,
  sortChats, toApiMessage, toUiMessage,
} from './lib/chatApi';

const AUDIO_TIMEOUT_MS = 60000;
const COLLAPSE_KEY = 'linguaai-sidebar-collapsed';
const TIMEOUT_MESSAGE = 'Connection timed out. Please try again';
const languages = [
  ['auto', 'Auto-detect'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'],
  ['ur', 'Urdu'], ['en', 'English'],
];

function App({ user, onSignOut, onProfileChange }) {
  const [chats, setChats] = useState([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState('');
  const [activeId, setActiveIdState] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState('');
  const [text, setText] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [isLoading, setIsLoading] = useState(false);
  const [pending, setPending] = useState(null); // { chatId } while an answer is awaited
  const [isSaving, setIsSaving] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStream, setRecordingStream] = useState(null);
  const [health, setHealth] = useState('checking');
  const [error, setError] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const activeIdRef = useRef(null);
  const chatsRef = useRef([]);
  chatsRef.current = chats;
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingCancelledRef = useRef(false);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const conversationRef = useRef(null);
  const activeChat = chats.find((chat) => chat.id === activeId) || null;
  const busy = isLoading || isSaving;

  const updateCollapsed = (collapsed) => {
    setSidebarCollapsed(collapsed);
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* remembering the choice is optional */ }
  };
  // On phones the sidebar is a slide-over; on larger screens the close icon collapses it.
  const closeSidebar = () => {
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false);
    else updateCollapsed(true);
  };

  const setActive = (id) => { activeIdRef.current = id; setActiveIdState(id); };
  const patchChat = (id, changes) => setChats((current) => sortChats(current.map((chat) => (chat.id === id ? { ...chat, ...changes } : chat))));

  const refreshChats = useCallback(async () => {
    setChatsLoading(true); setChatsError('');
    try { setChats(sortChats(await listChats())); }
    catch (loadError) { setChatsError(`Couldn't load your chats. ${loadError.message}`); }
    finally { setChatsLoading(false); }
  }, []);

  useEffect(() => { refreshChats(); }, [refreshChats]);

  useEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
  }, [text]);

  useEffect(() => {
    if (conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [messages, messagesLoading, pending]);

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

  const loadMessages = async (chatId) => {
    setMessagesLoading(true); setMessagesError('');
    try {
      const rows = await fetchMessages(chatId);
      if (activeIdRef.current === chatId) setMessages(rows.map(toUiMessage));
      // A chat that never got its title (for example the connection dropped) is named when it is opened.
      if (/^(new chat|new conversation|untitled)?$/i.test((chatsRef.current.find((chat) => chat.id === chatId)?.title || 'x').trim())) {
        const firstUser = rows.find((row) => row.role === 'user');
        requestTitle(chatId, firstUser?.content || rows.find((row) => row.role === 'assistant')?.content || '');
      }
    } catch (loadError) {
      if (activeIdRef.current === chatId) setMessagesError(loadError.message);
    } finally {
      if (activeIdRef.current === chatId) setMessagesLoading(false);
    }
  };

  const startNewChat = () => {
    setActive(null); setMessages([]); setMessagesLoading(false); setMessagesError('');
    setText(''); setAudioFile(null); setError(''); setSidebarOpen(false);
    textareaRef.current?.focus();
  };

  const selectChat = (chatId) => {
    setSidebarOpen(false);
    if (chatId === activeIdRef.current) return;
    setActive(chatId); setMessages([]); setText(''); setAudioFile(null); setError('');
    loadMessages(chatId);
  };

  const togglePin = async (chat) => {
    const next = !chat.is_pinned;
    setError(''); patchChat(chat.id, { is_pinned: next });
    try { patchChat(chat.id, await setPinned(chat.id, next)); }
    catch (actionError) { patchChat(chat.id, { is_pinned: chat.is_pinned }); setError(`Couldn't ${next ? 'pin' : 'unpin'} the chat. ${actionError.message}`); }
  };

  const toggleArchive = async (chat) => {
    const next = !chat.is_archived;
    setError(''); patchChat(chat.id, { is_archived: next, is_pinned: next ? false : chat.is_pinned });
    try { patchChat(chat.id, await setArchived(chat.id, next)); }
    catch (actionError) {
      patchChat(chat.id, { is_archived: chat.is_archived, is_pinned: chat.is_pinned });
      setError(`Couldn't ${next ? 'archive' : 'unarchive'} the chat. ${actionError.message}`);
    }
  };

  const removeChat = async (chat) => {
    setError('');
    setChats((current) => current.filter((item) => item.id !== chat.id));
    if (activeIdRef.current === chat.id) startNewChat();
    try { await deleteChat(chat.id); }
    catch (actionError) { setError(`Couldn't delete the chat. ${actionError.message}`); refreshChats(); }
  };

  // Asks the backend for a short AI title. It runs on its own, so a failed save never blocks it.
  const requestTitle = (chatId, source) => {
    if (!source) return;
    generateTitle(chatId, source)
      .then((titled) => patchChat(chatId, { title: titled.title }))
      .catch((titleError) => console.warn('Title generation skipped:', titleError.message));
  };

  // Puts the user's message on screen before the backend answers and starts the "thinking" indicator.
  const showUserMessage = (targetChatId, userMessage) => {
    if (activeIdRef.current === targetChatId) setMessages((current) => [...current, userMessage]);
    setPending({ chatId: targetChatId });
  };
  // If the request fails, the optimistic message is taken back so the chat only holds exchanges that were answered.
  const failUserMessage = (userMessage) => {
    setPending(null);
    setMessages((current) => current.filter((item) => item.id !== userMessage.id));
  };

  // Shows the assistant's answer, then saves the exchange (creating the chat first if this is a brand new conversation).
  const appendConversation = async (targetChatId, userMessage, result) => {
    const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', result, createdAt: Date.now() };
    // The user's message is normally already on screen; only add it if the view was reloaded meanwhile.
    if (activeIdRef.current === targetChatId) {
      setMessages((current) => [...(current.some((item) => item.id === userMessage.id) ? current : [...current, userMessage]), assistantMessage]);
    }

    setIsSaving(true);
    try {
      let chatId = targetChatId;
      const isNewChat = !chatId;
      const usableTranslation = result.english_translation && !/temporarily unavailable/i.test(result.english_translation) ? result.english_translation : '';
      // The title is written from what the user said; the English translation is only a fallback.
      const userText = userMessage.content || result.original_text || '';
      if (isNewChat) {
        const chat = await createChat();
        chatId = chat.id;
        setChats((current) => sortChats([{ ...chat, title: makeTitle(userText || usableTranslation || userMessage.audioName) }, ...current]));
        if (activeIdRef.current === null) setActive(chatId);
        requestTitle(chatId, userText || usableTranslation || userMessage.audioName || '');
      }
      await saveMessages(chatId, [toApiMessage(userMessage), toApiMessage(assistantMessage)]);
      patchChat(chatId, { updated_at: new Date().toISOString() });
    } catch (saveError) {
      setError(`This reply couldn't be saved to your chat history. ${saveError.message}`);
    } finally { setIsSaving(false); }
  };

  const submitText = async (event) => {
    event?.preventDefault();
    if (busy) return;
    if (audioFile) { submitAudio(audioFile); return; }
    if (!text.trim()) { setError('Write a message or attach an audio clip to begin.'); return; }
    const targetChatId = activeIdRef.current;
    const input = text.trim();
    const payload = { text: input, source_lang: 'auto' };
    const userMessage = { id: crypto.randomUUID(), role: 'user', content: input, createdAt: Date.now() };
    // Optimistic flow: clear the box, show the message and the thinking indicator now, then wait for the backend.
    setText(''); setError(''); setIsLoading(true);
    showUserMessage(targetChatId, userMessage);
    try {
      const response = await fetch(`${API_BASE_URL}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
      const data = await response.json();
      setPending(null); setIsLoading(false);
      await appendConversation(targetChatId, userMessage, data);
    } catch (err) {
      console.error('API Call Failed Details:', err);
      failUserMessage(userMessage);
      setText((current) => current || input);
      setError(isNetworkOrTimeoutError(err) ? TIMEOUT_MESSAGE : `Translation failed: ${err.message}`);
    } finally { setIsLoading(false); }
  };

  const submitAudio = async (file) => {
    if (!file || busy) return;
    const targetChatId = activeIdRef.current;
    const userMessage = { id: crypto.randomUUID(), role: 'user', content: '', audioName: file.name, createdAt: Date.now() };
    setAudioFile(null); setError(''); setIsLoading(true);
    showUserMessage(targetChatId, userMessage);
    const formData = new FormData(); formData.append('file', file);
    if (sourceLanguage !== 'auto') formData.append('source_language', sourceLanguage);
    try {
      const response = await axios.post(`${API_BASE_URL}/api/audio`, formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: AUDIO_TIMEOUT_MS });
      setPending(null); setIsLoading(false);
      await appendConversation(targetChatId, userMessage, response.data);
    } catch (requestError) {
      failUserMessage(userMessage);
      setAudioFile(file); // kept as an attachment so pressing Send retries it
      setError(isNetworkOrTimeoutError(requestError) ? TIMEOUT_MESSAGE : requestError.response?.data?.detail || 'Audio processing failed.');
    } finally { setIsLoading(false); }
  };

  // The recorder's onstop runs later, so it calls the latest submitAudio through a ref.
  const submitAudioRef = useRef(submitAudio);
  submitAudioRef.current = submitAudio;

  const startRecording = async () => {
    if (isRecording || busy) return;
    if (!navigator.mediaDevices?.getUserMedia) { setError('Microphone recording is not supported in this browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      });
      const recorder = new MediaRecorder(stream); audioChunksRef.current = []; mediaRecorderRef.current = recorder;
      recordingCancelledRef.current = false;
      recorder.ondataavailable = (event) => { if (event.data.size) audioChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        setRecordingStream(null); setIsRecording(false);
        if (recordingCancelledRef.current) { audioChunksRef.current = []; return; }
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];
        if (!blob.size) { setError('No audio was captured. Please try again.'); return; }
        submitAudioRef.current(new File([blob], 'recording.webm', { type: 'audio/webm' }));
      };
      recorder.start(); setRecordingStream(stream); setIsRecording(true); setError('');
    } catch { setError('Microphone access was not granted.'); }
  };

  // Confirm sends the clip; cancel throws it away. Both release the microphone through the recorder's onstop.
  const finishRecording = (send) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recordingCancelledRef.current = !send;
    recorder.stop();
  };

  useEffect(() => () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') { recordingCancelledRef.current = true; recorder.stop(); }
  }, []);

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <ChatSidebar
        chats={chats} loading={chatsLoading} error={chatsError} onRetry={refreshChats}
        activeId={activeId} health={health} isOpen={sidebarOpen} user={user}
        onSignOut={onSignOut} onProfileChange={onProfileChange}
        onNew={startNewChat} onSelect={selectChat} onClose={closeSidebar}
        onTogglePin={togglePin} onToggleArchive={toggleArchive} onDelete={removeChat}
      />
      <main className="chat-layout">
        <header className="topbar">
          <button type="button" className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={19} /></button>
          <button type="button" className="icon-button expand-sidebar" onClick={() => updateCollapsed(false)} aria-label="Open sidebar"><PanelLeftOpen size={19} /></button>
          <div className="mobile-title"><Sparkles size={16} /><span>{activeChat?.title || 'New chat'}</span></div>
        </header>
        <section className="conversation" aria-live="polite" ref={conversationRef}>
          {messagesLoading
            ? <div className="conversation-status"><LoaderCircle size={18} className="spin" />Loading conversation...</div>
            : messagesError
              ? <div className="conversation-status conversation-error">{messagesError}<button type="button" onClick={() => loadMessages(activeId)}>Try again</button></div>
              : messages.length
                ? messages.map((message) => <Message key={message.id} message={message} />)
                : <EmptyState onPrompt={(prompt) => setText(prompt)} />}
          {pending && pending.chatId === activeId && <Thinking />}
        </section>
        <div className="composer-wrap">
          {isRecording && <VoiceBar stream={recordingStream} onCancel={() => finishRecording(false)} onConfirm={() => finishRecording(true)} />}
          <form className="composer" onSubmit={submitText} hidden={isRecording}>
            {audioFile && <div className="attachment-chip"><Paperclip size={13} />{shortenFileName(audioFile.name)}<button type="button" onClick={() => setAudioFile(null)} aria-label="Remove attachment"><X size={13} /></button></div>}
            <textarea
              ref={textareaRef} value={text} rows={1} placeholder="Message LinguaAI..." aria-label="Message"
              onChange={(event) => { setText(event.target.value); resizeTextarea(event.target); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitText(event); } }}
            />
            <div className="composer-controls">
              <div className="composer-tools">
                <input ref={fileInputRef} type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) { setAudioFile(file); setError(''); } event.target.value = ''; }} hidden />
                <button type="button" className="tool-button" onClick={() => fileInputRef.current?.click()} aria-label="Attach audio"><Paperclip size={18} /></button>
                <button type="button" className="tool-button" onClick={startRecording} aria-label="Record audio"><Mic size={18} /></button>
                <label className="language-select"><Languages size={14} /><select value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)} aria-label="Source language">{languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={13} /></label>
              </div>
              <button type="submit" className="send-button" disabled={busy || (!text.trim() && !audioFile)} aria-label="Send message">{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}</button>
            </div>
          </form>
          {error && <div className="error-line"><X size={14} />{error}</div>}
          <p className="composer-note">LinguaAI can make mistakes. Check important translations.</p>
        </div>
      </main>
    </div>
  );
}

function Message({ message }) {
  if (message.role === 'user') return <div className="message-row user-row"><div className="user-bubble">{message.audioName && <span className="audio-badge"><Paperclip size={13} />{shortenFileName(message.audioName)}</span>}{!message.audioName && message.content}</div></div>;
  const { result } = message;
  if (!result) return null;
  return <div className="message-row assistant-row"><div className="avatar assistant-avatar"><Sparkles size={15} /></div><div className="assistant-content"><div className="assistant-label">LinguaAI</div><div className="translation-card"><div className="result-heading"><span>English translation</span><button type="button" className="mini-action" aria-label="Copy translation" onClick={() => navigator.clipboard?.writeText(result.english_translation)}><Copy size={14} /></button></div>{paragraphs(result.english_translation).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div><div className="summary-card"><div className="summary-heading"><Sparkles size={14} />Claude summary</div><SummaryText text={result.summary} /></div><div className="message-actions"><button type="button" aria-label="Read translation aloud"><Volume2 size={14} /></button><button type="button" aria-label="Copy response" onClick={() => navigator.clipboard?.writeText(`${result.english_translation}\n\n${result.summary.replace(/\*\*/g, '')}`)}><Copy size={14} /></button></div></div></div>;
}

const paragraphs = (text) => String(text || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);

// Renders **bold** lead-ins as <strong>; everything else stays plain text.
function withBold(line) {
  return line.split(/(\*\*[^*]+\*\*)/g).map((part, index) => (part.startsWith('**') && part.endsWith('**') && part.length > 4
    ? <strong key={index}>{part.slice(2, -2)}</strong>
    : part));
}

// Summaries arrive as "• **Topic:** detail" lines. Older saved chats hold plain sentences, which stay as a paragraph.
function SummaryText({ text }) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => line.startsWith('• '));
  if (!bullets.length) return <p>{withBold(lines.join(' '))}</p>;
  const intro = lines.filter((line) => !line.startsWith('• '));
  return <>{intro.length > 0 && <p>{withBold(intro.join(' '))}</p>}<ul className="summary-points">{bullets.map((line, index) => <li key={index}>{withBold(line.slice(2))}</li>)}</ul></>;
}

function Thinking() {
  return <div className="message-row assistant-row thinking-row" role="status"><div className="avatar assistant-avatar"><Sparkles size={15} /></div><div className="typing-dots" aria-label="LinguaAI is responding"><span /><span /><span /></div></div>;
}

function EmptyState({ onPrompt }) {
  return <div className="empty-state"><div className="empty-icon"><Languages size={24} /></div><h1>Where should we start?</h1><p>Translate text or voice into clear English, then get a concise summary.</p><div className="prompt-suggestions">{['Translate a meeting note', 'Summarize my voice memo', 'Help me understand this'].map((prompt) => <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>{prompt}<ArrowUp size={14} /></button>)}</div></div>;
}

function isNetworkOrTimeoutError(err) {
  if (err instanceof TypeError) return true; // fetch rejects with TypeError on network failure
  return ['ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK'].includes(err?.code) || Boolean(err?.request && !err?.response);
}
function shortenFileName(name, max = 22) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return `${name.slice(0, max - ext.length - 3).trimEnd()}...${ext}`;
}
// Provisional sidebar title (plain words only) shown until the AI title arrives.
function makeTitle(text) {
  const words = (text || '').replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').split(/\s+/).map((word) => word.replace(/^[-'’]+|[-'’]+$/g, '')).filter(Boolean);
  return words.slice(0, 5).join(' ') || 'New chat';
}
function resizeTextarea(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`; textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden'; }

export default App;
