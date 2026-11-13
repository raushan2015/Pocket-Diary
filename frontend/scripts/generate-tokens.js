#!/usr/bin/env node
/**
 * Generate tokens.css from design-tokens.json
 * Run: node scripts/generate-tokens.js
 */

import fs from 'fs';
import path from 'path';

const tokensPath = path.resolve(process.cwd(), 'design-tokens.json');
const outputPath = path.resolve(process.cwd(), 'css/tokens.css');

const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

function toKebabCase(str) {
  return String(str)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function flatten(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const cleanKey = toKebabCase(key);
    const newKey = prefix ? (cleanKey === '' ? prefix : `${prefix}-${cleanKey}`) : cleanKey;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flatten(value, newKey));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

function generateRoot(tokens) {
  const flat = flatten(tokens.colors.primary, 'color-primary');
  const semantic = flatten(tokens.colors.semantic, 'color');
  const brand = flatten(tokens.colors.brand, 'color');
  const typography = {
    ...flatten(tokens.typography.fontFamilies, 'font'),
    ...flatten(tokens.typography.fontSizes, 'font-size'),
    ...flatten(tokens.typography.fontWeights, 'font-weight')
  };
  const radii = flatten(tokens.radii, 'radius');
  const shadows = flatten(tokens.shadows, 'shadow');
  const transitions = flatten(tokens.transitions, 'transition');
  const zIndex = flatten(tokens.zIndex, 'z');

  const all = { ...flat, ...semantic, ...brand, ...typography, ...radii, ...shadows, ...transitions, ...zIndex };

  let css = '/* ==========================================================================\n';
  css += '   Pocket Diary SaaS Design System Tokens (GENERATED from design-tokens.json)\n';
  css += '   Do not edit directly — edit design-tokens.json and run: node scripts/generate-tokens.js\n';
  css += '   ========================================================================== */\n\n';
  css += ':root {\n';
  for (const [key, value] of Object.entries(all)) {
    css += `  --${key}: ${value};\n`;
  }
  css += '}\n\n';

  // Light theme
  css += '/* ==========================================================================\n';
  css += '   Light Mode Theme (Default)\n';
  css += '   ========================================================================== */\n';
  css += ':root,\n[data-theme="light"] {\n';
  for (const [key, value] of Object.entries(tokens.themes.light)) {
    if (key === 'colorScheme') {
      css += `  color-scheme: ${value};\n`;
    } else if (key !== 'semanticOverrides') {
      css += `  --${toKebabCase(key)}: ${value};\n`;
    }
  }
  css += '}\n\n';

  // Dark theme
  css += '/* ==========================================================================\n';
  css += '   Dark Mode Theme\n';
  css += '   ========================================================================== */\n';
  css += '[data-theme="dark"] {\n';
  for (const [key, value] of Object.entries(tokens.themes.dark)) {
    if (key === 'colorScheme') {
      css += `  color-scheme: ${value};\n`;
    } else if (key !== 'semanticOverrides') {
      css += `  --${toKebabCase(key)}: ${value};\n`;
    }
  }
  // Semantic overrides for dark mode
  if (tokens.themes.dark.semanticOverrides) {
    for (const [semanticKey, overrides] of Object.entries(tokens.themes.dark.semanticOverrides)) {
      for (const [prop, value] of Object.entries(overrides)) {
        css += `  --color-${toKebabCase(semanticKey)}-${toKebabCase(prop)}: ${value};\n`;
      }
    }
  }
  css += '}\n';

  return css;
}

const css = generateRoot(tokens);
fs.writeFileSync(outputPath, css);
console.log(`Generated ${outputPath}`);