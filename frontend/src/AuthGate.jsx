import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import App from './App';
import AuthPage from './AuthPage';
import { supabase } from './lib/supabase';
import { hideSplash, wireBackButton } from './lib/native';

export default function AuthGate() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);
  const [authView, setAuthView] = useState(null); // 'login' | 'signup' while a guest is signing in

  // Both no-op on the web (see lib/native.js) - only relevant inside the packaged Android app.
  useEffect(() => { hideSplash(); wireBackButton(); }, []);

  useEffect(() => {
    if (!supabase) { setSession(null); return undefined; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => { if (session) setAuthView(null); }, [session]);

  useEffect(() => {
    if (!authView) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setAuthView(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authView]);

  const userId = session?.user?.id;
  useEffect(() => {
    if (!session?.user) { setProfile(null); return undefined; }
    const { id, email, user_metadata: meta = {} } = session.user;
    let cancelled = false;
    (async () => {
      // The database trigger normally creates the row; ignoreDuplicates means edits made in the app are never overwritten.
      await supabase.from('profiles').upsert(
        { id, email, full_name: meta.full_name || meta.name || null, avatar_url: meta.avatar_url || meta.picture || null },
        { onConflict: 'id', ignoreDuplicates: true },
      );
      const { data, error } = await supabase.from('profiles').select('full_name, avatar_url').eq('id', id).maybeSingle();
      if (error) console.warn('Profile load skipped:', error.message);
      else if (!cancelled && data) setProfile(data);
    })();
    return () => { cancelled = true; };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (session === undefined) return <div className="auth-shell"><LoaderCircle size={26} className="spin" /></div>;
  if (!session) {
    // The auth form opens over the guest chat, so the conversation is still there if the guest closes it.
    return (
      <>
        <App key="guest" guest user={null} onRequestAuth={setAuthView} />
        {authView && (
          <div className="auth-overlay" role="dialog" aria-modal="true" aria-label={authView === 'signup' ? 'Sign up' : 'Log in'}>
            <AuthPage key={authView} initialMode={authView} onBack={() => setAuthView(null)} />
          </div>
        )}
      </>
    );
  }

  const { user } = session;
  const meta = user.user_metadata || {};
  const account = {
    id: user.id,
    email: user.email,
    name: profile?.full_name || meta.full_name || meta.name || user.email?.split('@')[0] || 'Account',
    avatarUrl: profile?.avatar_url || meta.avatar_url || meta.picture || '',
  };
  const updateProfile = ({ name, avatarUrl }) => setProfile((current) => ({
    full_name: name ?? current?.full_name ?? null,
    avatar_url: avatarUrl ?? current?.avatar_url ?? null,
  }));

  return <App key={account.id} user={account} onSignOut={() => supabase.auth.signOut()} onProfileChange={updateProfile} />;
}
