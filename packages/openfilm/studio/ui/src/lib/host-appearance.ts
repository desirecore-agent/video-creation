/** 只接收顶层 Studio 的有限外观快照；影片与场景文档不导入此模块。 */
import type { DesirecoreAppBridge } from './desirecore-host';

/** 与 app-authoring-v1 的闭合外观合同一致；值按实际 CSS 属性验证，不执行样式文本。 */
export const HOST_APPEARANCE_PROPERTIES = {
  '--sys-label': 'color', '--sys-secondary': 'color', '--sys-tertiary': 'color', '--sys-quaternary': 'color',
  '--sys-separator': 'color', '--sys-fill': 'color',
  '--glass-white': 'color', '--glass-card': 'color', '--glass-hover': 'color', '--glass-active': 'color',
  '--glass-border': 'color', '--glass-highlight': 'color', '--glass-dim': 'color', '--glass-solid': 'color', '--glass-modal': 'color',
  '--action-primary': 'color', '--action-hover': 'color', '--action-solid': 'color', '--action-solid-hover': 'color',
  '--action-foreground': 'color', '--action-soft': 'color', '--action-border': 'color',
  '--accent-green': 'color', '--accent-blue': 'color', '--accent-purple': 'color', '--accent-orange': 'color', '--accent-red': 'color',
  '--font-sans': 'font-family',
  '--radius-sm': 'border-radius', '--radius-md': 'border-radius', '--radius-base': 'border-radius', '--radius-lg': 'border-radius',
  '--radius-xl': 'border-radius', '--radius-2xl': 'border-radius', '--radius-input': 'border-radius', '--radius-pill': 'border-radius',
  '--shadow-glass': 'box-shadow', '--shadow-glass-btn': 'box-shadow', '--shadow-float': 'box-shadow',
  '--shadow-contained-card': 'box-shadow', '--shadow-contained-popover': 'box-shadow',
  '--scroll-thumb': 'color', '--scroll-thumb-hover': 'color',
} as const;

type HostToken = keyof typeof HOST_APPEARANCE_PROPERTIES;
export interface HostAppearance {
  schemaVersion: 1;
  colorScheme: 'light' | 'dark';
  tokens: Record<HostToken, string>;
}
type SupportsCss = (property: string, value: string) => boolean;
const tokenNames = Object.keys(HOST_APPEARANCE_PROPERTIES) as HostToken[];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** 未知字段、引用、资源 URL 与无效 CSS 都整份拒绝，保留当前有效主题。 */
export function parseHostAppearance(value: unknown, supports: SupportsCss): HostAppearance | null {
  if (!record(value) || value.schemaVersion !== 1 || (value.colorScheme !== 'light' && value.colorScheme !== 'dark')
    || Object.keys(value).some((key) => !['schemaVersion', 'colorScheme', 'tokens'].includes(key)) || !record(value.tokens)) return null;
  const input = value.tokens;
  if (Object.keys(input).length !== tokenNames.length || Object.keys(input).some((key) => !Object.hasOwn(HOST_APPEARANCE_PROPERTIES, key))) return null;
  const tokens = {} as Record<HostToken, string>;
  for (const key of tokenNames) {
    const raw = input[key];
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || /[;{}<>\\\r\n]|\b(?:url|expression|var|env)\s*\(/i.test(raw)
      || /^(?:inherit|initial|unset|revert(?:-layer)?)$/i.test(raw.trim()) || !supports(HOST_APPEARANCE_PROPERTIES[key], raw)) return null;
    tokens[key] = raw.trim();
  }
  return { schemaVersion: 1, colorScheme: value.colorScheme, tokens };
}

interface AppearanceTarget {
  dataset: { theme?: string; hostAppearance?: string; hostAppearanceRevision?: string; appearancePending?: string };
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}
interface AppearanceOptions {
  bridge: DesirecoreAppBridge | undefined;
  isTopLevel: boolean;
  target: AppearanceTarget;
  supports: SupportsCss;
  onChange?: (appearance: HostAppearance | null) => void;
  fallback: () => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** 先订阅再连接；较新的事件绝不能被较早 connect 的异步返回覆盖。 */
export function connectHostAppearance(options: AppearanceOptions): () => void {
  const { bridge, target } = options;
  if (!options.isTopLevel || !bridge) { delete target.dataset.appearancePending; return () => {}; }
  let disposed = false, eventVersion = 0, appearanceRevision = 0, applied = false;
  const finishPending = () => { delete target.dataset.appearancePending; };
  const apply = (value: unknown): boolean => {
    const appearance = parseHostAppearance(value, options.supports);
    if (!appearance || disposed) return false;
    for (const key of tokenNames) target.style.setProperty(`--host-${key.slice(2)}`, appearance.tokens[key]);
    target.dataset.theme = appearance.colorScheme;
    target.dataset.hostAppearance = 'true';
    target.dataset.hostAppearanceRevision = String(++appearanceRevision);
    applied = true;
    options.onChange?.(appearance);
    finishPending();
    return true;
  };
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const timer = schedule(() => { if (!disposed) finishPending(); }, 1500);
  const startedVersion = eventVersion;
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = bridge.onEvent?.((event) => {
      if (!record(event) || event.type !== 'appearance-changed') return;
      if (apply(event.appearance)) eventVersion += 1;
    });
  } catch { /* 旧宿主订阅不可用时仍尝试一次只读快照。 */ }
  Promise.resolve().then(() => disposed ? null : bridge.call('connect')).then((connection) => {
    if (disposed) return;
    if (startedVersion === eventVersion && record(connection)) apply(connection.appearance);
    finishPending();
  }, () => { if (!disposed) finishPending(); });
  return () => {
    disposed = true;
    cancel(timer);
    unsubscribe?.();
    if (applied) {
      for (const key of tokenNames) target.style.removeProperty(`--host-${key.slice(2)}`);
      delete target.dataset.hostAppearance;
      delete target.dataset.hostAppearanceRevision;
      options.onChange?.(null);
      options.fallback();
    }
    finishPending();
  };
}

let current: HostAppearance | null = null;
const listeners = new Set<() => void>();
export const getHostAppearance = (): HostAppearance | null => current;
export function subscribeHostAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 由 Studio 入口调用一次；不暴露新的桥方法，也不持久化宿主主题。 */
export function startHostAppearance(fallback: () => void): () => void {
  return connectHostAppearance({
    bridge: (window as Window & { desirecoreApp?: DesirecoreAppBridge }).desirecoreApp,
    isTopLevel: window.top === window,
    target: document.documentElement,
    supports: (property, value) => CSS.supports(property, value),
    fallback,
    onChange: (appearance) => { current = appearance; for (const listener of listeners) listener(); },
  });
}
