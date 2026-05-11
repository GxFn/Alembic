/**
 * ThemeProvider — 深色模式管理
 *
 * Usage:
 *   1. Wrap <App /> with <ThemeProvider>
 *   2. const { isDark, toggle, setTheme } = useTheme();
 *
 * 优先级: localStorage > system preference > light
 * 同步 `dark` CSS class 到 <html>，使 Tailwind `dark:` 前缀生效。
 */

import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'asd-dashboard-theme';

function getSystemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function getInitialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch { /* SSR / iframe sandbox */ }
  return 'system';
}

/* ── Context ─────────────────────────────────────────── */
interface ThemeContextValue {
  /** 当前是否处于深色模式（已解析 system） */
  isDark: boolean;
  /** 存储的主题偏好 */
  mode: ThemeMode;
  /** 切换 light ↔ dark（跳过 system） */
  toggle: () => void;
  /** 设置具体主题 */
  setTheme: (m: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/* ── Provider ────────────────────────────────────────── */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);
  const [systemDark, setSystemDark] = useState(getSystemDark);

  // 监听系统主题变化
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const isDark = mode === 'dark' ? true : mode === 'light' ? false : systemDark;

  // 同步 dark class 到 <html>
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [isDark]);

  const setTheme = useCallback((m: ThemeMode) => {
    setModeState(m);
    try { localStorage.setItem(STORAGE_KEY, m); } catch { /* noop */ }
  }, []);

  const toggle = useCallback(() => {
    setTheme(isDark ? 'light' : 'dark');
  }, [isDark, setTheme]);

  const value = useMemo(() => ({ isDark, mode, toggle, setTheme }), [isDark, mode, toggle, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/* ── Hook ────────────────────────────────────────────── */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
