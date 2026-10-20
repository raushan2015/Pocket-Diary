/**
 * Import (Account Settings)
 * - Google Keep (Takeout): reads a ZIP (Keep/*.html + labels.json) directly in the
 *   browser, or a selection of extracted .html files. Converts each Keep note into
 *   the workspace import format: titles, text content, checklists (☐/☑ preserved
 *   as native checklist items), labels, and inline images.
 * - Markdown: each .md/.markdown/.mdown file — loose or inside a ZIP — becomes a
 *   new note carrying the full document body (see md-import.js).
 * - Also accepts Notes' own JSON backups through the same flow.
 *
 * No external dependencies: ZIP entries are read with a minimal reader built on
 * DecompressionStream('deflate-raw') (supported by all modern browsers).
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { isMarkdownFileName, parseMarkdownNote } from './md-import.js';

const CHECKBOX_UNCHECKED = '\u2610'; // ☐
const CHECKBOX_CHECKED = '\u2611'; // ☑
const MAX_EMBED_IMAGE_BYTES = 800 * 1024; // embed images up to 800 KB into the note

/** Base64 without blowing the call stack on large buffers. */
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ==========================================================================
// Minimal ZIP reader (stored + deflate)
// ==========================================================================

async function inflateRaw(bytes) {
  if ('DecompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('This browser cannot extract ZIP files. Please upload the extracted .html files instead.');
}

function readU16(view, offset) { return view.getUint16(offset, true); }
function readU32(view, offset) { return view.getUint32(offset, true); }

/**
 * Extract all entries of a ZIP file into a Map<lowercaseName, Uint8Array>.
 */
export async function readZipEntries(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer);

  // Locate the End Of Central Directory record (scan backwards, max 64KB comment)
  let eocd = -1;
  const minEocd = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid ZIP archive');

  const entryCount = readU16(view, eocd + 10);
  let offset = readU32(view, eocd + 16);

  const entries = new Map();
  for (let i = 0; i < entryCount; i++) {
    if (readU32(view, offset) !== 0x02014b50) break; // central directory header
    const method = readU16(view, offset + 10);
    const compressedSize = readU32(view, offset + 20);
    const nameLength = readU16(view, offset + 28);
    const extraLength = readU16(view, offset + 30);
    const commentLength = readU16(view, offset + 32);
    const localOffset = readU32(view, offset + 42);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder().decode(nameBytes).replace(/\\/g, '/');

    // Local file header: skip to the data
    if (readU32(view, localOffset) === 0x04034b50) {
      const lhNameLength = readU16(view, localOffset + 26);
      const lhExtraLength = readU16(view, localOffset + 28);
      const dataStart = localOffset + 30 + lhNameLength + lhExtraLength;
      let data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 8) {
        data = await inflateRaw(data);
      } else if (method !== 0) {
        throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
      }
      if (!name.endsWith('/')) {
        entries.set(name.toLowerCase(), data);
      }
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ==========================================================================
// Google Keep HTML parsing
// ==========================================================================

// ==========================================================================
// Google Keep Takeout JSON metadata (audit M-17)
// ==========================================================================

/**
 * Takeout exports each note twice: `Note.html` (rendered content) and
 * `Note.json` (metadata). The JSON carries `color`, `isPinned`,
 * `isArchived` and — crucially — `isTrashed`, none of which exist in the
 * HTML. Previously the JSON files were ignored entirely: trashed notes came
 * back as active notes and colors/pinned state was dropped.
 */
export function parseKeepJsonMetadata(jsonText) {
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object') return null;
    const keepColor = typeof parsed.color === 'string' ? parsed.color.trim().toLowerCase() : '';
    return {
      color: keepColor && keepColor !== 'default' ? keepColor : undefined,
      isPinned: parsed.isPinned === true,
      isArchived: parsed.isArchived === true,
      isTrashed: parsed.isTrashed === true,
    };
  } catch {
    return null;
  }
}

/** Map of lowercased base name → parsed JSON metadata, from a Takeout archive. */
function collectKeepJsonMetadata(entries, decoder) {
  const metadata = new Map();
  for (const name of entries.keys()) {
    if (!/\.json$/i.test(name)) continue;
    if (/(^|\/)labels\.json$/i.test(name)) continue; // label list, not a note
    const meta = parseKeepJsonMetadata(decoder.decode(entries.get(name)));
    if (meta) metadata.set(baseNameOf(name).toLowerCase(), meta);
  }
  return metadata;
}

function isCheckboxLine(text) {
  return text.startsWith(CHECKBOX_UNCHECKED) || text.startsWith(CHECKBOX_CHECKED);
}

/**
 * Parse one Keep Takeout HTML document into an import-ready note.
 */
export function parseKeepHtml(htmlText, fallbackTitle) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');

  const rawTitle = doc.querySelector('title')?.textContent?.trim() || '';
  const title = rawTitle || fallbackTitle || 'Untitled note';

  // Collect body lines in document order. Takeout emits each note line as a
  // direct <div> (or <p>) child of body; checklists come as <li> with ☐/☑ prefixes.
  const lines = [];
  const body = doc.body;
  const walk = (element) => {
    for (const child of element.children) {
      const tag = child.tagName;
      if (tag === 'UL' || tag === 'OL') {
        for (const li of child.querySelectorAll(':scope > li')) {
          const text = li.textContent.replace(/\u00a0/g, ' ').trim();
          if (text) lines.push({ kind: isCheckboxLine(text) ? 'check' : 'line', text });
        }
      } else if (tag === 'DIV' || tag === 'P') {
        const text = child.textContent.replace(/\u00a0/g, ' ').trim();
        if (text) lines.push({ kind: 'line', text });
      } else if (tag === 'BR') {
        lines.push({ kind: 'line', text: '' });
      }
    }
  };
  if (body) walk(body);
  // Some exports put everything into one text blob without wrappers
  if (!lines.length && body?.textContent?.trim()) {
    for (const raw of body.textContent.split(/\n+/)) {
      const text = raw.replace(/\u00a0/g, ' ').trim();
      if (text) lines.push({ kind: isCheckboxLine(text) ? 'check' : 'line', text });
    }
  }

  const checklistItems = [];
  const textLines = [];
  for (const line of lines) {
    if (line.kind === 'check') {
      const checked = line.text.startsWith(CHECKBOX_CHECKED);
      const text = line.text.slice(1).trim();
      checklistItems.push({ id: `keep_${Math.random().toString(36).slice(2, 10)}`, text, checked });
    } else if (line.text) {
      textLines.push(line.text);
    }
  }

  // Inline images referenced by the note (Takeout stores them next to the HTML)
  const imageNames = [];
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (src && !/^(https?|data):/i.test(src)) {
      imageNames.push(decodeURIComponent(src.replace(/^.*\//, '')));
    }
  }

  const isChecklist = checklistItems.length > 0;
  return {
    title,
    content: textLines.join('\n'),
    noteType: isChecklist ? 'checklist' : 'text',
    checklistData: isChecklist ? checklistItems : undefined,
    imageNames,
  };
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function baseNameOf(name) {
  return name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
}

function detectMime(name) {
  const ext = extensionOf(name);
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'application/octet-stream';
}

// ==========================================================================
// Import orchestration
// ==========================================================================

export function isTakeoutZipFile(file) {
  return /\.zip$/i.test(file.name);
}

/**
 * Convert parsed Markdown documents ({ name, text }) into import-ready notes.
 * Empty files are skipped — there is nothing to import.
 */
function buildMarkdownNotes(items) {
  const notes = [];
  for (const item of items) {
    const note = parseMarkdownNote(item.text, baseNameOf(item.name));
    if (!note.content.trim()) continue;
    notes.push(note);
  }
  return notes;
}

/**
 * Build an import payload from a Takeout ZIP (in memory).
 */
export async function buildPayloadFromTakeoutZip(file) {
  const entries = await readZipEntries(await file.arrayBuffer());

  const htmlFiles = [...entries.keys()].filter((n) => extensionOf(n) === 'html' || extensionOf(n) === 'htm');
  if (!htmlFiles.length) {
    // Not a Keep export — a ZIP of Markdown notes goes through the same flow
    const mdFiles = [...entries.keys()].filter((n) => isMarkdownFileName(n));
    if (mdFiles.length) {
      const decoder = new TextDecoder();
      const notes = buildMarkdownNotes(mdFiles.map((name) => ({ name, text: decoder.decode(entries.get(name)) })));
      if (!notes.length) {
        throw new Error('The Markdown files inside this ZIP are empty.');
      }
      return { notes, labels: [], embeddedImages: 0, skippedImages: 0, source: 'markdown' };
    }
    throw new Error('No .html or .md note files found inside this ZIP. Make sure it is the Keep folder from Google Takeout, or a ZIP of Markdown notes.');
  }

  const decoder = new TextDecoder();
  // Audit M-17: note metadata from the sibling .json files (color, pinned,
  // archived, trashed) — previously dropped on the floor.
  const jsonMetadata = collectKeepJsonMetadata(entries, decoder);

  const labels = [];
  for (const name of entries.keys()) {
    if (/(^|\/)labels\.json$/i.test(name)) {
      try {
        const parsed = JSON.parse(decoder.decode(entries.get(name)));
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const label = typeof item === 'string' ? item : item?.name;
            if (label && typeof label === 'string' && label.trim()) labels.push(label.trim());
          }
        }
      } catch { /* malformed labels.json — continue without labels */ }
      break;
    }
  }

  const notes = [];
  let embeddedImages = 0;
  let skippedImages = 0;

  for (const name of htmlFiles) {
    if (/_labels\.html$/i.test(name) || /(^|\/)index\.html$/i.test(name)) continue;
    const html = decoder.decode(entries.get(name));
    const note = parseKeepHtml(html, baseNameOf(name));
    const meta = jsonMetadata.get(baseNameOf(name).toLowerCase());

    // Audit M-17: notes that live in the Keep trash stay in the trash's home:
    // importing them as active notes resurrected deleted content.
    if (meta?.isTrashed) continue;
    if (meta) {
      if (meta.color) note.color = meta.color;
      note.isPinned = meta.isPinned;
      note.isArchived = meta.isArchived;
    }
    if (!note.title && !note.content && !(note.checklistData || []).length) continue;

    // Embed referenced images from the archive as data URIs
    const imageMarkdown = [];
    for (const imageName of note.imageNames) {
      const matches = [...entries.keys()].filter((n) => baseNameOf(n) === imageName.toLowerCase() || n.toLowerCase().endsWith('/' + imageName.toLowerCase()));
      const zipName = matches[0];
      const data = zipName ? entries.get(zipName) : null;
      if (!data) continue;
      if (data.length > MAX_EMBED_IMAGE_BYTES) { skippedImages++; continue; }
      const base64 = bytesToBase64(new Uint8Array(data));
      imageMarkdown.push(`![${imageName.replace(/[[\]()]/g, '_')}](data:${detectMime(zipName)};base64,${base64})`);
      embeddedImages++;
    }
    if (imageMarkdown.length) {
      note.content = note.content ? `${note.content}\n\n${imageMarkdown.join('\n\n')}` : imageMarkdown.join('\n\n');
    }

    notes.push({
      title: note.title,
      content: note.content,
      noteType: note.noteType,
      ...(note.checklistData ? { checklistData: note.checklistData } : {}),
      ...(note.color ? { color: note.color } : {}),
      ...(note.isPinned !== undefined ? { isPinned: note.isPinned } : {}),
      ...(note.isArchived !== undefined ? { isArchived: note.isArchived } : {}),
    });
  }

  const trashedCount = [...jsonMetadata.values()].filter((m) => m.isTrashed).length;

  return { notes, labels, embeddedImages, skippedImages, source: 'keep', trashedCount };
}

/**
 * Build an import payload from loose files (Keep .html files, Markdown .md files,
 * or a Notes JSON backup).
 */
export async function buildPayloadFromLooseFiles(fileList) {
  const files = Array.from(fileList || []);

  const jsonFile = files.find((f) => extensionOf(f.name) === 'json');
  const htmlFiles = files.filter((f) => ['html', 'htm'].includes(extensionOf(f.name)));
  const mdFiles = files.filter((f) => isMarkdownFileName(f.name));

  if (jsonFile && !htmlFiles.length && !mdFiles.length) {
    // Notes' own JSON backup (array of memos or { memos, categories, tags })
    const parsed = JSON.parse(await jsonFile.text());
    if (Array.isArray(parsed)) return { backupPayload: { memos: parsed } };
    if (parsed && typeof parsed === 'object') {
      return { backupPayload: { memos: parsed.memos || [], categories: parsed.categories || [], tags: parsed.tags || [] } };
    }
    throw new Error('Unrecognized JSON backup format');
  }

  if (!htmlFiles.length && !mdFiles.length) {
    throw new Error('Select a Google Takeout .zip file, extracted Keep .html files, a Pocket Diary JSON backup, or Markdown (.md) files.');
  }

  // Audit M-17: extracted Keep folders carry the same Note.json metadata files
  // as the archive — merge color/pinned/archived/trashed into the HTML notes.
  const jsonFiles = files.filter((f) => extensionOf(f.name) === 'json');
  const looseJsonMetadata = new Map();
  for (const jf of jsonFiles) {
    const meta = parseKeepJsonMetadata(await jf.text());
    if (meta) looseJsonMetadata.set(baseNameOf(jf.name).toLowerCase(), meta);
  }

  const notes = [];
  let trashedCount = 0;
  for (const file of htmlFiles) {
    const note = parseKeepHtml(await file.text(), baseNameOf(file.name));
    const meta = looseJsonMetadata.get(baseNameOf(file.name).toLowerCase());
    if (meta?.isTrashed) { trashedCount++; continue; }
    if (meta) {
      if (meta.color) note.color = meta.color;
      note.isPinned = meta.isPinned;
      note.isArchived = meta.isArchived;
    }
    if (!note.title && !note.content && !(note.checklistData || []).length) continue;
    notes.push({
      title: note.title,
      content: note.content,
      noteType: note.noteType,
      ...(note.checklistData ? { checklistData: note.checklistData } : {}),
      ...(note.color ? { color: note.color } : {}),
      ...(note.isPinned !== undefined ? { isPinned: note.isPinned } : {}),
      ...(note.isArchived !== undefined ? { isArchived: note.isArchived } : {}),
    });
  }
  for (const file of mdFiles) {
    const note = parseMarkdownNote(await file.text(), baseNameOf(file.name));
    if (!note.content.trim()) continue;
    notes.push(note);
  }

  const source = htmlFiles.length && mdFiles.length ? 'mixed' : (mdFiles.length ? 'markdown' : 'keep');
  return { notes, labels: [], embeddedImages: 0, skippedImages: 0, source, trashedCount };
}

/**
 * Run the import against the active workspace. Returns a result summary.
 */
export async function importIntoWorkspace(prepared) {
  const activeWs = state.get('activeWorkspace');
  if (!activeWs?.id) throw new Error('Select a workspace first');

  if (prepared.backupPayload) {
    const res = await api.importLocal({ workspaceId: activeWs.id, ...prepared.backupPayload });
    return { memos: res.importedMemos, labels: (res.importedTags || 0) + (res.importedCategories || 0), keepImport: false };
  }

  if (!prepared.notes.length) {
    throw new Error('No importable notes were found in the selected files');
  }

  const payload = {
    workspaceId: activeWs.id,
    memos: prepared.notes,
    tags: prepared.labels,
  };
  const res = await api.importLocal(payload);
  return {
    memos: res.importedMemos,
    labels: res.importedTags,
    keepImport: true,
    embeddedImages: prepared.embeddedImages || 0,
    skippedImages: prepared.skippedImages || 0,
  };
}
