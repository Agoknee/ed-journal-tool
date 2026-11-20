#!/usr/bin/env node
/**
 * Entry point. The warning filter has to be installed before node:sqlite is loaded, and
 * built-in modules load before any static-import module code runs, so the app is imported dynamically.
 */
import './suppress-experimental-warning.mjs';

await import('./app.mjs');
