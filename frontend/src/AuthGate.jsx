import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import App from './App';
import AuthPage from './AuthPage';
import { supabase } from './lib/supabase';

function saveProfile(user) {
  const meta = user.user_metadata || {};
  // The database trigger normally creates the profile; this upsert is a safety net.
  return supabase.from('profiles').upsert({
    id: user.id,
    email: user.email,
    full_name: meta.full_name || meta.name || null,
    avatar_url: meta.avatar_url || meta.picture || null,
  }, { onConflict: 'id' });
}

export default function AuthGate() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    if (!supabase) { setSession(null); return undefined; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => subscription.unsubscribe();
  }, []);

  const userId = session?.user?.id;
  useEffect(() => {
    if (!session?.user) return;
    saveProfile(session.user).then(({ error }) => { if (error) console.warn('Profile sync skipped:', error.message); });
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (session === undefined) return <div className="auth-shell"><LoaderCircle size={26} className="spin" /></div>;
  if (!session) return <AuthPage />;

  const { user } = session;
  const meta = user.user_metadata || {};
  const account = {
    id: user.id,
    email: user.email,
    name: meta.full_name || meta.name || user.email?.split('@')[0] || 'Account',
    avatarUrl: meta.avatar_url || meta.picture || '',
  };
  return <App key={account.id} user={account} onSignOut={() => supabase.auth.signOut()} />;
}
