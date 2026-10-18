import test from 'node:test';
import assert from 'node:assert/strict';
import { connectHostAppearance, HOST_APPEARANCE_PROPERTIES, parseHostAppearance, startHostAppearance, type HostAppearance } from './host-appearance.ts';
import type { DesirecoreAppBridge } from './desirecore-host.ts';

const supports = (property: string, value: string) => property === 'color' ? /^(?:#|rgb)/.test(value)
  : property === 'border-radius' ? /^\d+px$/.test(value)
    : property === 'box-shadow' ? value === 'none' : value === 'system-ui, sans-serif';
function appearance(colorScheme: 'light' | 'dark' = 'dark'): HostAppearance {
  return { schemaVersion: 1, colorScheme, tokens: Object.fromEntries(Object.entries(HOST_APPEARANCE_PROPERTIES).map(([name, property]) => [name,
    property === 'color' ? (colorScheme === 'dark' ? '#222222' : '#eeeeee') : property === 'border-radius' ? '7px' : property === 'box-shadow' ? 'none' : 'system-ui, sans-serif',
  ])) as HostAppearance['tokens'] };
}
function fixture(connection: unknown = { appearance: appearance() }) {
  let onEvent: ((event: unknown) => void) | undefined;
  const writes = new Map<string, string>();
  const target = { dataset: { theme: 'light', appearancePending: 'true' } as Record<string, string>, style: {
    setProperty: (name: string, value: string) => { writes.set(name, value); }, removeProperty: (name: string) => writes.delete(name),
  } };
  let fallback = 0, unsubscribed = 0, scheduled: (() => void) | undefined;
  const order: string[] = [];
  const bridge: DesirecoreAppBridge = {
    onEvent(callback) { order.push('subscribe'); onEvent = callback; return () => { unsubscribed += 1; }; },
    async call(method) { order.push(method); return connection; },
  };
  const begin = (isTopLevel = true) => connectHostAppearance({ bridge, target, supports, isTopLevel, fallback: () => { fallback += 1; target.dataset.theme = 'light'; },
    schedule: (callback) => { scheduled = callback; return 1; }, cancel: () => {} });
  return { target, writes, begin, bridge, order, event: (value: unknown) => onEvent?.(value), timeout: () => scheduled?.(), fallback: () => fallback, unsubscribed: () => unsubscribed };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('只接受完整闭合快照，并按 CSS 属性核验每个值', () => {
  const value = appearance();
  const checked: string[] = [];
  assert.deepEqual(parseHostAppearance(value, (property, raw) => { checked.push(property); return supports(property, raw); }), value);
  assert.equal(checked.length, 43);
  assert.ok(checked.includes('font-family') && checked.includes('box-shadow') && checked.includes('border-radius'));
  assert.equal(parseHostAppearance({ ...value, colorScheme: 'system' }, supports), null);
  assert.equal(parseHostAppearance({ ...value, extra: true }, supports), null);
  assert.equal(parseHostAppearance({ ...value, tokens: { ...value.tokens, '--arbitrary': 'red' } }, supports), null);
  const missing = structuredClone(value); delete (missing.tokens as Partial<HostAppearance['tokens']>)['--sys-label'];
  assert.equal(parseHostAppearance(missing, supports), null);
});

test('非法 CSS、引用或资源输入不安装，也不污染上一次有效快照', async () => {
  const f = fixture(); f.begin(); await tick();
  for (const raw of ['url(https://example.invalid/image)', 'var(--secret)', 'red; color:blue', '</style>', 'inherit', 'x'.repeat(1025), 'not-a-color']) {
    const invalid = appearance('light'); invalid.tokens['--sys-label'] = raw;
    f.event({ type: 'appearance-changed', appearance: invalid });
    assert.equal(f.target.dataset.theme, 'dark');
    assert.equal(f.writes.get('--host-sys-label'), '#222222');
  }
  assert.ok([...f.writes.keys()].every((name) => name.startsWith('--host-')));
});

test('初始快照与热切换沿同一 document 写入；先订阅、再 connect', async () => {
  const f = fixture(); const original = f.target; f.begin(); await tick();
  assert.deepEqual(f.order, ['subscribe', 'connect']);
  assert.equal(f.target, original);
  assert.equal(f.target.dataset.theme, 'dark');
  assert.equal(f.target.dataset.appearancePending, undefined);
  f.event({ type: 'appearance-changed', appearance: appearance('light') });
  assert.equal(f.target.dataset.theme, 'light');
  assert.equal(f.writes.get('--host-glass-solid'), '#eeeeee');
});

test('connect 等待期间的新事件优先于较早摘要，销毁后的返回不起效', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(new Promise((done) => { resolve = done; }));
  const dispose = f.begin(); await tick();
  f.event({ type: 'appearance-changed', appearance: appearance('light') });
  resolve({ appearance: appearance('dark') }); await tick();
  assert.equal(f.target.dataset.theme, 'light');
  dispose();
  assert.equal(f.writes.size, 0);
  assert.equal(f.unsubscribed(), 1);
  assert.equal(f.fallback(), 1);
  f.event({ type: 'appearance-changed', appearance: appearance('dark') });
  assert.equal(f.writes.size, 0);
});

test('订阅同步回放也优先于连接摘要，连接晚于销毁不会重新安装', async () => {
  const immediate = fixture({ appearance: appearance('dark') });
  immediate.bridge.onEvent = (callback) => { callback({ type: 'appearance-changed', appearance: appearance('light') }); return () => {}; };
  immediate.begin(); await tick();
  assert.equal(immediate.target.dataset.theme, 'light');
  let resolve!: (value: unknown) => void;
  const late = fixture(new Promise((done) => { resolve = done; }));
  const dispose = late.begin(); await tick(); dispose();
  resolve({ appearance: appearance('dark') }); await tick();
  assert.equal(late.writes.size, 0);
  assert.equal(late.target.dataset.theme, 'light');
});

test('旧宿主、连接失败及未完成连接均有有界回退；子 iframe 不连接', async () => {
  const old = fixture({ capabilities: ['connect'] }); old.begin(); await tick();
  assert.equal(old.target.dataset.theme, 'light'); assert.equal(old.writes.size, 0); assert.equal(old.target.dataset.appearancePending, undefined);
  const failed = fixture(); failed.bridge.call = async () => { throw new Error('offline'); }; failed.begin(); await tick();
  assert.equal(failed.target.dataset.appearancePending, undefined);
  const stalled = fixture(new Promise(() => {})); stalled.begin(); stalled.timeout();
  assert.equal(stalled.target.dataset.appearancePending, undefined); assert.equal(stalled.writes.size, 0);
  const nested = fixture(); nested.begin(false); await tick();
  assert.deepEqual(nested.order, []); assert.equal(nested.writes.size, 0);
});

test('宿主覆盖不写入本地主题偏好，系统事件与跨标签事件不夺回宿主主题', async () => {
  const f = fixture();
  const previous = Object.fromEntries(['window', 'document', 'CSS', 'localStorage'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const windowEvents = new EventTarget();
  const mediaEvents = new EventTarget();
  const media = Object.assign(mediaEvents, { matches: false });
  const win = Object.assign(windowEvents, { top: null as unknown, desirecoreApp: f.bridge, matchMedia: () => media }); win.top = win;
  const storage = new Map([['openfilm.theme', 'light']]); let persisted = 0;
  Object.assign(globalThis, { window: win, document: { documentElement: f.target }, CSS: { supports }, localStorage: {
    getItem: (name: string) => storage.get(name), setItem: (name: string, value: string) => { persisted += 1; storage.set(name, value); },
  } });
  let dispose: (() => void) | undefined;
  try {
    const theme = await import('../components/settings/theme.ts');
    dispose = startHostAppearance(theme.applySavedTheme); await tick();
    assert.equal(f.target.dataset.theme, 'dark'); assert.equal(storage.get('openfilm.theme'), 'light'); assert.equal(persisted, 0);
    mediaEvents.dispatchEvent(new Event('change'));
    const storageEvent = Object.assign(new Event('storage'), { key: 'openfilm.theme' }); windowEvents.dispatchEvent(storageEvent);
    assert.equal(f.target.dataset.theme, 'dark');
    theme.setThemeMode('system');
    assert.equal(storage.get('openfilm.theme'), 'system'); assert.equal(f.target.dataset.theme, 'dark');
    dispose(); dispose = undefined;
    assert.equal(f.target.dataset.theme, 'light'); assert.equal(storage.get('openfilm.theme'), 'system');
  } finally {
    dispose?.();
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
