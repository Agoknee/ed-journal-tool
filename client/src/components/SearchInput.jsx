import { useRef } from 'react';

/**
 * Search text input with a clear (×) button on the right that appears once there's a value.
 * @param {{ value: string, onChange: (value: string) => void, placeholder?: string, className?: string }} props
 */
export default function SearchInput({ value, onChange, placeholder = 'Search…', className = '' }) {
  const inputRef = useRef(null);

  const clearValue = () => {
    onChange('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (keyEvent) => {
    if (keyEvent.key === 'Escape' && value) {
      keyEvent.preventDefault();
      clearValue();
    }
  };

  return (
    <div className={`search-input ${className}`}>
      <input
        ref={inputRef}
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
        onKeyDown={handleKeyDown}
      />
      {value && (
        <button type="button" className="search-clear" onClick={clearValue} aria-label="Clear search" title="Clear">
          ×
        </button>
      )}
    </div>
  );
}
