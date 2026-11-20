#!/usr/bin/env node
/**
 * Entry point. Kept free of top-level await so the same code can be bundled into a standalone executable.
 */
import './intl-segmenter-fallback.mjs';
import { startApp } from './app.mjs';

startApp();
