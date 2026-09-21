import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import ChatSidebar from './ChatSidebar';
import DeleteModal from './DeleteModal';
import ShareModal from './ShareModal';
import VoiceBar from './VoiceBar';
import {
  ArrowUp, CircleAlert, Copy, LoaderCircle,
  Menu, Mic, PanelLeftOpen, Paperclip, Pencil, Share, Sparkles, X,
} from 'lucide-react';
import { API_BASE_URL } from './lib/config';
import { describeError, isBusyResult, MESSAGES } from './lib/errors';
import { CTA_LOGIN, CTA_SIGNUP } from './lib/authCta';
import { copyText } from './lib/clipboard';
import { bumpGuestCount, getGuestCount, GUEST_LIMIT } from './lib/guest';
import {
  createChat, deleteChat, deleteMessages, fetchMessages, generateTitle, listChats, saveMessages, setArchived, setPinned,
  sortChats, toApiMessage, toUiMessage,
} from './lib/chatApi';

const AUDIO_TIMEOUT_MS = 60000;
const COLLAPSE_KEY = 'linguaai-sidebar-collapsed';
const CHAT_PARAM = 'chatId';
const CHAT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_VISIBLE_MS = 12000;

// The open chat lives in the address bar (?chatId=...) so a refresh or a shared link reopens it.
function readChatIdFromUrl() {
  try {
    const id = new URLSearchParams(window.location.search).get(CHAT_PARAM);
    return id && CHAT_ID_PATTERN.test(id) ? id : null;
  } catch { return null; }
}

// mode: 'push' adds a history entry, 'replace' rewrites the current one, 'none' leaves the address alone.
function writeChatIdToUrl(id, mode) {
  if (mode === 'none') return;
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(CHAT_PARAM, id); else url.searchParams.delete(CHAT_PARAM);
    if (url.href === window.location.href) return;
    window.history[mode === 'replace' ? 'replaceState' : 'pushState']({ chatId: id }, '', url);
  } catch { /* the address bar is a convenience; the app works without it */ }
}
// Each heading has a matching sub-tagline; one pair is chosen on load and on every new chat.
const GREETINGS = [
  { heading: 'Where should we start?', tagline: 'Translate text or voice into clear English, then get a concise summary.' },
  { heading: 'What would you like to translate today?', tagline: 'High-fidelity voice translation and instant AI summaries at your fingertips.' },
  { heading: 'Ready for your meeting notes?', tagline: 'Capture meeting audio and convert it to actionable summaries instantly.' },
  { heading: 'How can TranslyAi help you right now?', tagline: 'Translate text or voice into clear English, then get a concise summary.' },
];
const pickGreeting = (previous) => {
  const options = GREETINGS.filter((greeting) => greeting.heading !== previous?.heading);
  return options[Math.floor(Math.random() * options.length)];
};

function App({ user, guest = false, onRequestAuth = () => {}, onSignOut, onProfileChange }) {
  const [chats, setChats] = useState([]);
  const [initialChatId] = useState(() => (guest ? null : readChatIdFromUrl()));
  const [greeting, setGreeting] = useState(() => pickGreeting());
  const [guestCount, setGuestCount] = useState(getGuestCount);
  const [authPromptOpen, setAuthPromptOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // the chat waiting for delete confirmation
  const [shareOpen, setShareOpen] = useState(false);
  const [editingId, setEditingId] = useState(null); // the user message being edited
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef(null);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [chatsError, setChatsError] = useState('');
  const [activeId, setActiveIdState] = useState(initialChatId);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(Boolean(initialChatId));
  const [messagesError, setMessagesError] = useState('');
  const [text, setText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pending, setPending] = useState(null); // { chatId } while an answer is awaited
  const [isSaving, setIsSaving] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStream, setRecordingStream] = useState(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [textFromSpeech, setTextFromSpeech] = useState(false); // the input holds dictated text
  const [focusTick, setFocusTick] = useState(0);
  const [error, setError] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const activeIdRef = useRef(initialChatId);
  const chatsRef = useRef([]);
  chatsRef.current = chats;
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recordingCancelledRef = useRef(false);
  const transcribeAbortRef = useRef(null);
  const abortRef = useRef(null); // AbortController of the translation request that is in flight
  const inflightIdRef = useRef(null); // id of the optimistic message that request belongs to
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const conversationRef = useRef(null);
  const activeChat = chats.find((chat) => chat.id === activeId) || null;
  const busy = isLoading || isSaving;
  const limitReached = guest && guestCount >= GUEST_LIMIT;
  const freeLeft = Math.max(0, GUEST_LIMIT - guestCount);

  const updateCollapsed = (collapsed) => {
    setSidebarCollapsed(collapsed);
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* remembering the choice is optional */ }
  };
  // On phones the sidebar is a slide-over; on larger screens the close icon collapses it.
  const closeSidebar = () => {
    if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false);
    else updateCollapsed(true);
  };

  const setActive = (id, urlMode = 'push') => { activeIdRef.current = id; setActiveIdState(id); writeChatIdToUrl(id, urlMode); };
  const patchChat = (id, changes) => setChats((current) => sortChats(current.map((chat) => (chat.id === id ? { ...chat, ...changes } : chat))));

  const refreshChats = useCallback(async ({ validateActive = false } = {}) => {
    if (guest) { setChatsLoading(false); return; } // guests have no saved chats
    setChatsLoading(true); setChatsError('');
    try {
      const list = sortChats(await listChats());
      setChats(list);
      // A link to a chat that no longer exists (or isn't yours) falls back to a new chat instead of an empty screen.
      if (validateActive && activeIdRef.current && !list.some((chat) => chat.id === activeIdRef.current)) {
        activeIdRef.current = null; setActiveIdState(null); writeChatIdToUrl(null, 'replace');
        setMessages([]); setMessagesLoading(false); setMessagesError('');
        setError("We couldn't find that conversation, so a new chat was opened.");
      }
    }
    catch (loadError) { setChatsError(`Couldn't load your chats. ${loadError.message}`); }
    finally { setChatsLoading(false); }
  }, [guest]);

  // On first load (including a hard refresh) reopen the chat named in the address bar.
  useEffect(() => {
    refreshChats({ validateActive: true });
    if (initialChatId) loadMessages(initialChatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshChats]);

  // Back/forward buttons move between the chats that were opened.
  const popstateRef = useRef(() => {});
  popstateRef.current = () => {
    if (guest) return;
    const id = readChatIdFromUrl();
    if (id === activeIdRef.current) return;
    if (id) openChat(id, 'none'); else resetToNewChat('none');
  };
  useEffect(() => {
    const onPopState = () => popstateRef.current();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Error banners fade away on their own; the close button dismisses them sooner.
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(''), ERROR_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (textareaRef.current) resizeTextarea(textareaRef.current);
    if (!text) setTextFromSpeech(false);
  }, [text]);

  // After dictation the box takes focus, with the cursor at the end, so the text can be checked or edited.
  useEffect(() => {
    if (!focusTick) return;
    const box = textareaRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    resizeTextarea(box);
  }, [focusTick]);

  useEffect(() => {
    if (conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [messages, messagesLoading, pending]);

  // Nothing is shown for this: it only wakes the free-tier server so the first real request is not slow.
  useEffect(() => { axios.get(`${API_BASE_URL}/health`, { timeout: 60000 }).catch(() => {}); }, []);

  // Safety net: an API failure that no handler caught still reaches the user instead of failing silently.
  useEffect(() => {
    const isApiFailure = (reason) => Boolean(reason) && !axios.isCancel(reason) && (
      reason.isAxiosError || reason.response || reason.request
      || (reason instanceof TypeError && /fetch|network|load failed/i.test(reason.message)));
    const onRejection = (event) => {
      if (!isApiFailure(event.reason)) return;
      event.preventDefault();
      setError(describeError(event.reason));
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

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

  const resetToNewChat = (urlMode) => {
    setActive(null, urlMode); setMessages([]); setMessagesLoading(false); setMessagesError('');
    setText(''); setAudioFile(null); setError(''); setSidebarOpen(false); setEditingId(null); setShareOpen(false);
    setGreeting((previous) => pickGreeting(previous));
    textareaRef.current?.focus();
  };
  const startNewChat = () => resetToNewChat('push');

  const openChat = (chatId, urlMode) => {
    setSidebarOpen(false);
    if (chatId === activeIdRef.current) return;
    setActive(chatId, urlMode); setMessages([]); setText(''); setAudioFile(null); setError(''); setEditingId(null); setShareOpen(false);
    loadMessages(chatId);
  };
  const selectChat = (chatId) => openChat(chatId, 'push');

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
    if (activeIdRef.current === chat.id) resetToNewChat('replace');
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

  const showToast = (message) => {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 2200);
  };
  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);
  const copyWithToast = async (value, label = 'Copied to clipboard') => {
    if (await copyText(value)) showToast(label);
    else setError("Couldn't copy to the clipboard. Please copy it manually.");
  };

  // Guests get GUEST_LIMIT free messages; the sign-up prompt opens when they are used up.
  const blockedByGuestLimit = () => {
    if (!limitReached) return false;
    setAuthPromptOpen(true);
    return true;
  };
  const countGuestMessage = (result) => {
    if (!guest || isBusyResult(result?.english_translation)) return;
    const next = Math.max(bumpGuestCount(), guestCount + 1);
    setGuestCount(next);
    if (next >= GUEST_LIMIT) setAuthPromptOpen(true);
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

  // One AbortController per translation request; Stop (or an edit that replaces the request) aborts it.
  const beginRequest = (userMessage) => {
    const controller = new AbortController();
    abortRef.current = controller;
    inflightIdRef.current = userMessage.id;
    return controller;
  };
  const isCurrentRequest = (controller) => abortRef.current === controller;
  const endRequest = (controller) => {
    if (!isCurrentRequest(controller)) return; // a newer request took over, so its state is not ours to reset
    abortRef.current = null; inflightIdRef.current = null;
    setIsLoading(false);
  };
  const isAbortError = (error) => axios.isCancel(error) || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED';
  const stopGeneration = () => abortRef.current?.abort();
  useEffect(() => () => abortRef.current?.abort(), []);

  // Shows the assistant's answer, then saves the exchange (creating the chat first if this is a brand new conversation).
  const appendConversation = async (targetChatId, userMessage, result, replaceIds = []) => {
    const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', result, createdAt: Date.now(), local: true };
    // The user's message is normally already on screen; only add it if the view was reloaded meanwhile.
    if (activeIdRef.current === targetChatId) {
      setMessages((current) => [...(current.some((item) => item.id === userMessage.id) ? current : [...current, userMessage]), assistantMessage]);
    }

    if (guest) return; // guest chats live only on this screen
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
        if (activeIdRef.current === null) setActive(chatId, 'replace');
        requestTitle(chatId, userText || usableTranslation || userMessage.audioName || '');
      }
      // An edited prompt replaces the exchange it came from, so the old rows go before the new ones are stored.
      if (replaceIds.length) await deleteMessages(chatId, replaceIds);
      const saved = await saveMessages(chatId, [toApiMessage(userMessage), toApiMessage(assistantMessage)]);
      // Later edits need the stored ids, so the on-screen messages take them over.
      const savedUser = saved?.find((row) => row.role === 'user');
      const savedAssistant = saved?.find((row) => row.role === 'assistant');
      if (savedUser && savedAssistant) {
        setMessages((current) => current.map((item) => (item.id === userMessage.id ? { ...item, id: savedUser.id, local: false } : item.id === assistantMessage.id ? { ...item, id: savedAssistant.id, local: false } : item)));
      }
      patchChat(chatId, { updated_at: new Date().toISOString() });
    } catch (saveError) {
      setError(`${replaceIds.length ? "Your edit couldn't be saved to your chat history." : "This reply couldn't be saved to your chat history."} ${saveError.message}`);
    } finally { setIsSaving(false); }
  };

  const requestTranslation = async (payload, signal) => {
    const response = await fetch(`${API_BASE_URL}/api/translate`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, detail: body?.detail });
    }
    return response.json();
  };

  // Resubmits an edited prompt: it and everything after it are replaced by the new exchange (like ChatGPT).
  // Editing stays possible while an answer is loading: the request in flight is dropped in favour of the edit.
  const submitEdit = async (message, newText) => {
    const input = newText.trim();
    if (!input || blockedByGuestLimit()) return;
    if (isSaving) { showToast('Saving your last message, try again in a moment'); return; }
    const index = messages.findIndex((item) => item.id === message.id);
    if (index < 0) return;
    const droppedId = abortRef.current ? inflightIdRef.current : null;
    abortRef.current?.abort();
    const snapshot = messages.filter((item) => item.id !== droppedId);
    const replaceIds = messages.slice(index).filter((item) => !item.local && item.id !== droppedId).map((item) => item.id);
    const targetChatId = activeIdRef.current;
    const userMessage = { id: crypto.randomUUID(), role: 'user', content: input, createdAt: Date.now(), local: true };
    const controller = beginRequest(userMessage);
    setEditingId(null); setError(''); setIsLoading(true);
    setMessages([...messages.slice(0, index), userMessage]);
    setPending({ chatId: targetChatId });
    try {
      const data = await requestTranslation({ text: input, source_lang: 'auto', from_speech: false }, controller.signal);
      if (!isCurrentRequest(controller)) return;
      setPending(null); setIsLoading(false);
      if (isBusyResult(data.english_translation)) setError(MESSAGES.busy);
      countGuestMessage(data);
      await appendConversation(targetChatId, userMessage, data, guest ? [] : replaceIds);
    } catch (editError) {
      if (!isCurrentRequest(controller)) return;
      setPending(null);
      setMessages(snapshot); // nothing was answered, so the earlier conversation comes back
      if (!isAbortError(editError)) setError(describeError(editError, 'Translation failed. Please try again.'));
    } finally { endRequest(controller); }
  };

  const submitText = async (event) => {
    event?.preventDefault();
    if (busy || blockedByGuestLimit()) return;
    if (audioFile) { submitAudio(audioFile); return; }
    if (!text.trim()) { setError('Write a message or attach an audio clip to begin.'); return; }
    const targetChatId = activeIdRef.current;
    const input = text.trim();
    const fromSpeech = textFromSpeech;
    const payload = { text: input, source_lang: 'auto', from_speech: fromSpeech };
    const userMessage = { id: crypto.randomUUID(), role: 'user', content: input, createdAt: Date.now(), local: true };
    const controller = beginRequest(userMessage);
    // Optimistic flow: clear the box, show the message and the thinking indicator now, then wait for the backend.
    setText(''); setError(''); setIsLoading(true);
    showUserMessage(targetChatId, userMessage);
    try {
      const data = await requestTranslation(payload, controller.signal);
      if (!isCurrentRequest(controller)) return;
      setPending(null); setIsLoading(false);
      if (isBusyResult(data.english_translation)) setError(MESSAGES.busy);
      countGuestMessage(data);
      await appendConversation(targetChatId, userMessage, data);
    } catch (err) {
      if (!isCurrentRequest(controller)) return; // replaced by an edit
      failUserMessage(userMessage);
      setText((current) => current || input); // the text goes back into the box, whether it failed or was stopped
      if (fromSpeech) setTextFromSpeech(true);
      if (isAbortError(err)) setFocusTick((tick) => tick + 1); // back to the box so the text can be edited or re-sent
      else setError(describeError(err, 'Translation failed. Please try again.'));
    } finally { endRequest(controller); }
  };

  const submitAudio = async (file) => {
    if (!file || busy || blockedByGuestLimit()) return;
    const targetChatId = activeIdRef.current;
    const userMessage = { id: crypto.randomUUID(), role: 'user', content: '', audioName: file.name, createdAt: Date.now(), local: true };
    const controller = beginRequest(userMessage);
    setAudioFile(null); setError(''); setIsLoading(true);
    showUserMessage(targetChatId, userMessage);
    const formData = new FormData(); formData.append('file', file);
    try {
      const response = await axios.post(`${API_BASE_URL}/api/audio`, formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: AUDIO_TIMEOUT_MS, signal: controller.signal });
      if (!isCurrentRequest(controller)) return;
      setPending(null); setIsLoading(false);
      if (isBusyResult(response.data?.english_translation)) setError(MESSAGES.busy);
      countGuestMessage(response.data);
      await appendConversation(targetChatId, userMessage, response.data);
    } catch (requestError) {
      if (!isCurrentRequest(controller)) return;
      failUserMessage(userMessage);
      setAudioFile(file); // kept as an attachment so pressing Send retries it
      if (!isAbortError(requestError)) setError(describeError(requestError, 'Audio processing failed. Please try again.'));
    } finally { endRequest(controller); }
  };

  const startRecording = async () => {
    if (isRecording || busy || blockedByGuestLimit()) return;
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
        setRecordingStream(null);
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        audioChunksRef.current = [];
        if (recordingCancelledRef.current) { setIsRecording(false); return; }
        if (!blob.size) { setIsRecording(false); setError('No audio was captured. Please try again.'); return; }
        transcribeRecording(new File([blob], 'recording.webm', { type: 'audio/webm' }));
      };
      recorder.start(); setRecordingStream(stream); setIsRecording(true); setError('');
    } catch { setError('Microphone access was not granted.'); }
  };

  // Confirm turns the clip into text for review (nothing is sent to the chat); cancel throws it away.
  // Both release the microphone through the recorder's onstop.
  const transcribeRecording = async (file) => {
    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    setIsTranscribing(true); setError('');
    let cancelled = false;
    try {
      const formData = new FormData(); formData.append('file', file);
      const response = await axios.post(`${API_BASE_URL}/api/transcribe`, formData, { timeout: AUDIO_TIMEOUT_MS, signal: controller.signal });
      const transcript = String(response.data?.text || '').trim();
      if (transcript) {
        setText((current) => (current.trim() ? `${current.trim()} ${transcript}` : transcript));
        setTextFromSpeech(true);
        // The backend converts to Roman script; if that step was unavailable the user is told before sending.
        if (hasNonLatinScript(transcript)) setError('This transcript is not in Roman Urdu/English script. Please review it before sending.');
      } else setError("We couldn't hear any speech in that recording. Please try again.");
    } catch (transcribeError) {
      cancelled = axios.isCancel(transcribeError);
      if (!cancelled) {
        setAudioFile(file); // keep the clip so Send can still translate it directly
        setError(describeError(transcribeError, 'Transcription failed. Please try again.'));
      }
    } finally {
      transcribeAbortRef.current = null;
      setIsTranscribing(false); setIsRecording(false);
      if (!cancelled) setFocusTick((tick) => tick + 1);
    }
  };

  const cancelVoice = () => {
    if (transcribeAbortRef.current) transcribeAbortRef.current.abort();
    else finishRecording(false);
  };
  const confirmVoice = () => { if (!transcribeAbortRef.current) finishRecording(true); };

  const finishRecording = (send) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    recordingCancelledRef.current = !send;
    recorder.stop();
  };

  useEffect(() => () => {
    transcribeAbortRef.current?.abort();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') { recordingCancelledRef.current = true; recorder.stop(); }
  }, []);

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <ChatSidebar
        chats={chats} loading={chatsLoading} error={chatsError} onRetry={refreshChats}
        activeId={activeId} isOpen={sidebarOpen} user={user} guest={guest} onRequestAuth={onRequestAuth}
        onSignOut={onSignOut} onProfileChange={onProfileChange}
        onNew={startNewChat} onSelect={selectChat} onClose={closeSidebar}
        onTogglePin={togglePin} onToggleArchive={toggleArchive} onDelete={setDeleteTarget}
      />
      {/* Mobile only (hidden by CSS on larger screens): tapping the dimmed page closes the open sidebar. */}
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}
      <main className="chat-layout">
        <header className="topbar">
          <button type="button" className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={19} /></button>
          <button type="button" className="icon-button expand-sidebar" onClick={() => updateCollapsed(false)} aria-label="Open sidebar"><PanelLeftOpen size={19} /></button>
          {!guest && activeId && (
            <button type="button" className="topbar-share" onClick={() => setShareOpen(true)} aria-label="Share chat"><Share size={16} />Share</button>
          )}
          {!user && (
            <div className="topbar-auth absolute right-4 top-[15px] z-20 flex items-center gap-2 sm:top-3">
              <button type="button" className={CTA_LOGIN} onClick={() => onRequestAuth('login')}>Log in</button>
              <button type="button" className={CTA_SIGNUP} onClick={() => onRequestAuth('signup')}>Sign up</button>
            </div>
          )}
        </header>
        <section className="conversation" aria-live="polite" ref={conversationRef}>
          {messagesLoading
            ? <div className="conversation-status"><LoaderCircle size={18} className="spin" />Loading conversation...</div>
            : messagesError
              ? <div className="conversation-status conversation-error">{messagesError}<button type="button" onClick={() => loadMessages(activeId)}>Try again</button></div>
              : messages.length
                ? messages.map((message) => (
                  <Message
                    key={message.id} message={message} editing={editingId === message.id} canEdit={!isRecording}
                    onCopy={copyWithToast} onStartEdit={setEditingId} onCancelEdit={() => setEditingId(null)} onSubmitEdit={submitEdit}
                  />
                ))
                : <EmptyState greeting={greeting} onPrompt={(prompt) => setText(prompt)} />}
          {pending && pending.chatId === activeId && <Thinking />}
        </section>
        <div className="composer-wrap">
          {limitReached && (
            <div className="guest-banner" role="alert">
              <span>Sign up or Log in to continue chatting with TranslyAi</span>
              <div><button type="button" onClick={() => onRequestAuth('login')}>Log in</button><button type="button" className="primary" onClick={() => onRequestAuth('signup')}>Sign up</button></div>
            </div>
          )}
          {isRecording && <VoiceBar stream={recordingStream} transcribing={isTranscribing} onCancel={cancelVoice} onConfirm={confirmVoice} />}
          <form className="composer" onSubmit={submitText} hidden={isRecording}>
            {audioFile && <div className="attachment-chip"><Paperclip size={13} />{shortenFileName(audioFile.name)}<button type="button" onClick={() => setAudioFile(null)} aria-label="Remove attachment"><X size={13} /></button></div>}
            <textarea
              ref={textareaRef} value={text} rows={1} disabled={limitReached} placeholder={limitReached ? 'Sign up or log in to continue chatting' : 'Message TranslyAi...'} aria-label="Message"
              onChange={(event) => { setText(event.target.value); resizeTextarea(event.target); }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitText(event); } }}
            />
            <div className="composer-controls">
              <div className="composer-tools">
                <input ref={fileInputRef} type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) { setAudioFile(file); setError(''); } event.target.value = ''; }} hidden />
                <button type="button" className="tool-button" onClick={() => fileInputRef.current?.click()} disabled={limitReached} aria-label="Attach audio"><Paperclip size={18} /></button>
                <button type="button" className="tool-button" onClick={startRecording} disabled={limitReached} aria-label="Record audio"><Mic size={18} /></button>
              </div>
              {/* The keys make React swap the two buttons instead of reusing one node, otherwise the Stop click would also submit the form as the node turns into the Send button. */}
              {isLoading
                ? <button key="stop" type="button" className="stop-button" onClick={stopGeneration} aria-label="Stop generating" title="Stop generating"><span className="stop-square" /></button>
                : <button key="send" type="submit" className="send-button" disabled={busy || limitReached || (!text.trim() && !audioFile)} aria-label="Send message">{isSaving ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}</button>}
            </div>
          </form>
          {error && <div className="error-line error-toast" role="alert"><CircleAlert size={18} className="error-icon" /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss message"><X size={14} /></button></div>}
          <p className="composer-note">{guest && !limitReached ? `Guest mode: ${freeLeft} free ${freeLeft === 1 ? 'message' : 'messages'} left. ` : ''}TranslyAi can make mistakes. Check important translations.</p>
        </div>
      </main>
      {shareOpen && activeChat && <ShareModal chat={activeChat} messages={messages} onClose={() => setShareOpen(false)} onCopied={() => showToast('Link copied')} onError={() => setError("Couldn't copy the link. Please copy it from the address bar.")} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {deleteTarget && <DeleteModal chat={deleteTarget} onCancel={() => setDeleteTarget(null)} onConfirm={() => { const chat = deleteTarget; setDeleteTarget(null); removeChat(chat); }} />}
      {guest && authPromptOpen && <AuthPrompt limitReached={limitReached} onClose={() => setAuthPromptOpen(false)} onRequestAuth={onRequestAuth} />}
    </div>
  );
}

// Shown when a guest has used their free messages: a clear route to sign up or log in.
function AuthPrompt({ limitReached, onClose, onRequestAuth }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal auth-prompt" role="dialog" aria-modal="true" aria-labelledby="auth-prompt-title">
        <div className="auth-prompt-icon"><Sparkles size={22} /></div>
        <h2 id="auth-prompt-title">{limitReached ? "You've used your free messages" : 'Sign up to keep going'}</h2>
        <p>Sign up or Log in to continue chatting with TranslyAi. It only takes a moment, and your chats will be saved.</p>
        <div className="auth-prompt-actions">
          <button type="button" className="primary" onClick={() => onRequestAuth('signup')}>Sign up</button>
          <button type="button" onClick={() => onRequestAuth('login')}>Log in</button>
        </div>
        <button type="button" className="auth-prompt-close" onClick={onClose}>Maybe later</button>
      </div>
    </div>
  );
}

function EditBox({ initial, onCancel, onSubmit }) {
  const [value, setValue] = useState(initial);
  const boxRef = useRef(null);
  useEffect(() => {
    const box = boxRef.current;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);
  useEffect(() => { if (boxRef.current) resizeTextarea(boxRef.current); }, [value]);
  const send = () => { if (value.trim()) onSubmit(value); };
  return (
    <div className="edit-box">
      <textarea
        ref={boxRef} value={value} rows={1} aria-label="Edit your message"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
          else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
        }}
      />
      <div className="edit-actions">
        <button type="button" className="cancel" onClick={onCancel}>Cancel</button>
        <button type="button" className="send" onClick={send} disabled={!value.trim()}>Send</button>
      </div>
    </div>
  );
}

function Message({ message, editing, canEdit, onCopy, onStartEdit, onCancelEdit, onSubmitEdit }) {
  if (message.role === 'user') {
    return (
      <div className="message-row user-row">
        <div className={`user-message ${editing ? 'is-editing' : ''}`}>
          {editing
            ? <EditBox initial={message.content} onCancel={onCancelEdit} onSubmit={(value) => onSubmitEdit(message, value)} />
            : <div className="user-bubble">{message.audioName && !message.content && <span className="audio-badge"><Paperclip size={13} />{shortenFileName(message.audioName)}</span>}{message.content}</div>}
          {!editing && message.content && (
            <div className="user-actions">
              <button type="button" aria-label="Copy message" title="Copy" onClick={() => onCopy(message.content)}><Copy size={14} /></button>
              <button type="button" aria-label="Edit message" title="Edit" disabled={!canEdit} onClick={() => onStartEdit(message.id)}><Pencil size={14} /></button>
            </div>
          )}
        </div>
      </div>
    );
  }
  const { result } = message;
  if (!result) return null;
  return <div className="message-row assistant-row"><div className="avatar assistant-avatar"><Sparkles size={15} /></div><div className="assistant-content"><div className="assistant-label">TranslyAi</div><div className="translation-card"><div className="result-heading"><span>English translation</span><button type="button" className="mini-action" aria-label="Copy translation" onClick={() => onCopy(result.english_translation, 'Translation copied')}><Copy size={14} /></button></div>{paragraphs(result.english_translation).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div><div className="summary-card"><div className="summary-heading"><Sparkles size={14} />TranslyAi summary</div><SummaryText text={result.summary} /></div><div className="message-actions">{/* Text-to-speech is hidden for now: <button type="button" aria-label="Read translation aloud"><Volume2 size={14} /></button> */}<button type="button" aria-label="Copy response" onClick={() => onCopy(`${result.english_translation}\n\n${result.summary.replace(/\*\*/g, '')}`)}><Copy size={14} /></button></div></div></div>;
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
  return <div className="message-row assistant-row thinking-row" role="status"><div className="avatar assistant-avatar"><Sparkles size={15} /></div><div className="typing-dots" aria-label="TranslyAi is responding"><span /><span /><span /></div></div>;
}

function EmptyState({ greeting, onPrompt }) {
  return <div className="empty-state"><h1>{greeting.heading}</h1><p className="empty-tagline">{greeting.tagline}</p><div className="prompt-suggestions">{['Translate a meeting note', 'Summarize my voice memo', 'Help me understand this'].map((prompt) => <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>{prompt}<ArrowUp size={14} /></button>)}</div></div>;
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
function hasNonLatinScript(text) { return /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text); }
function resizeTextarea(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`; textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden'; }

export default App;
