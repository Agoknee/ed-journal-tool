import { useEffect, useState } from 'react';

const COPIED_MESSAGE_MS = 1200;

/**
 * Text that copies a value to the clipboard when clicked, briefly showing "Copied".
 * @param {{ copyText: string, children: React.ReactNode }} props
 */
export default function CopyableText({ copyText, children }) {
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
    <button type="button" className="copyable" onClick={handleClick} title={`Click to copy: ${copyText}`}>
      {children}
      {copyStatus && <span className={`copy-status copy-status-${copyStatus}`}>{copyStatus === 'copied' ? 'Copied' : 'Copy failed'}</span>}
    </button>
  );
}

/**
 * The async Clipboard API only works in secure contexts (https or localhost), so fall back to
 * execCommand when the dashboard is opened over plain http on another address.
 */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy approach.
  }

  const hiddenTextArea = document.createElement('textarea');
  hiddenTextArea.value = text;
  hiddenTextArea.setAttribute('readonly', '');
  hiddenTextArea.style.position = 'fixed';
  hiddenTextArea.style.opacity = '0';
  document.body.appendChild(hiddenTextArea);
  hiddenTextArea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    hiddenTextArea.remove();
  }
}
