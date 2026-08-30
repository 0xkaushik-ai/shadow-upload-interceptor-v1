import { beforeEach, describe, expect, test, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  localGet: vi.fn(),
  managedGet: vi.fn(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: { get: storage.localGet },
      managed: { get: storage.managedGet },
    },
  },
}));

import { POLICY_STORAGE_KEY } from './policy';
import { loadGuardPolicy } from './policyStore';

beforeEach(() => {
  storage.localGet.mockReset().mockResolvedValue({});
  storage.managedGet.mockReset().mockResolvedValue({});
});

describe('policy storage precedence', () => {
  test('lets valid enterprise-managed values override local development values', async () => {
    storage.localGet.mockResolvedValue({
      [POLICY_STORAGE_KEY]: { onUnavailable: 'allow', maxFileBytes: 4096 },
    });
    storage.managedGet.mockResolvedValue({
      [POLICY_STORAGE_KEY]: { onUnavailable: 'block', onTooLarge: 'block' },
    });

    await expect(loadGuardPolicy()).resolves.toMatchObject({
      onUnavailable: 'block',
      onTooLarge: 'block',
      maxFileBytes: 4096,
    });
  });

  test('ignores an invalid managed candidate as one atomic object', async () => {
    storage.localGet.mockResolvedValue({
      [POLICY_STORAGE_KEY]: { onUnavailable: 'block', maxFileBytes: 2048 },
    });
    storage.managedGet.mockResolvedValue({
      [POLICY_STORAGE_KEY]: { onUnavailable: 'allow', maxFileBytes: -1 },
    });

    await expect(loadGuardPolicy()).resolves.toMatchObject({
      onUnavailable: 'block',
      maxFileBytes: 2048,
    });
  });

  test('uses defaults when a storage area is unavailable', async () => {
    storage.localGet.mockRejectedValue(new Error('storage unavailable'));
    storage.managedGet.mockRejectedValue(new Error('no managed policy'));

    await expect(loadGuardPolicy()).resolves.toMatchObject({
      onUnavailable: 'block',
      onTooLarge: 'block',
    });
  });
});
