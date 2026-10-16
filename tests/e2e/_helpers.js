/**
 * Shared harness for the browser end-to-end QA suites (tests/e2e/*.test.js).
 *
 * Each journey file launches its own isolated Chromium instance through
 * launchBrowser(), so files are fully independent and can run in parallel.
 * Only 01-alice-core-journey.test.js keeps sequential shared state (journeys
 * 1–9 form one continuous story inside that single file).
 */

import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { chromium } from 'playwright';

export const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8080';

const CHROME_PATH = process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : undefined;

export const SCREENSHOT_DIR = path.resolve(process.cwd().endsWith('tests') ? '../.agents/browser' : '.agents/browser');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const DEFAULT_LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

/** Launch an isolated headless Chromium (optionally with extra Chrome flags). */
export async function launchBrowser(extraArgs = []) {
  return chromium.launch({
    headless: true,
    args: [...DEFAULT_LAUNCH_ARGS, ...extraArgs],
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
  });
}

export function buildZip(files, { deflate = false } = {}) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);

  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const rawData = encoder.encode(content);
    const method = deflate ? 8 : 0;
    const data = deflate ? zlib.deflateRawSync(Buffer.from(rawData)) : Buffer.from(rawData);
    const dataBytes = new Uint8Array(data);

    const local = [
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(0), u32(dataBytes.length), u32(rawData.length),
      u16(nameBytes.length), u16(0),
    ];
    chunks.push(...local, nameBytes, dataBytes);

    central.push({ nameBytes, size: dataBytes.length, rawSize: rawData.length, method, offset });
    offset += local.reduce((s, a) => s + a.length, 0) + nameBytes.length + dataBytes.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const entry of central) {
    const rec = [
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(entry.method), u16(0), u16(0),
      u32(0), u32(entry.size), u32(entry.rawSize),
      u16(entry.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(entry.offset),
    ];
    chunks.push(...rec, entry.nameBytes);
    centralSize += rec.reduce((s, a) => s + a.length, 0) + entry.nameBytes.length;
  }

  const eocd = [
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralSize), u32(centralStart), u16(0),
  ];
  chunks.push(...eocd);

  return Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c)));
}
