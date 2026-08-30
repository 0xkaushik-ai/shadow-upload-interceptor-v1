import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GuardHealthResult } from '../bridge/policy';
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

    decision.resolve({ decision: 'allow', source: 'scanner' });
    await flush();

    expect(pageListener).toHaveBeenCalledOnce();
    expect(input.files?.[0]).toBe(file);
    remove();
  });

  test('stops the trusted input event before a page listener can read the original FileList', async () => {
    const { input, setFiles } = createControlledInput();
    const file = new File(['safe'], 'original.txt');
    const trusted = trustedEvents();
    const decision = deferred<ScanFileResult>();
    const observed = vi.fn<(event: Event) => File | undefined>(() => input.files?.[0]);
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan: async () => decision.promise,
      isTrustedEvent: trusted.matches,
    });
    input.addEventListener('input', observed);
    setFiles([file]);
    const original = new Event('input', { bubbles: true, cancelable: true });
    trusted.add(original);
    input.dispatchEvent(original);
    expect(observed).not.toHaveBeenCalled();
    expect(input.files).toHaveLength(0);
    decision.resolve({ decision: 'allow', source: 'scanner' });
    await flush();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]?.[0].isTrusted).toBe(false);
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
        cause: { kind: 'policy', reason: 'host_unavailable' },
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

  test('removes a resolved blocked overlay during guard teardown', async () => {
    const { input, setFiles } = createControlledInput();
    const trusted = trustedEvents();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan: async () => ({
        decision: 'block',
        cause: { kind: 'rule', rule: 'pem_private_key' },
      }),
      isTrustedEvent: trusted.matches,
    });
    setFiles([new File(['secret'], 'key.pem')]);
    const change = new Event('change', { bubbles: true, cancelable: true });
    trusted.add(change);
    input.dispatchEvent(change);
    await flush();
    expect(document.querySelector('secureintent-shadow-warning')).not.toBeNull();
    remove();
    expect(document.querySelector('secureintent-shadow-warning')).toBeNull();
  });

  test('allows independent inputs without dropping either operation', async () => {
    const first = createControlledInput();
    const second = createControlledInput();
    const trusted = trustedEvents();
    const firstResult = deferred<ScanFileResult>();
    const secondResult = deferred<ScanFileResult>();
    const requestScan = vi
      .fn()
      .mockReturnValueOnce(firstResult.promise)
      .mockReturnValueOnce(secondResult.promise);
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.input.addEventListener('change', firstListener);
    second.input.addEventListener('change', secondListener);
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan,
      isTrustedEvent: trusted.matches,
    });
    for (const [controlled, file] of [
      [first, new File(['a'], 'first.txt')],
      [second, new File(['b'], 'second.txt')],
    ] as const) {
      controlled.setFiles([file]);
      const input = new Event('input', { bubbles: true, cancelable: true });
      trusted.add(input);
      controlled.input.dispatchEvent(input);
    }
    secondResult.resolve({ decision: 'allow', source: 'scanner' });
    firstResult.resolve({ decision: 'allow', source: 'scanner' });
    await flush();
    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledOnce();
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
    const oldInput = new Event('input', { bubbles: true, cancelable: true });
    trusted.add(oldInput);
    input.dispatchEvent(oldInput);
    const newestFile = new File(['new'], 'new.txt');
    setFiles([newestFile]);
    const newestInput = new Event('input', { bubbles: true, cancelable: true });
    trusted.add(newestInput);
    input.dispatchEvent(newestInput);

    second.resolve({ decision: 'allow', source: 'scanner' });
    await flush();
    first.resolve({ decision: 'allow', source: 'scanner' });
    await flush();

    expect(pageListener).toHaveBeenCalledOnce();
    expect(input.files?.[0]).toBe(newestFile);
    remove();
  });

  test('processes two sequential trusted change-only picker selections', async () => {
    const { input, setFiles } = createControlledInput();
    const first = deferred<ScanFileResult>();
    const second = deferred<ScanFileResult>();
    const requestScan = vi
      .fn<(file: File) => Promise<ScanFileResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const trusted = trustedEvents();
    const pageListener = vi.fn();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan,
      isTrustedEvent: trusted.matches,
    });
    input.addEventListener('change', pageListener);

    const firstFile = new File(['first'], 'first.txt');
    setFiles([firstFile]);
    const firstChange = new Event('change', { bubbles: true, cancelable: true });
    trusted.add(firstChange);
    input.dispatchEvent(firstChange);
    first.resolve({ decision: 'allow', source: 'scanner' });
    await flush();

    const secondFile = new File(['second'], 'second.txt');
    setFiles([secondFile]);
    const secondChange = new Event('change', { bubbles: true, cancelable: true });
    trusted.add(secondChange);
    input.dispatchEvent(secondChange);
    second.resolve({ decision: 'allow', source: 'scanner' });
    await flush();

    expect(requestScan).toHaveBeenCalledTimes(2);
    expect(pageListener).toHaveBeenCalledTimes(2);
    expect(input.files?.[0]).toBe(secondFile);
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
    decision.resolve({ decision: 'allow', source: 'scanner' });
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
      requestScan: async () => ({ decision: 'allow', source: 'scanner' }),
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

  test('fails closed before a page listener sees a file drop with no input', async () => {
    const zone = document.createElement('div');
    document.body.append(zone);
    const transfer = new FakeDataTransfer();
    transfer.items.add(new File(['secret'], 'drop.txt'));
    const pageListener = vi.fn();
    const requestScan = vi.fn();
    const trusted = trustedEvents();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan,
      isTrustedEvent: trusted.matches,
    });
    zone.addEventListener('drop', pageListener);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    trusted.add(drop);
    zone.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(pageListener).not.toHaveBeenCalled();
    expect(requestScan).not.toHaveBeenCalled();
    remove();
  });

  test('fails closed before a page listener sees an ambiguous file drop', async () => {
    createControlledInput();
    createControlledInput();
    const zone = document.createElement('div');
    document.body.append(zone);
    const transfer = new FakeDataTransfer();
    transfer.items.add(new File(['secret'], 'ambiguous.txt'));
    const pageListener = vi.fn();
    const requestScan = vi.fn();
    const trusted = trustedEvents();
    const remove = installUploadGuard({
      requestHealth: async () => health(),
      requestScan,
      isTrustedEvent: trusted.matches,
    });
    zone.addEventListener('drop', pageListener);
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    trusted.add(drop);
    zone.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(pageListener).not.toHaveBeenCalled();
    expect(requestScan).not.toHaveBeenCalled();
    remove();
  });
});
