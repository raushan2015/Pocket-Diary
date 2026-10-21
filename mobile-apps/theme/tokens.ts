/**
 * Design tokens — primitive layer.
 * Raw values only; no component may reference another component's values.
 * Mirrors the backend's note-color palette so local cards and server state
 * always agree.
 */

export const spacing = {
  /** 4pt grid */
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/** iOS-flavored type scale (pt), all scalable by the OS setting. */
export const fontSize = {
  caption: 12,
  body: 15,
  callout: 14,
  headline: 17,
  title3: 20,
  title2: 22,
  title1: 28,
} as const;

export const fontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

export const iconSize = {
  sm: 16,
  md: 22,
  lg: 28,
} as const;

export const duration = {
  fast: 120,
  base: 200,
  slow: 350,
} as const;

/** Minimum touch target (Apple HIG / Material). */
export const minTouchTarget = 44;

/** The backend's note palette ids (memo.service.ts VALID_MEMO_COLORS). */
export const NOTE_COLORS = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'darkblue',
  'purple',
  'pink',
  'brown',
  'gray',
] as const;

export type NoteColorId = (typeof NOTE_COLORS)[number];

/**
 * Light-mode swatch per palette id. Dark-mode variants live in
 * theme/tokens-dark.ts and are selected by ThemeProvider.
 */
export const noteColorLight: Record<NoteColorId, string> = {
  default: '#FFFFFF',
  red: '#FECACA',
  orange: '#FED7AA',
  yellow: '#FEF3C7',
  green: '#BBF7D0',
  teal: '#A7F3D0',
  blue: '#BFDBFE',
  darkblue: '#C7D2FE',
  purple: '#E9D5FF',
  pink: '#FBCFE8',
  brown: '#D6C7B0',
  gray: '#E5E7EB',
};

export const noteColorDark: Record<NoteColorId, string> = {
  default: '#27272A',
  red: '#5B1D1D',
  orange: '#5C2E0C',
  yellow: '#55420C',
  green: '#14351F',
  teal: '#0E3A30',
  blue: '#122B45',
  darkblue: '#1E2448',
  purple: '#331C4E',
  pink: '#4A1F36',
  brown: '#3B2A18',
  gray: '#33363B',
};

/** Ink color that stays readable on top of each swatch (light theme). */
export const noteInkLight: Record<NoteColorId, string> = {
  default: '#27272A',
  red: '#7F1D1D',
  orange: '#7C2D12',
  yellow: '#713F12',
  green: '#14532D',
  teal: '#115E59',
  blue: '#1E3A8A',
  darkblue: '#312E81',
  purple: '#581C87',
  pink: '#831843',
  brown: '#4A3417',
  gray: '#374151',
};

export const noteInkDark: Record<NoteColorId, string> = {
  ...noteInkLight,
  default: '#E4E4E7',
  gray: '#D1D5DB',
};
