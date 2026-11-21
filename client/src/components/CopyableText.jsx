import { useEffect, useState } from 'react';
import { copyToClipboard } from '../clipboard.js';

const COPIED_MESSAGE_MS = 1200;

/**
 * Text that copies a value to the clipboard when clicked, briefly showing "Copied".
 * @param {{ copyText: string, title?: string, children: React.ReactNode }} props  title is shown above the copy hint on hover
 */
export default function CopyableText({ copyText, title, children }) {
  const [copyStatus, setCopyStatus] = useState(null); // null | 'copied' | 'failed'

  useEffect(() => {
    if (!copyStatus) return undefined;
    const resetTimer = setTimeout(() => setCopyStatus(null), COPIED_MESSAGE_MS);
    return () => clearTimeout(resetTimer);
  }, [copyStatus]);

  const handleClick = async (clickEvent) => {
    clickEvent.stopPropagation();
    setCopyStatus((await copyToClipboard(String(copyText))) ? 'copied' : 'failed');
  };

  return (
    <button type="button" className="copyable" onClick={handleClick} title={`${title ? `${title}\n` : ''}Click to copy: ${copyText}`}>
      {children}
      {copyStatus && <span className={`copy-status copy-status-${copyStatus}`}>{copyStatus === 'copied' ? 'Copied' : 'Copy failed'}</span>}
    </button>
  );
}
