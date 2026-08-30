import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_GUARD_POLICY, type GuardHealthResult } from '../bridge/policy';
import type { ScanFileResult } from '../bridge/protocol';
import { installUploadGuard } from './uploadGuard';

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(),
    },
  },
}));

class FakeDataTransfer {
  private stored: File[] = [];

  readonly types = ['Files'];
  dropEffect = 'none';
  readonly items = {
    add: (file: File) => {
      this.stored.push(file);
      return null;
    },
  };

  get files(): FileList {
    return this.stored as unknown as FileList;
  }
}

interface ControlledInput {
  input: HTMLInputElement;
  setFiles: (files: File[]) => void;
}

function createControlledInput(withForgeMarker = false): ControlledInput {
  const input = document.createElement('input');
  input.type = 'file';
  if (withForgeMarker) input.dataset.forgeUpload = '';
  let files: File[] = [];
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => files as unknown as FileList,
    set: (next: FileList) => {
      files = Array.from(next);
    },
  });
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => '',
    set: (next: string) => {
      if (next === '') files = [];
    },
  });
  document.body.append(input);
  return { input, setFiles: (next) => (files = next) };
}

function health(overrides: Partial<GuardHealthResult> = {}): GuardHealthResult {
  return {
    available: true,
    protocol: 1,
    protected: true,
    policy: {
      ...DEFAULT_GUARD_POLICY,
      protectedOrigins: [...DEFAULT_GUARD_POLICY.protectedOrigins],
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function trustedEvents() {
  const events = new WeakSet<Event>();
  return {
    add: (event: Event) => events.add(event),
    matches: (event: Event) => events.has(event),
  };
}

beforeEach(() => {
  vi.stubGlobal('DataTransfer', FakeDataTransfer);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  document.body.replaceChildren();
  delete document.documentElement.dataset.secureintentGuard;
  delete document.documentElement.dataset.secureintentStatus;
});

afterEach(() => {
  document.querySelector('secureintent-shadow-warning')?.remove();
  vi.unstubAllGlobals();
});

describe('upload guard', () => {
  test('synchronously stops an ordinary dynamic file input and resumes only after Allow', async () => {
    const { input, setFiles } = createControlledInput();
    const file = new File(['safe'], 'allow.txt', { type: 'text/plain' });
    setFiles([file]);
    const decision = deferred<ScanFileResult>();
    const pageListener = vi.fn();
    const trusted = trustedEvents();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan: async () => decision.promise,
      isTrustedEvent: trusted.matches,
    });
    input.addEventListener('change', pageListener);

    const originalChange = new Event('change', { bubbles: true, cancelable: true });
    trusted.add(originalChange);
    input.dispatchEvent(originalChange);

    expect(originalChange.defaultPrevented).toBe(true);
    expect(pageListener).not.toHaveBeenCalled();
    expect(input.files).toHaveLength(0);
    expect(JSON.parse(document.documentElement.dataset.secureintentStatus ?? '{}')).toEqual({
      state: 'scanning',
    });

    decision.resolve({ decision: 'allow', rule: null, failOpen: false });
    await flush();

    expect(pageListener).toHaveBeenCalledOnce();
    expect(input.files?.[0]).toBe(file);
    remove();
  });

  test('blocks by policy without exposing filename or rule to the page DOM', async () => {
    const { input, setFiles } = createControlledInput(true);
    setFiles([new File(['secret'], 'customer-production.pem')]);
    const pageListener = vi.fn();
    const trusted = trustedEvents();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan: async () => ({
        decision: 'block',
        rule: null,
        failOpen: false,
        reason: 'host_unavailable',
      }),
      isTrustedEvent: trusted.matches,
    });
    input.addEventListener('change', pageListener);

    const change = new Event('change', { bubbles: true, cancelable: true });
    trusted.add(change);
    input.dispatchEvent(change);
    await flush();

    const publicStatus = document.documentElement.dataset.secureintentStatus ?? '';
    expect(JSON.parse(publicStatus)).toEqual({ state: 'blocked' });
    expect(publicStatus).not.toContain('customer-production.pem');
    expect(publicStatus).not.toContain('host_unavailable');
    expect(pageListener).not.toHaveBeenCalled();
    expect(document.querySelector('secureintent-shadow-warning')).not.toBeNull();
    expect(document.documentElement.dataset.secureintentGuard).toBe('degraded');
    remove();
  });

  test('ignores a stale verdict when a newer upload has started', async () => {
    const { input, setFiles } = createControlledInput();
    const first = deferred<ScanFileResult>();
    const second = deferred<ScanFileResult>();
    const requestScan = vi
      .fn<(file: File) => Promise<ScanFileResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const pageListener = vi.fn();
    const trusted = trustedEvents();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan,
      isTrustedEvent: trusted.matches,
    });
    input.addEventListener('change', pageListener);

    const oldFile = new File(['old'], 'old.txt');
    setFiles([oldFile]);
    const oldChange = new Event('change', { bubbles: true, cancelable: true });
    trusted.add(oldChange);
    input.dispatchEvent(oldChange);
    const newestFile = new File(['new'], 'new.txt');
    setFiles([newestFile]);
    const newestChange = new Event('change', { bubbles: true, cancelable: true });
    trusted.add(newestChange);
    input.dispatchEvent(newestChange);

    second.resolve({ decision: 'allow', rule: null, failOpen: false });
    await flush();
    first.resolve({ decision: 'allow', rule: null, failOpen: false });
    await flush();

    expect(pageListener).toHaveBeenCalledOnce();
    expect(input.files?.[0]).toBe(newestFile);
    remove();
  });

  test('does not resume into an input removed while scanning', async () => {
    const { input, setFiles } = createControlledInput();
    setFiles([new File(['safe'], 'detached.txt')]);
    const decision = deferred<ScanFileResult>();
    const pageListener = vi.fn();
    const trusted = trustedEvents();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan: async () => decision.promise,
      isTrustedEvent: trusted.matches,
    });
    input.addEventListener('change', pageListener);

    const change = new Event('change', { bubbles: true, cancelable: true });
    trusted.add(change);
    input.dispatchEvent(change);
    input.remove();
    decision.resolve({ decision: 'allow', rule: null, failOpen: false });
    await flush();

    expect(pageListener).not.toHaveBeenCalled();
    expect(JSON.parse(document.documentElement.dataset.secureintentStatus ?? '{}')).toEqual({
      state: 'canceled',
    });
    remove();
  });

  test('intercepts a file drop only when it can resolve the destination input', async () => {
    const { input } = createControlledInput();
    const label = document.createElement('label');
    label.append(input);
    document.body.append(label);
    const file = new File(['safe'], 'drop.txt');
    const transfer = new FakeDataTransfer();
    transfer.items.add(file);
    const pageListener = vi.fn();
    const trusted = trustedEvents();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan: async () => ({ decision: 'allow', rule: null, failOpen: false }),
      isTrustedEvent: trusted.matches,
    });
    label.addEventListener('drop', pageListener);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    trusted.add(drop);

    label.dispatchEvent(drop);
    await flush();

    expect(drop.defaultPrevented).toBe(true);
    expect(pageListener).not.toHaveBeenCalled();
    expect(input.files?.[0]).toBe(file);
    remove();
  });
});
