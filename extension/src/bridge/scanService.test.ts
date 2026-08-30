import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_GUARD_POLICY, type GuardPolicy } from '../bridge/policy';

const loadGuardPolicy = vi.hoisted(() => vi.fn<() => Promise<GuardPolicy>>());
const scanWithNativeHost = vi.hoisted(() => vi.fn());

vi.mock('#imports', () => ({
  browser: { runtime: { onMessage: { addListener: vi.fn() } } },
  defineBackground: (factory: () => void) => factory,
}));
vi.mock('../bridge/policyStore', () => ({ loadGuardPolicy }));
vi.mock('../bridge/nativeClient', () => ({
  checkNativeHost: vi.fn(),
  scanWithNativeHost,
}));

import { preflightScan, scanFile } from './scanService';

const sender = 'http://localhost:4173/upload';
const initialPolicy: GuardPolicy = { ...DEFAULT_GUARD_POLICY, maxFileBytes: 10 };
const tightenedPolicy: GuardPolicy = { ...DEFAULT_GUARD_POLICY, maxFileBytes: 2 };

beforeEach(() => {
  loadGuardPolicy.mockReset();
  scanWithNativeHost.mockReset();
});

describe('background-owned scan policy', () => {
  test('rechecks a tightened bound before consuming preflight-approved bytes', async () => {
    loadGuardPolicy.mockResolvedValueOnce(initialPolicy);
    await expect(
      preflightScan({ type: 'scan-preflight', scanId: 'scan', size: 3 }, sender),
    ).resolves.toEqual({
      kind: 'scan',
    });
    expect(loadGuardPolicy).toHaveBeenCalledOnce();

    loadGuardPolicy.mockResolvedValueOnce(tightenedPolicy);
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(
      scanFile({ type: 'scan-file', scanId: 'scan', size: 3, bytes }, sender),
    ).resolves.toEqual({
      decision: 'block',
      cause: { kind: 'policy', reason: 'too_large' },
    });
    expect(scanWithNativeHost).not.toHaveBeenCalled();
    expect(bytes).toEqual(new Uint8Array([0, 0, 0]));
  });

  test('returns an explicit bypass only for a supported origin narrowed out of current policy', async () => {
    const narrowed: GuardPolicy = {
      ...DEFAULT_GUARD_POLICY,
      protectedOrigins: ['http://localhost:4173'],
    };
    loadGuardPolicy.mockResolvedValue(narrowed);
    const narrowedOrigin = 'http://127.0.0.1:4173/upload';
    await expect(
      preflightScan({ type: 'scan-preflight', scanId: 'scan', size: 3 }, narrowedOrigin),
    ).resolves.toEqual({ kind: 'final', result: { decision: 'allow', source: 'unprotected' } });
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(
      scanFile({ type: 'scan-file', scanId: 'scan', size: 3, bytes }, narrowedOrigin),
    ).resolves.toEqual({ decision: 'allow', source: 'unprotected' });
    expect(bytes).toEqual(new Uint8Array([0, 0, 0]));
  });
});
