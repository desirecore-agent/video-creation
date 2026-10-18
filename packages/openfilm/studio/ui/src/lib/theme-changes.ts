/**
 * How many times the theme (`<html data-theme>`) has changed since the page loaded, for what draws the theme's colors
 * on a canvas (the audio meters, the waveforms): a canvas keeps the colors it was drawn with, so it draws again when
 * this changes. One observer for the whole page, made when the first one asks.
 */
import React from 'react';

let changes = 0;
const listeners = new Set<() => void>();
let watching = false;

function watch(): void {
  if (watching || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  watching = true;
  // 同一明暗主题内的宿主语义色更新也需要重画 canvas。
  const signature = () => `${document.documentElement.dataset.theme}:${document.documentElement.dataset.hostAppearanceRevision ?? ''}`;
  let theme = signature();
  new MutationObserver(() => {
    if (signature() === theme) return;
    theme = signature();
    changes += 1;
    for (const fn of listeners) fn();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-host-appearance-revision'] });
}

/** A number that changes when the theme does: put it among an effect's dependencies to draw again. */
export function useThemeChanges(): number {
  return React.useSyncExternalStore(
    (fn) => { watch(); listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => changes,
    () => 0,
  );
}
