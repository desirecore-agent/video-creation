/** Debounced project style saves carry the exact version observed by this editor.
 * Serialize this editor's requests; conflicts retain the draft and stop autosave until reopen/merge.
 */
import * as React from 'react';
import {
  fetchSubtitleStyle, readLastSubtitleStyle, saveSubtitleStyle, SUBTITLE_DEFAULT,
  writeLastSubtitleStyle, type SubtitleStyle, type SubtitleStyleFrom,
} from './subtitles';

const SAVE_DEBOUNCE_MS = 500;
const startingStyle = (): SubtitleStyle => readLastSubtitleStyle() ?? SUBTITLE_DEFAULT;

export function useSubtitleStyle(projectId: string): [SubtitleStyle, React.Dispatch<React.SetStateAction<SubtitleStyle>>, string | null] {
  const [style, setStyle] = React.useState<SubtitleStyle>(startingStyle);
  const [error, setError] = React.useState<string | null>(null);
  const saved = React.useRef<string | null>(null);
  const from = React.useRef<SubtitleStyleFrom | null>(null);
  const generation = React.useRef(0);
  const pending = React.useRef<Promise<void>>(Promise.resolve());
  const styleRef = React.useRef(style);
  styleRef.current = style;

  React.useEffect(() => {
    const gen = ++generation.current;
    saved.current = null;
    from.current = null;
    pending.current = Promise.resolve();
    setError(null);
    const start = startingStyle();
    const startJson = JSON.stringify(start);
    setStyle(start);
    const ask = new AbortController();
    fetchSubtitleStyle(projectId, ask.signal).then((snapshot) => {
      if (ask.signal.aborted || generation.current !== gen) return;
      const dirty = JSON.stringify(styleRef.current) !== startJson;
      from.current = snapshot.from;
      if (snapshot.style && !dirty) setStyle(snapshot.style);
      saved.current = dirty ? '' : JSON.stringify(snapshot.style ?? start);
      if (!snapshot.from) setError('未取得字幕样式保存版本；草稿未保存，请重新打开项目核对。');
      if (dirty) setStyle((s) => ({ ...s }));
    }, () => {
      if (!ask.signal.aborted && generation.current === gen) setError('字幕样式读取失败；未写入，请重新打开项目。');
    });
    return () => { ask.abort(); ++generation.current; };
  }, [projectId]);

  React.useEffect(() => {
    if (saved.current === null || !from.current) return undefined;
    const next = JSON.stringify(style);
    // Compare with saved only inside the queue: an inflight write may replace it
    // before this draft runs, even when the person has returned to the original value.
    const gen = generation.current;
    const timer = setTimeout(() => {
      pending.current = pending.current.then(async () => {
        if (generation.current !== gen || !from.current || next === saved.current) return;
        try {
          const kept = await saveSubtitleStyle(projectId, style, from.current);
          if (generation.current !== gen) return;
          from.current = kept.from;
          saved.current = next;
          writeLastSubtitleStyle(kept.style ?? style);
        } catch (e) {
          if (generation.current !== gen) return;
          // Do not fetch a fresh token and replay this stale draft, even after a network timeout.
          from.current = null;
          setError(e instanceof Error ? e.message : '字幕样式未保存；请保留草稿并重新打开项目核对。');
        }
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, style]);

  return [style, setStyle, error];
}
