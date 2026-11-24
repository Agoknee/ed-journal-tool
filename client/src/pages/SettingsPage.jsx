import { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson } from '../api.js';
import { Badge, Section } from '../components/ui.jsx';

/**
 * Settings, kept by the server in settings.json in its data folder. For now, the password other
 * devices log in with; later settings get sections of their own here (their values come from
 * GET /api/settings, and PATCH /api/settings changes them).
 */
export default function SettingsPage() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // Bumped to load again after a change.
  const [loadCount, setLoadCount] = useState(0);

  useEffect(() => {
    let isCurrent = true;
    fetchJson('/api/settings')
      .then((nextState) => {
        if (!isCurrent) return;
        setState(nextState);
        setLoadError(null);
      })
      .catch((error) => {
        if (isCurrent) setLoadError(error.message);
      });
    return () => {
      isCurrent = false;
    };
  }, [loadCount]);

  if (loadError) return <div className="notice notice-error">{loadError}</div>;
  if (!state) return <p className="muted">Loading…</p>;
  return <PasswordSection hasPassword={state.hasPassword} isLocal={state.isLocal} onChanged={() => setLoadCount((count) => count + 1)} />;
}

const MIN_PASSWORD_LENGTH = 8;

function PasswordSection({ hasPassword, isLocal, onChanged }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  // From another device, changing or removing the password needs the current one.
  const needsCurrent = hasPassword && !isLocal;

  const problem = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH
    ? `At least ${MIN_PASSWORD_LENGTH} characters.`
    : confirmation.length > 0 && confirmation !== newPassword ? 'The passwords don’t match.' : null;
  const canSave = newPassword.length >= MIN_PASSWORD_LENGTH && confirmation === newPassword && (!needsCurrent || currentPassword) && !isSaving;

  async function run(action, successText) {
    setIsSaving(true);
    setMessage(null);
    try {
      await action();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setMessage({ tone: 'info', text: successText });
      await onChanged();
    } catch (error) {
      setMessage({ tone: 'error', text: error.message });
    } finally {
      setIsSaving(false);
    }
  }

  function savePassword(submitEvent) {
    submitEvent.preventDefault();
    run(
      () => putJson('/api/settings/password', { newPassword, currentPassword: needsCurrent ? currentPassword : undefined }),
      hasPassword ? 'Password changed. Other devices need to log in again.' : 'Password set. Other devices can now log in with it.',
    );
  }

  function removePassword() {
    if (!window.confirm('Remove the password? Other devices won’t be able to use EDJT until one is set again.')) return;
    run(
      () => fetchJson('/api/settings/password', { method: 'DELETE', body: needsCurrent ? { currentPassword } : {} }),
      'Password removed. Other devices can no longer use EDJT.',
    );
  }

  return (
    <Section
      id="settings-password"
      title="Password"
      actions={<Badge tone={hasPassword ? 'live' : 'neutral'}>{hasPassword ? 'Set' : 'Not set'}</Badge>}
      description="Other devices (a phone, another computer) log in with this password to use the dashboard. On the computer running EDJT it's never asked. Without one, other devices can't use EDJT."
    >
      <form className="settings-form" onSubmit={savePassword}>
        {!isLocal && (
          <p className="notice notice-warning">
            Your connection to EDJT isn’t encrypted, so others on your network could see the password as it’s sent. Use one you
            don’t use anywhere else.
          </p>
        )}
        {needsCurrent && (
          <label>
            <span>Current password</span>
            <input type="password" autoComplete="current-password" value={currentPassword} onChange={(changeEvent) => setCurrentPassword(changeEvent.target.value)} />
          </label>
        )}
        <label>
          <span>{hasPassword ? 'New password' : 'Password'}</span>
          <input type="password" autoComplete="new-password" value={newPassword} onChange={(changeEvent) => setNewPassword(changeEvent.target.value)} />
        </label>
        <label>
          <span>Confirm</span>
          <input type="password" autoComplete="new-password" value={confirmation} onChange={(changeEvent) => setConfirmation(changeEvent.target.value)} />
        </label>
        {problem && <div className="muted small">{problem}</div>}
        {message && <div className={`notice notice-${message.tone}`}>{message.text}</div>}
        <div className="settings-actions">
          <button type="submit" className="button-primary" disabled={!canSave}>{hasPassword ? 'Change Password' : 'Set Password'}</button>
          {hasPassword && (
            <button type="button" onClick={removePassword} disabled={isSaving || (needsCurrent && !currentPassword)}>Remove Password</button>
          )}
          {!isLocal && (
            <button type="button" onClick={() => postJson('/api/auth/logout', {}).then(() => window.location.reload())}>Log Out</button>
          )}
        </div>
      </form>
    </Section>
  );
}
