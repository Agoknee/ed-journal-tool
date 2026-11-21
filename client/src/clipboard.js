/**
 * The async Clipboard API only works in secure contexts (https or localhost), so fall back to
 * execCommand when the dashboard is opened over plain http on another address.
 */
export async function copyToClipboard(text) {
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
