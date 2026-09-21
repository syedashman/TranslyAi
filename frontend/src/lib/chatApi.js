import axios from 'axios';
import { API_BASE_URL } from './config';
import { supabase } from './supabase';
import { describeError, MESSAGES } from './errors';

// The free backend can take a while to wake up, so the first calls get a long timeout.
const DEFAULT_TIMEOUT_MS = 30000;
const LIST_TIMEOUT_MS = 60000;

async function call(method, path, { data, params, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error(MESSAGES.session);
  try {
    const response = await axios({ method, url: `${API_BASE_URL}/api${path}`, data, params, timeout, headers: { Authorization: `Bearer ${token}` } });
    return response.data;
  } catch (error) {
    throw new Error(describeError(error));
  }
}

export const listChats = () => call('get', '/chats', { params: { archived: 'all' }, timeout: LIST_TIMEOUT_MS });
export const createChat = () => call('post', '/chats', { data: {} });
export const setPinned = (chatId, value) => call('patch', `/chats/${chatId}/pin`, { data: { value } });
export const setArchived = (chatId, value) => call('patch', `/chats/${chatId}/archive`, { data: { value } });
export const deleteChat = (chatId) => call('delete', `/chats/${chatId}`);
export const fetchMessages = (chatId) => call('get', `/chats/${chatId}/messages`);
export const saveMessages = (chatId, messages) => call('post', `/chats/${chatId}/messages`, { data: { messages } });
export const deleteMessages = (chatId, messageIds) => call('post', `/chats/${chatId}/messages/delete`, { data: { message_ids: messageIds } });
export const generateTitle = (chatId, text) => call('post', `/chats/${chatId}/title`, { data: { text: text.slice(0, 2000) }, timeout: 60000 });

export const toUiMessage = (row) => ({
  id: row.id,
  role: row.role,
  content: row.content || '',
  audioName: row.audio_name || '',
  result: row.result || undefined,
  createdAt: row.created_at,
});

export const toApiMessage = (message) => ({
  role: message.role,
  content: message.content || null,
  audio_name: message.audioName || null,
  result: message.result || null,
});

export function sortChats(chats) {
  return [...chats].sort((a, b) => (Number(b.is_pinned) - Number(a.is_pinned)) || (new Date(b.updated_at) - new Date(a.updated_at)));
}
