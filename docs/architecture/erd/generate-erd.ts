#!/usr/bin/env tsx
/**
 * Generate Entity Relationship Diagram (ERD) from Drizzle schema.
 * Outputs: Mermaid diagram (erd.mmd), PlantUML (erd.puml), and Mermaid.js HTML for interactive viewing.
 * Run from backend directory: `tsx ../docs/architecture/erd/generate-erd.ts`
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../../../backend/src/db/schema.ts');

function parseSchema() {
  const content = readFileSync(SCHEMA_PATH, 'utf8');

  // Extract table definitions using regex
  const tables: Record<string, { columns: string[]; indexes: string[]; comment?: string }> = {};

  // Match sqliteTable calls
  const tableRegex = /export const (\w+) = sqliteTable\('(\w+)',\s*{([\s\S]*?)}(?:,\s*\(([\s\S]*?)\))?\)/g;

  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    const [, varName, tableName, columnsBlock, indexesBlock] = match;
    const columns: string[] = [];
    const indexes: string[] = [];

    // Parse columns
    const colRegex = /(\w+):\s*(\w+)\([^)]*\)/g;
    let colMatch;
    while ((colMatch = colRegex.exec(columnsBlock)) !== null) {
      const [, colName, colType] = colMatch;
      columns.push(`${colName}: ${colType}`);
    }

    // Parse indexes from the index array
    if (indexesBlock) {
      const idxRegex = /(uniqueIndex|index)\(['"]([^'"]+)['"](?:,\s*\{\s*columns:\s*\[([\s\S]*?)\]\s*\})?\)/g;
      let idxMatch;
      while ((idxMatch = idxRegex.exec(indexesBlock)) !== null) {
        const [, type, name, cols] = idxMatch;
        const columnsList = cols ? cols.replace(/\.on\(table\)\.(\w+)/g, '$1').replace(/table\./g, '') : '';
        indexes.push(`${type.toUpperCase()}: ${name} (${columnsList || 'implicit'})`);
      }
    }

    tables[varName] = { columns, indexes, tableName };
  }

  return tables;
}

function generateMermaid(tables: Record<string, { columns: string[]; indexes: string[]; tableName: string }>) {
  const lines = ['erDiagram'];

  // Define entities
  for (const [varName, { columns, tableName }] of Object.entries(tables)) {
    lines.push(`    ${varName} {`);
    for (const col of columns) {
      // Determine if PK/FK
      const isPK = col.includes('primaryKey') || col === 'id: text';
      const isFK = col.includes('references');
      const marker = isPK ? 'PK' : isFK ? 'FK' : '';
      lines.push(`        ${col} ${marker}`);
    }
    lines.push('    }');
  }

  // Define relationships
  const relationships = [
    ['users', '||--o{', 'sessions', 'userId'],
    ['users', '||--o{', 'workspaces', 'ownerId'],
    ['workspaces', '||--o{', 'workspaceMembers', 'workspaceId'],
    ['users', '||--o{', 'workspaceMembers', 'userId'],
    ['workspaces', '||--o{', 'folders', 'workspaceId'],
    ['folders', '||--o{', 'folders', 'parentId'],
    ['workspaces', '||--o{', 'categories', 'workspaceId'],
    ['workspaces', '||--o{', 'tags', 'workspaceId'],
    ['workspaces', '||--o{', 'memos', 'workspaceId'],
    ['folders', '||--o{', 'memos', 'folderId'],
    ['categories', '||--o{', 'memos', 'categoryId'],
    ['memos', '||--o{', 'memoTags', 'memoId'],
    ['tags', '||--o{', 'memoTags', 'tagId'],
    ['memos', '||--o{', 'memoVersions', 'memoId'],
    ['memos', '||--o{', 'attachments', 'memoId'],
    ['workspaces', '||--o{', 'attachments', 'workspaceId'],
    ['users', '||--o{', 'notifications', 'userId'],
    ['workspaces', '||--o{', 'notifications', 'workspaceId'],
    ['memos', '||--o{', 'notifications', 'memoId'],
    ['users', '||--o{', 'pushSubscriptions', 'userId'],
    ['workspaces', '||--o{', 'workspaceInvites', 'workspaceId'],
    ['users', '||--o{', 'workspaceInvites', 'invitedBy'],
    ['users', '||--o{', 'passwordResets', 'userId'],
  ];

  for (const [from, rel, to, label] of relationships) {
    if (tables[from] && tables[to]) {
      lines.push(`    ${from} ${rel} ${to} : "${label}"`);
    }
  }

  return lines.join('\n');
}

function generatePlantUML(tables: Record<string, { columns: string[]; indexes: string[]; tableName: string }>) {
  const lines = ['@startuml', 'skinparam linetype ortho', ''];

  // Define entities
  for (const [varName, { columns, tableName }] of Object.entries(tables)) {
    lines.push(`entity "${tableName}" as ${varName} {`);
    for (const col of columns) {
      const isPK = col.includes('primaryKey') || col === 'id: text';
      const isFK = col.includes('references');
      const marker = isPK ? ' <<PK>>' : isFK ? ' <<FK>>' : '';
      lines.push(`  ${col}${marker}`);
    }
    lines.push('}');
    lines.push('');
  }

  // Define relationships
  const relationships = [
    ['users', 'sessions', 'userId'],
    ['users', 'workspaces', 'ownerId'],
    ['workspaces', 'workspaceMembers', 'workspaceId'],
    ['users', 'workspaceMembers', 'userId'],
    ['workspaces', 'folders', 'workspaceId'],
    ['folders', 'folders', 'parentId'],
    ['workspaces', 'categories', 'workspaceId'],
    ['workspaces', 'tags', 'workspaceId'],
    ['workspaces', 'memos', 'workspaceId'],
    ['folders', 'memos', 'folderId'],
    ['categories', 'memos', 'categoryId'],
    ['memos', 'memoTags', 'memoId'],
    ['tags', 'memoTags', 'tagId'],
    ['memos', 'memoVersions', 'memoId'],
    ['memos', 'attachments', 'memoId'],
    ['workspaces', 'attachments', 'workspaceId'],
    ['users', 'notifications', 'userId'],
    ['workspaces', 'notifications', 'workspaceId'],
    ['memos', 'notifications', 'memoId'],
    ['users', 'pushSubscriptions', 'userId'],
    ['workspaces', 'workspaceInvites', 'workspaceId'],
    ['users', 'workspaceInvites', 'invitedBy'],
    ['users', 'passwordResets', 'userId'],
  ];

  for (const [from, to, label] of relationships) {
    if (tables[from] && tables[to]) {
      lines.push(`${from} ||--o{ ${to} : ${label}`);
    }
  }

  lines.push('@enduml');
  return lines.join('\n');
}

function generateMermaidHTML(mermaid: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pocket Diary - Entity Relationship Diagram</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #fafafa; }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 { color: #1a1a2e; }
    .controls { margin-bottom: 20px; }
    button { padding: 8px 16px; margin-right: 8px; border: none; border-radius: 4px; background: #2563eb; color: white; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .mermaid { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  </style>
</head>
<body>
  <div class="container">
    <h1>Pocket Diary - Entity Relationship Diagram</h1>
    <p>Generated from Drizzle ORM schema (<code>backend/src/db/schema.ts</code>)</p>
    <div class="controls">
      <button onclick="mermaid.run()">Re-render</button>
      <button onclick="downloadSVG()">Download SVG</button>
      <button onclick="downloadPNG()">Download PNG</button>
    </div>
    <div class="mermaid">
${mermaid}
    </div>
  </div>
  <script>
    mermaid.initialize({ startOnLoad: true, theme: 'default', flowchart: { useMaxWidth: true, htmlLabels: true } });
    async function downloadSVG() {
      const svg = document.querySelector('.mermaid svg');
      if (svg) {
        const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'erd.svg'; a.click();
        URL.revokeObjectURL(url);
      }
    }
    async function downloadPNG() {
      const svg = document.querySelector('.mermaid svg');
      if (svg) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        const img = new Image();
        const serializer = new XMLSerializer();
        const svgStr = serializer.serializeToString(svg);
        img.onload = () => {
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(blob => {
            const url = URL.createObjectURL(blob!);
            const a = document.createElement('a');
            a.href = url; a.download = 'erd.png'; a.click();
            URL.revokeObjectURL(url);
          });
        };
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
      }
    }
  </script>
</body>
</html>`;
}

function generateDataDictionary(tables: Record<string, { columns: string[]; indexes: string[]; tableName: string }>) {
  const lines = [
    '# Pocket Diary - Data Dictionary',
    '',
    'Generated from Drizzle ORM schema (`backend/src/db/schema.ts`)',
    '',
    '| Table | Column | Type | Constraints | Description |',
    '|-------|--------|------|-------------|-------------|',
  ];

  const descriptions: Record<string, Record<string, string>> = {
    users: {
      id: 'UUID, primary key',
      email: 'Unique, not null',
      passwordHash: 'Argon2 hash, not null',
      name: 'Display name, not null',
      avatarUrl: 'Optional profile image URL',
      timezone: 'IANA timezone, default UTC',
      status: 'active | suspended | pending_verification',
      isInstanceAdmin: 'First registered user flag (0/1)',
      createdAt: 'Unix epoch ms',
      updatedAt: 'Unix epoch ms',
    },
    sessions: {
      id: 'SHA-256 hash of session token (PK)',
      publicId: 'Opaque device identifier for revocation',
      userId: 'FK → users.id (cascade)',
      ipAddress: 'Client IP at creation',
      userAgent: 'Client user agent',
      expiresAt: 'Unix epoch ms, not null',
      createdAt: 'Unix epoch ms',
    },
    workspaces: {
      id: 'UUID, primary key',
      name: 'Workspace name, not null',
      slug: 'URL-safe unique identifier',
      ownerId: 'FK → users.id, not null',
      createdAt: 'Unix epoch ms',
      updatedAt: 'Unix epoch ms',
    },
    workspaceMembers: {
      id: 'UUID, primary key',
      workspaceId: 'FK → workspaces.id (cascade)',
      userId: 'FK → users.id (cascade)',
      role: 'owner | admin | editor | viewer',
      createdAt: 'Unix epoch ms',
    },
    folders: {
      id: 'UUID, primary key',
      workspaceId: 'FK → workspaces.id (cascade)',
      name: 'Folder name, not null',
      parentId: 'Self-referential FK (nullable)',
      createdAt: 'Unix epoch ms',
      updatedAt: 'Unix epoch ms',
    },
    categories: {
      id: 'UUID, primary key',
      workspaceId: 'FK → workspaces.id (cascade)',
      name: 'Category name, not null',
      color: 'Optional color identifier',
      icon: 'Optional icon identifier',
      createdAt: 'Unix epoch ms',
    },
    tags: {
      id: 'UUID, primary key',
      workspaceId: 'FK → workspaces.id (cascade)',
      name: 'Tag name, not null',
      createdAt: 'Unix epoch ms',
    },
    memos: {
      id: 'UUID, primary key',
      workspaceId: 'FK → workspaces.id (cascade)',
      folderId: 'FK → folders.id (set null)',
      categoryId: 'FK → categories.id (set null)',
      title: 'Note title, default empty',
      content: 'Note body (text/markdown), default empty',
      color: 'Palette color (default, red, orange, etc.)',
      theme: 'Theme identifier (default, grocery, food, etc.)',
      priority: 'low | medium | high | urgent',
      status: 'draft | pending | in_progress | completed | archived',
      isFavorite: 'Boolean flag (0/1)',
      isPinned: 'Boolean flag (0/1)',
      isArchived: 'Boolean flag (0/1)',
      noteType: 'text | checklist',
      sortOrder: 'Manual drag-drop order',
      dueDate: 'Unix epoch ms (nullable)',
      reminderTime: 'Unix epoch ms (nullable)',
      reminderLocation: 'Location string (nullable)',
      reminderSetBy: 'FK → users.id (who set the reminder)',
      collaborators: 'JSON array of collaborator emails',
      checklistData: 'JSON array of checklist items',
      linkPreviews: 'JSON array of OpenGraph previews',
      clientId: 'Idempotency key for offline creates',
      version: 'Optimistic lock counter',
      createdBy: 'FK → users.id, not null',
      createdAt: 'Unix epoch ms',
      updatedAt: 'Unix epoch ms',
      deletedAt: 'Soft delete timestamp (nullable)',
    },
    memoTags: {
      memoId: 'FK → memos.id (cascade, PK part 1)',
      tagId: 'FK → tags.id (cascade, PK part 2)',
    },
    memoVersions: {
      id: 'UUID, primary key',
      memoId: 'FK → memos.id (cascade)',
      versionNumber: 'Revision number',
      title: 'Note title at this version',
      content: 'Note content at this version',
      changedBy: 'FK → users.id',
      createdAt: 'Unix epoch ms',
    },
    attachments: {
      id: 'UUID, primary key',
      memoId: 'FK → memos.id (cascade)',
      workspaceId: 'FK → workspaces.id (cascade)',
      fileName: 'Original filename',
      fileSize: 'Bytes on disk',
      mimeType: 'MIME type (validated server-side)',
      storagePath: 'Server filesystem path',
      createdAt: 'Unix epoch ms',
    },
    notifications: {
      id: 'UUID, primary key',
      userId: 'FK → users.id (cascade)',
      workspaceId: 'FK → workspaces.id (cascade)',
      memoId: 'FK → memos.id (cascade)',
      type: 'reminder',
      title: 'Notification title',
      body: 'Notification body (nullable)',
      reminderTime: 'Source reminder timestamp',
      emailSentAt: 'Email delivery timestamp (nullable)',
      pushSentAt: 'Push delivery timestamp (nullable)',
      readAt: 'Read timestamp (nullable)',
      createdAt: 'Unix epoch ms',
    },
    pushSubscriptions: {
      id: 'UUID, primary key',
      userId: 'FK → users.id (cascade)',
      endpoint: 'Push endpoint URL (unique)',
      p256dh: 'VAPID p256dh key',
      auth: 'VAPID auth secret',
      createdAt: 'Unix epoch ms',
    },
    workspaceInvites: {
      id: 'UUID, primary key',
      workspaceId: 'FK → workspaces.id (cascade)',
      email: 'Invited email address',
      role: 'admin | editor | viewer',
      token: 'SHA-256 hash of raw token (unique)',
      status: 'pending | accepted | revoked',
      invitedBy: 'FK → users.id',
      emailSentAt: 'Email sent timestamp (nullable)',
      expiresAt: 'Unix epoch ms, not null',
      createdAt: 'Unix epoch ms',
    },
    passwordResets: {
      id: 'UUID, primary key',
      userId: 'FK → users.id (cascade)',
      tokenHash: 'SHA-256 hash of reset token (unique)',
      expiresAt: 'Unix epoch ms, not null',
      usedAt: 'Usage timestamp (nullable)',
      createdAt: 'Unix epoch ms',
    },
  };

  for (const [varName, { columns, tableName }] of Object.entries(tables)) {
    const desc = descriptions[varName] || {};
    for (const col of columns) {
      const colName = col.split(':')[0].trim();
      const colType = col.split(':').slice(1).join(':').trim();
      const colDesc = desc[colName] || '';
      lines.push(`| ${tableName} | ${colName} | ${colType} | | ${colDesc} |`);
    }
  }

  return lines.join('\n');
}

// Main
const tables = parseSchema();
const mermaid = generateMermaid(tables);
const plantuml = generatePlantUML(tables);
const html = generateMermaidHTML(mermaid);
const dictionary = generateDataDictionary(tables);

const OUT_DIR = resolve(__dirname, '../erd');
import { mkdirSync } from 'node:fs';
mkdirSync(OUT_DIR, { recursive: true });

writeFileSync(resolve(OUT_DIR, 'erd.mmd'), mermaid);
writeFileSync(resolve(OUT_DIR, 'erd.puml'), plantuml);
writeFileSync(resolve(OUT_DIR, 'erd.html'), html);
writeFileSync(resolve(OUT_DIR, 'data-dictionary.md'), dictionary);

console.log('✅ ERD generated:');
console.log(`  - ${OUT_DIR}/erd.mmd (Mermaid)`);
console.log(`  - ${OUT_DIR}/erd.puml (PlantUML)`);
console.log(`  - ${OUT_DIR}/erd.html (Interactive HTML)`);
console.log(`  - ${OUT_DIR}/data-dictionary.md (Markdown table)`);