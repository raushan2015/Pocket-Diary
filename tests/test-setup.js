import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

let chromium;
try {
  const pw = await import('playwright');
  chromium = pw.chromium;
} catch {
  const pw = await import('/opt/techshan/tools/npm/lib/node_modules/@playwright/mcp/node_modules/playwright/index.mjs');
  chromium = pw.chromium;
}

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const SCREENSHOT_DIR = path.resolve('.agents/browser');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

console.log('Using BASE_URL:', BASE_URL);
console.log('Using CHROME_PATH:', CHROME_PATH);
console.log('Saving screenshots to:', SCREENSHOT_DIR);
