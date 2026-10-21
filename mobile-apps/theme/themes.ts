/**
 * Semantic theme layer: purpose-named colors derived from primitives, with
 * full light and dark sets. Components only ever reference semantic names.
 * Contrast has been checked against WCAG AA for all text/bg pairings in use.
 */
import {
  fontSize,
  fontWeight,
  iconSize,
  minTouchTarget,
  noteColorDark,
  noteColorLight,
  noteInkDark,
  noteInkLight,
  radii,
  spacing,
  duration,
  type NoteColorId,
} from './tokens';

export interface Theme {
  dark: boolean;
  colors: {
    bg: string;
    surface: string;
    surfaceAlt: string;
    border: string;
    text: string;
    textSubtle: string;
    primary: string;
    primaryText: string;
    primarySoft: string;
    danger: string;
    dangerSoft: string;
    success: string;
    successSoft: string;
    warning: string;
    warningSoft: string;
    offline: string;
    syncBadge: string;
    scrim: string;
  };
  note: Record<NoteColorId, string>;
  noteInk: Record<NoteColorId, string>;
  spacing: typeof spacing;
  radii: typeof radii;
  font: typeof fontSize;
  weight: typeof fontWeight;
  icon: typeof iconSize;
  touch: number;
  duration: typeof duration;
}

const light: Theme = {
  dark: false,
  colors: {
    bg: '#F4F4F5',
    surface: '#FFFFFF',
    surfaceAlt: '#EFEFF1',
    border: '#E4E4E7',
    text: '#18181B',
    textSubtle: '#52525B',
    primary: '#4F46E5',
    primaryText: '#FFFFFF',
    primarySoft: '#EEF2FF',
    danger: '#DC2626',
    dangerSoft: '#FEF2F2',
    success: '#15803D',
    successSoft: '#F0FDF4',
    warning: '#B45309',
    warningSoft: '#FFFBEB',
    offline: '#92400E',
    syncBadge: '#6B7280',
    scrim: 'rgba(9, 9, 11, 0.45)',
  },
  note: { ...noteColorLight },
  noteInk: { ...noteInkLight },
  spacing,
  radii,
  font: fontSize,
  weight: fontWeight,
  icon: iconSize,
  touch: minTouchTarget,
  duration,
};

const dark: Theme = {
  dark: true,
  colors: {
    bg: '#0B0B0E',
    surface: '#17171B',
    surfaceAlt: '#202027',
    border: '#2E2E36',
    text: '#F4F4F5',
    textSubtle: '#A1A1AA',
    primary: '#818CF8',
    primaryText: '#0B0B0E',
    primarySoft: '#1E1B4B',
    danger: '#F87171',
    dangerSoft: '#3F1618',
    success: '#4ADE80',
    successSoft: '#0F2A1A',
    warning: '#FBBF24',
    warningSoft: '#3F2A0C',
    offline: '#FBBF24',
    syncBadge: '#A1A1AA',
    scrim: 'rgba(0, 0, 0, 0.6)',
  },
  note: { ...noteColorDark },
  noteInk: { ...noteInkDark },
  spacing,
  radii,
  font: fontSize,
  weight: fontWeight,
  icon: iconSize,
  touch: minTouchTarget,
  duration,
};

export const themes = { light, dark };
export type ThemeName = 'system' | 'light' | 'dark';

export function resolveTheme(preference: ThemeName, systemDark: boolean): Theme {
  if (preference === 'light') return light;
  if (preference === 'dark') return dark;
  return systemDark ? dark : light;
}
