import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ScanFileRequest } from './protocol';

const connectNative = vi.hoisted(() => vi.fn());

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      connectNative,
    },
  },
}));

import { scanWithNativeHost } from './nativeClient';

class FakePort {
  readonly posted: unknown[] = [];
  readonly messageListeners: Array<(message: unknown) => void> = [];
  readonly disconnectListeners: Array<() => void> = [];
  readonly disconnect = vi.fn();

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => this.messageListeners.push(listener),
  };

  readonly onDisconnect = {
    addListener: (listener: () => void) => this.disconnectListeners.push(listener),
  };

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  emitDisconnect(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

function request(): ScanFileRequest {
  return {
    type: 'scan-file',
    scanId: 'scan-1',
    name: 'safe.txt',
    mime: 'text/plain',
    size: 3,
    bytes: new Uint8Array([1, 2, 3]),
  };
}

beforeEach(() => {
  connectNative.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('native scanner client', () => {
  test('returns a genuine matching verdict and sends the bounded protocol sequence', async () => {
    const port = new FakePort();
    connectNative.mockReturnValue(port);
    const result = scanWithNativeHost(request());

    expect(port.posted).toHaveLength(3);
    port.emitMessage({ type: 'verdict', id: 'scan-1', decision: 'allow', rule: null });

    await expect(result).resolves.toEqual({ kind: 'verdict', decision: 'allow', rule: null });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });

  test('does not disguise malformed responses or disconnects as Allow verdicts', async () => {
    const malformedPort = new FakePort();
    connectNative.mockReturnValueOnce(malformedPort);
    const malformed = scanWithNativeHost(request());
    malformedPort.emitMessage({ type: 'verdict', id: 'wrong', decision: 'allow', rule: null });
    await expect(malformed).resolves.toEqual({
      kind: 'unavailable',
      reason: 'invalid_response',
    });

    const disconnectedPort = new FakePort();
    connectNative.mockReturnValueOnce(disconnectedPort);
    const disconnected = scanWithNativeHost(request());
    disconnectedPort.emitDisconnect();
    await expect(disconnected).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host_disconnected',
    });
  });

  test('reports launch failures and bounded timeouts as unavailable outcomes', async () => {
    connectNative.mockImplementationOnce(() => {
      throw new Error('missing host');
    });
    await expect(scanWithNativeHost(request())).resolves.toEqual({
      kind: 'unavailable',
      reason: 'host_unavailable',
    });

    vi.useFakeTimers();
    const port = new FakePort();
    connectNative.mockReturnValueOnce(port);
    const timedOut = scanWithNativeHost(request(), 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(timedOut).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
});
