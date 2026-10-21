/**
 * Theme context. Resolves the semantic theme from the user preference
 * ('system' | 'light' | 'dark', persisted in PrefsStore) and exposes it to
 * every component via useTheme().
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { resolveTheme, type Theme, type ThemeName } from './themes';
import type { PrefsStore } from '@/services/storage/kv';
import { readJson, writeJson } from '@/services/storage/kv';

const THEME_PREF_KEY = 'prefs.theme';

interface ThemeContextValue {
  theme: Theme;
  preference: ThemeName;
  setPreference(pref: ThemeName): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ prefs, children }: { prefs: PrefsStore; children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemeName>('system');

  useEffect(() => {
    let cancelled = false;
    readJson<ThemeName>(prefs, THEME_PREF_KEY).then((stored) => {
      if (!cancelled && stored) setPreferenceState(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [prefs]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: resolveTheme(preference, systemScheme === 'dark'),
      preference,
      setPreference(pref: ThemeName) {
        setPreferenceState(pref);
        void writeJson(prefs, THEME_PREF_KEY, pref);
      },
    }),
    [preference, systemScheme, prefs],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx.theme;
}

export function useThemePreference(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemePreference must be used inside ThemeProvider');
  return ctx;
}
