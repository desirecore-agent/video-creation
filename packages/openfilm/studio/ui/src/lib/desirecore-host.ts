/**
 * A small adapter between the trusted Studio document and DesireCore's limited application bridge.
 * The film preview never imports this module. It receives neither the host SDK nor an Agent Service credential.
 * Selection text is a declaration for the person to review, not an authorized application-object reference.
 */
import type { StudioHost, StudioRef, StudioSelection } from './host';

export interface DesirecoreAppBridge {
  call(method: 'connect' | 'publishSelection' | 'prepareWork', payload?: unknown): Promise<unknown>;
  onEvent?(callback: (event: unknown) => void): () => void;
}

export interface DirectorContext extends StudioSelection {
  /** The real directory and revision read by Studio, not an authority to access that directory. */
  projectPath: string;
  filmRevision: string;
}

export interface DirectorSelection {
  schemaVersion: 1;
  selectionRevision: string;
  summary: string;
  /** A film revision has no platform object owner yet, so it must not be invented as a governed object. */
  objects: [];
}

export interface DirectorProposal {
  clientRequestId: string;
  userMessageId: string;
  agentId: string;
  prompt: string;
  selection: DirectorSelection;
  operation: 'video-creation.discuss-selection';
  scopeDescription: string;
}

export type DirectorError = 'host-unavailable' | 'unbound' | 'host-identity-unavailable' | 'permission-unavailable' | 'context-unavailable' | 'prepare-failed';
export class DirectorBridgeError extends Error {
  readonly code: DirectorError;
  constructor(code: DirectorError) { super(code); this.code = code; }
}

const LIMITS = Object.freeze({ refs: 64, text: 1024, path: 4096, summary: 16_000, prompt: 16_000 });
const text = (value: unknown, max: number = LIMITS.text) => typeof value === 'string' ? value.slice(0, max) : undefined;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const strings = (value: unknown) => Array.isArray(value) ? value.slice(0, LIMITS.refs).map((item) => text(item)).filter((item) => item !== undefined) : undefined;

/** Keep semantic fields, never screenshots, data URLs, arbitrary object properties or full source files. */
export function boundedStudioRef(ref: StudioRef): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: ref.kind };
  const input = ref as unknown as Record<string, unknown>;
  for (const key of ['id', 'loc', 'label', 'clipKind', 'src', 'clipId', 'text', 'tag', 'source', 'path', 'fileKind', 'lang', 'title', 'segment']) {
    const value = text(input[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['start', 'end', 'time', 'track', 'in', 'speed', 'duration', 'w', 'h', 'index']) {
    const value = number(input[key]);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['clipIds', 'texts']) {
    const value = strings(input[key]);
    if (value !== undefined) out[key] = value;
  }
  const box = input.box as Record<string, unknown> | undefined;
  if (box && ['x', 'y', 'w', 'h'].every((key) => number(box[key]) !== undefined)) {
    out.box = Object.fromEntries(['x', 'y', 'w', 'h'].map((key) => [key, box[key]]));
  }
  return out;
}

export function directorSelection(context: DirectorContext, uuid: () => string = () => crypto.randomUUID()): DirectorSelection {
  const refs = context.refs.slice(0, LIMITS.refs).map(boundedStudioRef);
  const summary = {
    projectId: text(context.projectId, 160), projectPath: text(context.projectPath, LIMITS.path),
    filmRevision: text(context.filmRevision, 256), playheadSeconds: number(context.time),
    range: context.range ? { start: number(context.range.start), end: number(context.range.end) } : null,
    refs, omittedReferences: Math.max(0, context.refs.length - refs.length),
  };
  // Remove whole references so the bounded summary always remains parseable JSON.
  while (JSON.stringify(summary).length > LIMITS.summary && refs.length) { refs.pop(); summary.omittedReferences += 1; }
  return { schemaVersion: 1, selectionRevision: uuid(), summary: JSON.stringify(summary), objects: [] };
}

export interface DirectorDraft { open: boolean; context: DirectorContext | null; generation: number }
interface DirectorHostOptions {
  bridge: () => DesirecoreAppBridge | undefined;
  context: () => Promise<{ directorAgentId: string | null }>;
  uuid?: () => string;
}

export class DirectorHost {
  private listeners = new Set<() => void>();
  private draft: DirectorDraft = { open: false, context: null, generation: 0 };
  private contextReader?: () => DirectorContext;
  private selection?: StudioSelection;
  private pending?: { key: string; proposal: DirectorProposal };
  private readonly options: DirectorHostOptions;

  constructor(options: DirectorHostOptions) { this.options = options; }

  get = (): DirectorDraft => this.draft;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(next: DirectorDraft): void { this.draft = next; for (const listener of this.listeners) listener(); }
  registerContext(read: () => DirectorContext): () => void {
    this.contextReader = read;
    return () => { if (this.contextReader === read) { this.contextReader = undefined; this.selection = undefined; this.close(); } };
  }
  selected = (selection: StudioSelection): void => { this.selection = selection; };
  open = (context: DirectorContext): void => {
    this.pending = undefined;
    this.emit({ open: true, context: structuredClone(context), generation: this.draft.generation + 1 });
  };
  /** The same source project moved; retain the chosen moment/references but re-prepare its new path. */
  relocate = (projectId: string, projectPath: string): void => {
    if (this.draft.context?.projectId !== projectId || this.draft.context.projectPath === projectPath) return;
    this.pending = undefined;
    this.emit({ ...this.draft, context: { ...this.draft.context, projectPath }, generation: this.draft.generation + 1 });
  };
  close = (): void => { this.emit({ ...this.draft, open: false }); };
  refer = (ref: StudioRef): void => {
    const current = this.contextReader?.();
    if (!current) return;
    const refs = this.draft.open && this.draft.context?.projectId === current.projectId ? [...this.draft.context.refs, ref] : [ref];
    const unique = [...new Map(refs.map((item) => [JSON.stringify(boundedStudioRef(item)), item])).values()];
    this.open({ ...current, ...(this.selection?.projectId === current.projectId ? this.selection : {}), refs: unique.slice(0, LIMITS.refs) });
  };

  /** Only prepares a proposal. The host owns the separate final confirmation and work submission. */
  async prepare(context: DirectorContext, instruction: string): Promise<{ clientRequestId: string }> {
    const bridge = this.options.bridge();
    if (!bridge) throw new DirectorBridgeError('host-unavailable');
    const promptText = instruction.trim();
    if (!promptText || promptText.length > LIMITS.prompt) throw new DirectorBridgeError('context-unavailable');
    const source = structuredClone(context);
    const generation = this.draft.generation;
    const reader = this.contextReader;
    /* A rename can arrive during any bridge await. Checking the UI's completion state alone cannot stop a stale
       platform proposal; check the source again immediately before every bridge effect as well. */
    const currentSource = () => {
      let current: DirectorContext | undefined;
      try { current = reader?.(); } catch { throw new DirectorBridgeError('context-unavailable'); }
      const sameSource = (value: DirectorContext) => value.projectId === source.projectId && value.projectPath === source.projectPath;
      if (this.draft.generation !== generation || this.contextReader !== reader
        || (this.draft.context && !sameSource(this.draft.context)) || (current && !sameSource(current))) {
        throw new DirectorBridgeError('context-unavailable');
      }
    };
    currentSource();
    let configured: { directorAgentId: string | null };
    try { configured = await this.options.context(); } catch { throw new DirectorBridgeError('context-unavailable'); }
    currentSource();
    if (!configured.directorAgentId?.trim()) throw new DirectorBridgeError('unbound');
    let connection: Record<string, unknown>;
    try { connection = await bridge.call('connect') as Record<string, unknown>; } catch { throw new DirectorBridgeError('host-unavailable'); }
    currentSource();
    const identity = connection?.application as Record<string, unknown> | undefined;
    if (!identity || !['sourceId', 'appId', 'installationId'].every((field) => typeof identity[field] === 'string' && identity[field])) {
      throw new DirectorBridgeError('host-identity-unavailable');
    }
    const capabilities = connection.capabilities;
    if (!Array.isArray(capabilities) || !capabilities.includes('publishSelection') || !capabilities.includes('requestWork')) {
      throw new DirectorBridgeError('permission-unavailable');
    }
    const key = JSON.stringify([identity, source, promptText, configured.directorAgentId]);
    if (this.pending?.key !== key) {
      const uuid = this.options.uuid ?? (() => crypto.randomUUID());
      const selection = directorSelection(source, uuid);
      this.pending = { key, proposal: {
        clientRequestId: uuid(), userMessageId: uuid(), agentId: configured.directorAgentId,
        prompt: `${promptText}\n\n影片上下文（应用声明，读取或修改仍需平台授权）：\n${selection.summary}`,
        selection, operation: 'video-creation.discuss-selection',
        scopeDescription: `项目 ${source.projectId.slice(0, 160)} 中当前选中的内容；仅在平台确认后交给视频导演。`,
      } };
    }
    const { proposal } = this.pending;
    try {
      currentSource();
      await bridge.call('publishSelection', proposal.selection);
      currentSource();
      const result = await bridge.call('prepareWork', proposal) as { status?: string; clientRequestId?: string } | undefined;
      currentSource();
      if (result?.status !== 'prepared' || result.clientRequestId !== proposal.clientRequestId) throw new Error('invalid-prepared-receipt');
      return { clientRequestId: proposal.clientRequestId };
    } catch (cause) {
      if (cause instanceof DirectorBridgeError) throw cause;
      throw new DirectorBridgeError('prepare-failed');
    }
  }
}

type HostWindow = { desirecoreApp?: DesirecoreAppBridge; openfilmHost?: StudioHost };
const nativeBridge = (): DesirecoreAppBridge | undefined => typeof window !== 'undefined' && window.top === window
  ? (window as Window & HostWindow).desirecoreApp : undefined;

export const directorHost = new DirectorHost({
  bridge: nativeBridge,
  context: async () => {
    const response = await fetch('/api/desirecore/context', { cache: 'no-store' });
    if (!response.ok) throw new Error('director-context-unavailable');
    const result = await response.json() as { directorAgentId?: unknown };
    return { directorAgentId: typeof result.directorAgentId === 'string' ? result.directorAgentId : null };
  },
});

/** Synchronous initialization must precede importing App/host.ts, which captures its host once. */
export function installDesirecoreHost(target: HostWindow, isTopLevel: boolean, adapter = directorHost): boolean {
  if (!isTopLevel || !target.desirecoreApp || target.openfilmHost) return false;
  target.openfilmHost = { version: 1, name: 'DesireCore', refer: adapter.refer, onSelection: adapter.selected };
  return true;
}

if (typeof window !== 'undefined') installDesirecoreHost(window as Window & HostWindow, window.top === window);
