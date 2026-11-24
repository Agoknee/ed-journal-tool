import { useEffect, useState } from 'react';
import { copyToClipboard } from '../../clipboard.js';

const COPIED_MESSAGE_MS = 1500;

/** A button that copies a Discord report, briefly confirming. */
export function CopyReportButton({ label, getReport, isPrimary = false, isDisabled = false }) {
  const [copyStatus, setCopyStatus] = useState(null); // null | 'copied' | 'failed'

  useEffect(() => {
    if (!copyStatus) return undefined;
    const resetTimer = setTimeout(() => setCopyStatus(null), COPIED_MESSAGE_MS);
    return () => clearTimeout(resetTimer);
  }, [copyStatus]);

  const handleClick = async () => {
    const report = getReport();
    setCopyStatus(report && (await copyToClipboard(report)) ? 'copied' : 'failed');
  };

  return (
    <button type="button" className={isPrimary ? 'button-primary' : undefined} disabled={isDisabled} onClick={handleClick}>
      {copyStatus === 'copied' ? 'Copied!' : copyStatus === 'failed' ? 'Copy Failed' : label}
    </button>
  );
}
