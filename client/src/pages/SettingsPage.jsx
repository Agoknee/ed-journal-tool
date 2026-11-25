import { useEffect, useState } from 'react';
import { fetchJson, postJson, putJson } from '../api.js';
import CopyableText from '../components/CopyableText.jsx';
import { Badge, Section, StatCard, StatGrid } from '../components/ui.jsx';
import { formatBytes, formatDateTime, formatNumber } from '../format.js';
import { useApi } from '../hooks/use-api.js';

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
  return (
    <>
      <PasswordSection hasPassword={state.hasPassword} isLocal={state.isLocal} onChanged={() => setLoadCount((count) => count + 1)} />
      <DatabaseSection needsPassword={state.hasPassword && !state.isLocal} />
    </>
  );
}

/** The database: its size on disk and what it holds, a link to the journals, and resetting it. */
function DatabaseSection({ needsPassword }) {
  const databaseRequest = useApi('/api/database', {}, ['journals', 'scan', 'stats']);
  const database = databaseRequest.data;
  const [isResetOpen, setIsResetOpen] = useState(false);

  return (
    <Section
      id="settings-database"
      title="Database"
      description="Everything EDJT has read from your journals, and what you've added (notes, BGS adjustments). Journal files are only ever read, never changed."
      actions={<a className="button" href="#/journals">Open Journals</a>}
    >
      {databaseRequest.error && <div className="notice notice-error">{databaseRequest.error.message}</div>}
      {database && (
        <>
          <StatGrid>
            <StatCard
              label="Size on Disk"
              value={formatBytes(database.sizeOnDisk.totalBytes)}
              detail={`${formatBytes(database.sizeOnDisk.freeBytes)} free inside${database.sizeOnDisk.walBytes > 0 ? `, ${formatBytes(database.sizeOnDisk.walBytes)} write-ahead log` : ''}`}
            />
            <StatCard label="Journal Entries" value={formatNumber(database.entryCount)} detail={database.firstEntryAt ? `${formatDateTime(database.firstEntryAt)} to ${formatDateTime(database.lastEntryAt)}` : 'None yet'} />
            <StatCard
              label="Journal Files"
              value={formatNumber(database.journalFiles.total)}
              detail={[
                database.journalFiles.missing > 0 && `${formatNumber(database.journalFiles.missing)} no longer on disk`,
                database.journalFiles.corrupt > 0 && `${formatNumber(database.journalFiles.corrupt)} unreadable`,
              ].filter(Boolean).join(', ') || null}
            />
            <StatCard label="Commanders" value={formatNumber(database.commanderCount)} />
            <StatCard
              label="Your Additions"
              value={formatNumber(database.noteCount + database.bgsAdjustmentCount)}
              detail={`${formatNumber(database.noteCount)} notes, ${formatNumber(database.bgsAdjustmentCount)} BGS adjustments`}
            />
            <StatCard label="BGS Ticks Seen" value={formatNumber(database.tickCount)} />
            {database.resetCopies.length > 0 && (
              <StatCard
                label="Copies Kept on Reset"
                value={formatNumber(database.resetCopies.length)}
                detail={`${formatBytes(database.resetCopies.reduce((total, copy) => total + copy.bytes, 0))}, beside the database (delete them when you no longer need them)`}
              />
            )}
          </StatGrid>
          <p className="muted small settings-path">
            <CopyableText copyText={database.path}>{database.path}</CopyableText>
          </p>
          {isResetOpen
            ? <ResetDatabase database={database} needsPassword={needsPassword} onClose={() => setIsResetOpen(false)} />
            : (
              <div className="settings-actions">
                <button type="button" className="button-danger" onClick={() => setIsResetOpen(true)}>Reset Database…</button>
              </div>
            )}
        </>
      )}
    </Section>
  );
}

/**
 * Resetting the database, behind strong confirmation: what's lost is spelled out, and it takes
 * ticking that it can't be undone and typing the confirmation word (and the password, from
 * another device).
 */
function ResetDatabase({ database, needsPassword, onClose }) {
  const [keepCopy, setKeepCopy] = useState(true);
  const [hasAcknowledged, setHasAcknowledged] = useState(false);
  const [typed, setTyped] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState(null);
  const [isResetting, setIsResetting] = useState(false);
  const [result, setResult] = useState(null);
  const confirmation = database.resetConfirmation;
  const canReset = hasAcknowledged && typed === confirmation && (!needsPassword || currentPassword) && !isResetting && !database.resetBlockedReason;

  async function reset(submitEvent) {
    submitEvent.preventDefault();
    setIsResetting(true);
    setError(null);
    try {
      setResult(await postJson('/api/database/reset', { confirmation: typed, keepCopy, currentPassword: needsPassword ? currentPassword : undefined }));
    } catch (resetError) {
      setError(resetError.message);
    } finally {
      setIsResetting(false);
    }
  }

  if (result) {
    return (
      <div className="notice notice-info reset-database">
        The database has been reset. The journals still in your journal folder are being read again; the banners at the top
        show how far along it is.
        {result.copy && (
          <p>
            The copy kept ({formatBytes(result.copy.bytes)}): <CopyableText copyText={result.copy.path}>{result.copy.path}</CopyableText>
          </p>
        )}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    );
  }

  return (
    <form className="settings-form reset-database" onSubmit={reset}>
      <div className="notice notice-error">
        <strong>
          {keepCopy
            ? 'This deletes everything in the database. Only the copy kept can bring it back.'
            : 'This deletes everything in the database, and it can’t be undone or recovered.'}
        </strong>
        <ul>
          <li>All {formatNumber(database.entryCount)} stored journal entries. Journals that are no longer in your journal folder (deleted, or from another computer) can’t be read again{database.journalFiles.missing > 0 ? `: ${formatNumber(database.journalFiles.missing)} of them right now` : ''}.</li>
          <li>Your notes ({formatNumber(database.noteCount)}) and manual BGS adjustments ({formatNumber(database.bgsAdjustmentCount)}).</li>
          <li>The BGS tick history ({formatNumber(database.tickCount)} ticks), which can’t be read from journals.</li>
        </ul>
        Afterwards, the journals still in your journal folder are read again from scratch, which can take several minutes. Settings
        (like the password) are kept.
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={keepCopy} onChange={(changeEvent) => setKeepCopy(changeEvent.target.checked)} />
        Keep a copy of the database first (about {formatBytes(database.sizeOnDisk.totalBytes - database.sizeOnDisk.freeBytes - database.sizeOnDisk.walBytes)}, beside it)
      </label>
      {keepCopy && (
        <p className="muted small">
          To go back to the copy later: quit EDJT, delete the database file and any files beside it ending in -wal or -shm, then rename the
          copy to the database’s name.
        </p>
      )}
      {database.resetBlockedReason && <div className="notice notice-warning">{database.resetBlockedReason}</div>}
      <label className="checkbox-label">
        <input type="checkbox" checked={hasAcknowledged} onChange={(changeEvent) => setHasAcknowledged(changeEvent.target.checked)} />
        {keepCopy ? 'I understand that this deletes my data from EDJT.' : 'I understand that this deletes my data permanently.'}
      </label>
      <label>
        <span>Type {confirmation} to confirm</span>
        <input type="text" autoComplete="off" spellCheck={false} value={typed} onChange={(changeEvent) => setTyped(changeEvent.target.value)} />
      </label>
      {needsPassword && (
        <label>
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={currentPassword} onChange={(changeEvent) => setCurrentPassword(changeEvent.target.value)} />
        </label>
      )}
      {error && <div className="notice notice-error">{error}</div>}
      <div className="settings-actions">
        <button type="submit" className="button-danger" disabled={!canReset}>{isResetting ? 'Resetting…' : 'Delete Everything and Read the Journals Again'}</button>
        <button type="button" onClick={onClose} disabled={isResetting}>Cancel</button>
      </div>
    </form>
  );
}

const MIN_PASSWORD_LENGTH = 8;

function PasswordSection({ hasPassword, isLocal, onChanged }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  // From another device, changing or removing the password needs the current one.
  const needsCurrent = hasPassword && !isLocal;

  const problem = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH ? `At least ${MIN_PASSWORD_LENGTH} characters.` : null;
  const canSave = newPassword.length >= MIN_PASSWORD_LENGTH && (!needsCurrent || currentPassword) && !isSaving;

  async function run(action, successText) {
    setIsSaving(true);
    setMessage(null);
    try {
      await action();
      setCurrentPassword('');
      setNewPassword('');
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
