/**
 * node:sqlite prints an "experimental feature" warning on Node 22. This module must be imported
 * before anything that loads node:sqlite so the console only shows the app's own status messages.
 */
const originalEmitWarning = process.emitWarning;

process.emitWarning = function emitWarningExceptSqlite(warning, ...otherArguments) {
  const warningText = typeof warning === 'string' ? warning : warning?.message;
  const warningType = typeof otherArguments[0] === 'string' ? otherArguments[0] : otherArguments[0]?.type;
  if (warningType === 'ExperimentalWarning' && warningText?.includes('SQLite')) return;
  return originalEmitWarning.call(process, warning, ...otherArguments);
};
