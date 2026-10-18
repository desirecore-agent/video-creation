/** 独立浏览器保留本地偏好；嵌入时仅临时采用宿主已解析的明暗主题。 */
import React from 'react';
import { getHostAppearance, subscribeHostAppearance } from '../../lib/host-appearance.ts';

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'openfilm.theme';
const dark = () => window.matchMedia('(prefers-color-scheme: dark)');

function saved(): ThemeMode {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'system' ? value : 'dark';
  } catch { return 'dark'; }
}

function apply(mode: ThemeMode) {
  if (getHostAppearance()) return;
  document.documentElement.dataset.theme = mode === 'system' ? (dark().matches ? 'dark' : 'light') : mode;
}

export function applySavedTheme(): void { apply(saved()); }

const listeners = new Set<() => void>();

/* "System" follows the system while Studio is open, not only when it starts */
if (typeof window !== 'undefined') dark().addEventListener('change', () => { if (saved() === 'system') apply('system'); });
/* a theme chosen in another of Studio's pages (another tab of the app, another window) is this one's too */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    apply(saved());
    for (const listener of listeners) listener();
  });
}

export function setThemeMode(mode: ThemeMode) {
  try { localStorage.setItem(KEY, mode); } catch { /* not kept past this page */ }
  apply(mode);
  for (const listener of listeners) listener();
}

/** The chosen theme and a way to change it; every user of it sees the change. */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = React.useSyncExternalStore((on) => { listeners.add(on); return () => listeners.delete(on); }, saved, () => 'dark' as ThemeMode);
  return [mode, setThemeMode];
}

/** 设置面板只呈现实际宿主主题，避免提供当前不会生效的本地开关。 */
export function useHostTheme(): 'light' | 'dark' | null {
  const appearance = React.useSyncExternalStore(subscribeHostAppearance, getHostAppearance, () => null);
  return appearance?.colorScheme ?? null;
}
