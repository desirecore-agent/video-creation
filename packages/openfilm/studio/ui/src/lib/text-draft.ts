/**
 * A layer's words while the person keeps typing through a save. Preview measurements are not saved text: only a
 * successful write advances `written`. Each submission belongs to its input revision and its original layer.
 */
export type TextDraftEdit = {
  loc: string;
  value: string;
  expect: string;
  /** Controls UI acknowledgements only; an already submitted write still finishes for its original layer. */
  isCurrent?: () => boolean;
};

type Submission = TextDraftEdit & { revision: number };

export function createTextDraft(loc: string, initial: string) {
  let raw = initial;
  let written = initial;
  let revision = 0;
  let pending = 0;
  let dirty = false;
  let active = true;
  let lastSubmitted: string | null = null;
  return {
    get raw() { return raw; },
    get written() { return written; },
    get saving() { return pending > 0; },
    get active() { return active; },
    activate() { active = true; },
    dispose() { active = false; },
    /** Idle external changes (undo, another editor) may replace the buffer; preview and in-flight props may not. */
    receive(value: string) {
      if (dirty || pending || value === raw) return false;
      raw = written = value;
      return true;
    },
    change(value: string) { revision += 1; raw = value; dirty = true; },
    cancel() { revision += 1; raw = written; dirty = false; },
    submit(): Submission | null {
      if (!pending && raw === written) { dirty = false; return null; }
      if (pending && raw === lastSubmitted) return null;
      const version = revision;
      const submission = { loc, value: raw, expect: written, revision: version,
        isCurrent: () => active && revision === version };
      pending += 1;
      lastSubmitted = raw;
      return submission;
    },
    /** Writes settle in submission order. A stale outcome updates the saved baseline, never a newer draft. */
    finish(submission: Submission, failed: boolean) {
      if (!failed) written = submission.value;
      pending -= 1;
      if (!pending) lastSubmitted = null;
      if (revision === submission.revision || !dirty || (!pending && raw === written)) { raw = written; dirty = false; }
    },
  };
}

/** Capture a write's target before enqueueing; asynchronous geometry reads must not reorder text submissions. */
export function createTextWriteQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(write: () => Promise<T>): Promise<T> => {
    const next = tail.then(write, write);
    tail = next;
    return next;
  };
}
