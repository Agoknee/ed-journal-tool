import { useEffect, useRef, useState } from 'react';
import { putJson } from '../api.js';
import { ADJUSTMENT_FIELDS, ADJUSTMENT_GROUPS, parseAmount } from '../bgs-adjustment-fields.js';

// The groups split into two columns of about the same height (side by side when there's room).
const ADJUSTMENT_COLUMNS = [ADJUSTMENT_GROUPS.slice(0, 4), ADJUSTMENT_GROUPS.slice(4)];
import { formatBgsNumber } from '../bgs-report.js';
import { useApi, useDebouncedValue } from '../hooks/use-api.js';
import { formatDateTime, formatFullCredits } from '../format.js';

/** A tracked or manual value as shown beside an input: credits abbreviated (exact on hover), counts as-is. */
function formatInputValue(field, value) {
  return field.isCredits && Math.abs(value) >= 1000 ? formatBgsNumber(value) : String(value);
}

/**
 * Sets the totals for one commander, tick, system and faction. The user types the total they want
 * for each field; the server stores the difference from the tracked activity.
 *
 * target: { systemAddress, starSystem, faction, commanderId? } to edit a faction already shown, or
 * null to pick a system and faction first (for activity the app didn't track at all). With every
 * commander shown, the commander can be chosen, starting from target.commanderId or the most recent.
 */
export default function BgsAdjustmentDialog({ tick, target, commanders, commanderFilter, onClose }) {
  const dialogRef = useRef(null);
  const isAdding = !target;
  const [commanderId, setCommanderId] = useState(() => String(target?.commanderId ?? (commanderFilter !== 'all' ? commanderFilter : getMostRecentCommander(commanders)?.id ?? '')));
  const [systemText, setSystemText] = useState(target?.starSystem ?? '');
  const [factionText, setFactionText] = useState(target?.faction ?? '');
  // Only the fields the user has typed into; the rest show the current totals.
  const [draftValues, setDraftValues] = useState({});
  const [saveState, setSaveState] = useState({ isSaving: false, error: null });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog.open) dialog.showModal();
  }, []);

  const systemSearch = useDebouncedValue(isAdding ? systemText.trim() : '');
  const systemsRequest = useApi(systemSearch ? '/api/bgs-adjustments/systems' : null, { search: systemSearch }, []);
  const systemSuggestions = systemsRequest.data?.systems ?? [];
  const matchedSystem = systemSuggestions.find((system) => system.starSystem.toLowerCase() === systemText.trim().toLowerCase());
  const factionSuggestions = matchedSystem?.factions ?? [];

  const fieldTarget = {
    commander: commanderId,
    tick,
    systemAddress: target?.systemAddress ?? '',
    starSystem: useDebouncedValue(systemText.trim()),
    faction: useDebouncedValue(factionText.trim()),
  };
  const isTargetComplete = Boolean(fieldTarget.commander && fieldTarget.starSystem && fieldTarget.faction);
  const fieldsRequest = useApi(isTargetComplete ? '/api/bgs-adjustments/fields' : null, fieldTarget, ['stats', 'adjustments']);
  const fields = isTargetComplete ? fieldsRequest.data?.fields ?? null : null;

  const getTotal = (fieldKey) => (fields ? fields[fieldKey].tracked + fields[fieldKey].manual : 0);
  const validation = Object.fromEntries(Object.entries(draftValues).map(([fieldKey, text]) => {
    const field = ADJUSTMENT_FIELDS[fieldKey];
    const amount = parseAmount(text);
    if (Number.isNaN(amount)) return [fieldKey, { error: 'Not a number' }];
    if (amount < 0 && !field.allowsNegative) return [fieldKey, { error: "Can't be negative" }];
    if (!field.isCredits && !Number.isInteger(amount)) return [fieldKey, { error: 'Whole numbers only' }];
    return [fieldKey, { amount: Math.round(amount) }];
  }));
  const changedTotals = Object.fromEntries(Object.entries(validation)
    .filter(([fieldKey, result]) => result.amount !== undefined && result.amount !== getTotal(fieldKey))
    .map(([fieldKey, result]) => [fieldKey, result.amount]));
  const hasErrors = Object.values(validation).some((result) => result.error);
  const canSave = Boolean(fields) && !hasErrors && Object.keys(changedTotals).length > 0 && !saveState.isSaving;

  const save = async (submitEvent) => {
    submitEvent.preventDefault();
    if (!canSave) return;
    setSaveState({ isSaving: true, error: null });
    try {
      await putJson('/api/bgs-adjustments', {
        commanderId: Number(fieldTarget.commander),
        tick,
        systemAddress: target?.systemAddress ?? null,
        starSystem: systemText.trim(),
        faction: factionText.trim(),
        totals: changedTotals,
      });
      onClose();
    } catch (error) {
      setSaveState({ isSaving: false, error: error.message });
    }
  };

  const resetToTracked = () => {
    setDraftValues(Object.fromEntries(Object.entries(fields)
      .filter(([, field]) => field.manual !== 0)
      .map(([fieldKey, field]) => [fieldKey, String(field.tracked)])));
  };
  const hasManualValues = Boolean(fields) && Object.values(fields).some((field) => field.manual !== 0);

  return (
    <dialog
      ref={dialogRef}
      className="table-settings-dialog bgs-adjustment-dialog"
      onClose={onClose}
      onClick={(clickEvent) => clickEvent.target === dialogRef.current && onClose()}
    >
      <form className="table-settings-body" onSubmit={save}>
        <header className="table-settings-header">
          <h2>{isAdding ? 'Add Activity' : 'Edit Activity'}</h2>
          <button type="button" className="table-settings-close" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <p className="muted small">
          Tick of {formatDateTime(tick)}. Enter the total for each field; the difference from the tracked activity is saved as a manual adjustment.
        </p>

        <div className="bgs-adjustment-target">
          {commanderFilter === 'all' && (
            <label>
              Commander
              <select value={commanderId} onChange={(changeEvent) => { setCommanderId(changeEvent.target.value); setDraftValues({}); }}>
                {commanders.map((commander) => <option key={commander.id} value={commander.id}>CMDR {commander.name}</option>)}
              </select>
            </label>
          )}
          {isAdding ? (
            <>
              <label>
                System
                <input type="text" list="bgs-adjustment-systems" value={systemText} autoFocus maxLength={200} onChange={(changeEvent) => setSystemText(changeEvent.target.value)} />
                <datalist id="bgs-adjustment-systems">
                  {systemSuggestions.map((system) => <option key={system.systemAddress} value={system.starSystem} />)}
                </datalist>
              </label>
              <label>
                Faction
                <input type="text" list="bgs-adjustment-factions" value={factionText} maxLength={200} onChange={(changeEvent) => setFactionText(changeEvent.target.value)} />
                <datalist id="bgs-adjustment-factions">
                  {factionSuggestions.map((faction) => <option key={faction} value={faction} />)}
                </datalist>
              </label>
            </>
          ) : (
            <div className="bgs-adjustment-heading">
              <strong>{target.starSystem}</strong>
              <span>{target.faction}</span>
            </div>
          )}
        </div>

        {!isTargetComplete ? (
          <div className="notice">Choose a system and faction.</div>
        ) : fieldsRequest.error ? (
          <div className="notice notice-error">Error: {fieldsRequest.error.message}</div>
        ) : !fields ? (
          <div className="notice">Loading…</div>
        ) : (
          <div className="bgs-adjustment-groups">
            {ADJUSTMENT_COLUMNS.map((columnGroups) => (
              <div key={columnGroups[0].label} className="bgs-adjustment-column">
                {columnGroups.map((group) => (
                  <fieldset key={group.label} className="bgs-adjustment-group">
                    <legend>{group.label}</legend>
                    {group.fields.map((field) => {
                      const { tracked, manual } = fields[field.key];
                      const fieldValidation = validation[field.key];
                      const inputId = `bgs-adjustment-${field.key.replace(':', '-')}`;
                      return (
                        <div key={field.key} className="bgs-adjustment-field">
                          <label htmlFor={inputId}>{field.label}</label>
                          <span className="muted small" title={field.isCredits ? `Tracked ${formatFullCredits(tracked)}` : undefined}>
                            Tracked {formatInputValue(field, tracked)}
                            {manual !== 0 && <span className="bgs-adjusted-note">{' '}· Manual {manual > 0 ? '+' : ''}{formatInputValue(field, manual)}</span>}
                          </span>
                          <input
                            id={inputId}
                            type="text"
                            inputMode={field.isCredits ? 'text' : 'numeric'}
                            className={fieldValidation?.error ? 'input-invalid' : undefined}
                            title={fieldValidation?.error ?? (field.isCredits ? 'Accepts amounts like 1.2M or 450K' : undefined)}
                            value={draftValues[field.key] ?? String(tracked + manual)}
                            onChange={(changeEvent) => setDraftValues({ ...draftValues, [field.key]: changeEvent.target.value })}
                          />
                        </div>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
            ))}
          </div>
        )}

        {hasErrors && (
          <div className="notice notice-error">
            {Object.entries(validation).filter(([, result]) => result.error).map(([fieldKey, result]) => `${ADJUSTMENT_FIELDS[fieldKey].fullLabel}: ${result.error}`).join(' · ')}
          </div>
        )}
        {saveState.error && <div className="notice notice-error">{saveState.error}</div>}
        <footer className="table-settings-footer">
          <button type="button" disabled={!hasManualValues} title="Set every field back to its tracked value" onClick={resetToTracked}>Reset to Tracked</button>
          <span className="bgs-adjustment-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="button-primary" disabled={!canSave}>{saveState.isSaving ? 'Saving…' : 'Save'}</button>
          </span>
        </footer>
      </form>
    </dialog>
  );
}

function getMostRecentCommander(commanders) {
  return [...commanders].sort((first, second) => (second.last_seen ?? '').localeCompare(first.last_seen ?? ''))[0] ?? null;
}
