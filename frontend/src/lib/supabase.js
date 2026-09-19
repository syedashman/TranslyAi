import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL || '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const isSupabaseConfigured =
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url) && anonKey.length > 30 && !/your[-_]/i.test(`${url}${anonKey}`);

export const supabase = isSupabaseConfigured ? createClient(url, anonKey) : null;
