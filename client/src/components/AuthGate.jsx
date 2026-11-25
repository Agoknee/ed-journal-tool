import { useEffect, useState } from 'react';
import { AUTH_REQUIRED_EVENT, postJson } from '../api.js';

/** How often the login status is checked again while EDJT can't be reached. */
const STATUS_RETRY_MS = 3000;

/**
 * Shows the dashboard once the API can be used: always on the computer running EDJT, and on other
 * devices after logging in with the password set in Settings. Otherwise it's a login form, or a
 * note that other devices can't use EDJT until a password is set. Checked again whenever the API
 * asks for a login (a session that ended, or a password changed elsewhere).
 */
export default function AuthGate({ children }) {
  const [status, setStatus] = useState(null);
  const [problem, setProblem] = useState(null);
  // Bumped to check again.
  const [checkCount, setCheckCount] = useState(0);

  useEffect(() => {
    const checkAgain = () => setCheckCount((count) => count + 1);
    window.addEventListener(AUTH_REQUIRED_EVENT, checkAgain);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, checkAgain);
  }, []);

  useEffect(() => {
    let isCurrent = true;
    let retryTimer = null;
    fetch('/api/auth/status')
      .then((response) => response.json())
      .then((nextStatus) => {
        if (!isCurrent) return;
        setStatus(nextStatus);
        setProblem(null);
      })
      .catch(() => {
        if (!isCurrent) return;
        setProblem('Can’t reach EDJT. Check that ED Journal Tool is running (and, on another device, that it’s on the same network). This page carries on by itself once it’s back.');
        // Tried again until it answers. (A dashboard already shown stays, with its own banner.)
        retryTimer = setTimeout(() => setCheckCount((count) => count + 1), STATUS_RETRY_MS);
      });
    return () => {
      isCurrent = false;
      clearTimeout(retryTimer);
    };
  }, [checkCount]);

  if (status?.isAuthenticated) return children;
  return (
    <div className="auth-screen">
      <div className="card auth-card">
        <div className="brand auth-brand">
          <img className="brand-mark" src="/edjt-logo.svg" alt="" width="55" height="55" />
          <div className="brand-title">ED Journal Tool</div>
        </div>
        {problem && <div className="notice notice-error">{problem}</div>}
        {status && !status.hasPassword && (
          <p>
            Using EDJT from other devices is off until a password is set. On the computer running EDJT, open the
            dashboard (http://localhost:4267) and set one under Settings.
          </p>
        )}
        {status?.hasPassword && <LoginForm />}
        {!status && !problem && <p className="muted">Connecting…</p>}
      </div>
    </div>
  );
}

function LoginForm() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function logIn(submitEvent) {
    submitEvent.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await postJson('/api/auth/login', { password });
      // Started afresh, so the live updates connect with the new session.
      window.location.reload();
    } catch (loginError) {
      setError(loginError.message);
      setIsSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={logIn}>
      <label>
        <span>Password</span>
        <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(changeEvent) => setPassword(changeEvent.target.value)} />
      </label>
      {error && <div className="notice notice-error">{error}</div>}
      <button type="submit" className="button-primary" disabled={isSubmitting || password === ''}>Log In</button>
    </form>
  );
}
