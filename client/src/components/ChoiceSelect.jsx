import { formatNumber } from '../format.js';

/**
 * A drop-down of filter choices ({ value, label, count }) with an "All …" option. A chosen value
 * that's no longer among the choices (another time range, say) stays listed so it can be cleared.
 */
export default function ChoiceSelect({ label, value, choices = [], onChange, formatLabel = (text) => text }) {
  const options = value && !choices.some((choice) => choice.value === value) ? [{ value, label: value, count: 0 }, ...choices] : choices;
  return (
    <select value={value} onChange={(changeEvent) => onChange(changeEvent.target.value)} aria-label={label}>
      <option value="">{label}</option>
      {options.map((choice) => (
        <option key={choice.value} value={choice.value}>{formatLabel(choice.label) ?? choice.label} ({formatNumber(choice.count)})</option>
      ))}
    </select>
  );
}
