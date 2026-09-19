import { useState } from 'react';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { isSupabaseConfigured, supabase } from './lib/supabase';

const MIN_PASSWORD_LENGTH = 6;

function friendlyAuthError(error) {
  const message = error?.message || '';
  if (/invalid login credentials/i.test(message)) return 'Incorrect email or password.';
  if (/email not confirmed/i.test(message)) return 'Please confirm your email first. Check your inbox for the confirmation link.';
  if (/already registered|already been registered/i.test(message)) return 'An account with this email already exists. Please log in.';
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Please wait a moment and try again.';
  if (/failed to fetch|network/i.test(message)) return 'Network error. Check your connection and try again.';
  return message || 'Something went wrong. Please try again.';
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.6 5.9c4.4-4.1 6.9-10.2 6.9-17.6z" />
      <path fill="#FBBC05" d="M10.5 28.7A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

export default function AuthPage() {
  const [mode, setMode] = useState('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const isSignup = mode === 'signup';

  const switchMode = (nextMode) => { setMode(nextMode); setError(''); setNotice(''); };

  const submit = async (event) => {
    event.preventDefault();
    if (!supabase) return;
    setError(''); setNotice('');
    if (isSignup && !fullName.trim()) { setError('Please enter your name.'); return; }
    if (password.length < MIN_PASSWORD_LENGTH) { setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`); return; }

    setBusy(true);
    try {
      if (isSignup) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim() }, emailRedirectTo: window.location.origin },
        });
        if (signUpError) throw signUpError;
        // Supabase hides duplicate emails by returning a user with no identities.
        if (data.user && data.user.identities?.length === 0) throw new Error('An account with this email already exists. Please log in.');
        if (!data.session) {
          setNotice('Account created! Check your email for a confirmation link, then log in.');
          setMode('login'); setPassword('');
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
      }
    } catch (authError) {
      setError(friendlyAuthError(authError));
    } finally { setBusy(false); }
  };

  const signInWithGoogle = async () => {
    if (!supabase) return;
    setError(''); setNotice(''); setBusy(true);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (oauthError) { setError(friendlyAuthError(oauthError)); setBusy(false); }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand"><div className="brand-mark"><Sparkles size={16} /></div><span>LinguaAI</span></div>
        <h1>{isSignup ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth-subtitle">{isSignup ? 'Sign up to translate text and voice into clear English.' : 'Log in to continue your translations.'}</p>

        {!isSupabaseConfigured && (
          <div className="auth-message auth-error">Sign-in isn't configured yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to the frontend environment.</div>
        )}

        <button type="button" className="google-button" onClick={signInWithGoogle} disabled={busy || !isSupabaseConfigured}>
          <GoogleLogo />Continue with Google
        </button>
        <div className="auth-divider"><span>or use your email</span></div>

        <form className="auth-form" onSubmit={submit}>
          {isSignup && (
            <label>Full name
              <input type="text" value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" placeholder="Your name" required />
            </label>
          )}
          <label>Email
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="you@example.com" required />
          </label>
          <label>Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={isSignup ? 'new-password' : 'current-password'} placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`} required />
          </label>
          {error && <div className="auth-message auth-error" role="alert">{error}</div>}
          {notice && <div className="auth-message auth-notice" role="status">{notice}</div>}
          <button type="submit" className="auth-submit" disabled={busy || !isSupabaseConfigured}>
            {busy ? <LoaderCircle size={17} className="spin" /> : isSignup ? 'Create account' : 'Log in'}
          </button>
        </form>

        <p className="auth-switch">
          {isSignup ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button type="button" onClick={() => switchMode(isSignup ? 'login' : 'signup')}>{isSignup ? 'Log in' : 'Sign up'}</button>
        </p>
      </div>
    </div>
  );
}
