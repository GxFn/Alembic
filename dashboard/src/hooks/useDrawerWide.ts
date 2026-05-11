/**
 * useDrawerWide — 抽屉面板宽模式偏好
 *
 * 持久化到 localStorage，跨 session 记忆用户选择。
 * 宽模式下主抽屉和第二抽屉都使用更大宽度。
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'alembic-drawer-wide';

function readPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function useDrawerWide() {
  const [isWide, setIsWide] = useState(readPref);

  const toggle = useCallback(() => {
    setIsWide(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  return { isWide, toggle } as const;
}
