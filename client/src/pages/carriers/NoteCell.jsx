import { useState } from 'react';
import { putJson } from '../../api.js';

const MAX_NOTE_LENGTH = 200;

/**
 * A carrier's or commander's note. Double-clicking (or Enter when focused) edits it in place: Enter or leaving the field saves, Escape cancels,
 * and saving an empty note removes it.
 */
export function NoteCell({ note, saveUrl, subjectLabel }) {
  const [draftNote, setDraftNote] = useState(null); // null while not editing
  // A just-saved note, shown until refreshed data replaces the note it was edited from.
  const [pendingSave, setPendingSave] = useState(null); // { note, previousNote }
  const [saveError, setSaveError] = useState(null);
  const savedNote = note ?? '';
  const displayedNote = pendingSave?.previousNote === savedNote ? pendingSave.note : savedNote;

  const saveNote = async () => {
    const newNote = draftNote.trim();
    setDraftNote(null);
    if (newNote === displayedNote) return;
    setPendingSave({ note: newNote, previousNote: savedNote });
    setSaveError(null);
    try {
      await putJson(saveUrl, { note: newNote });
    } catch (error) {
      setPendingSave(null);
      setSaveError(error.message);
    }
  };

  if (draftNote !== null) {
    return (
      <input
        className="note-input"
        value={draftNote}
        maxLength={MAX_NOTE_LENGTH}
        placeholder="Add a note…"
        aria-label={`Note for ${subjectLabel}`}
        autoFocus
        onChange={(changeEvent) => setDraftNote(changeEvent.target.value)}
        onBlur={saveNote}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Enter') keyEvent.currentTarget.blur();
          if (keyEvent.key === 'Escape') setDraftNote(null);
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={displayedNote ? 'note-button' : 'note-button note-button-empty'}
      title={saveError ? `Couldn't save the note: ${saveError}` : 'Double-click to edit the note'}
      onDoubleClick={() => setDraftNote(displayedNote)}
      onKeyDown={(keyEvent) => {
        if (keyEvent.key === 'Enter') {
          keyEvent.preventDefault();
          setDraftNote(displayedNote);
        }
      }}
    >
      {displayedNote || 'Add note'}
      {saveError && <span className="note-error"> (not saved)</span>}
    </button>
  );
}
