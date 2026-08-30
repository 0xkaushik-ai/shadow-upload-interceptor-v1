import { describe, expect, test } from 'vitest';
import {
  applyGuardPolicyOverride,
  DEFAULT_GUARD_POLICY,
  resolveScanOutcome,
  SECURE_FALLBACK_POLICY,
} from './policy';
import { unavailableOutcome } from './protocol';

describe('upload enforcement policy', () => {
  test('keeps genuine scanner verdicts separate from policy decisions', () => {
    expect(
      resolveScanOutcome(
        { kind: 'verdict', decision: 'block', rule: 'pem_private_key' },
        DEFAULT_GUARD_POLICY,
      ),
    ).toEqual({ decision: 'block', cause: { kind: 'rule', rule: 'pem_private_key' } });
  });

  test('defaults to fail-closed and permits an explicit development fail-open policy', () => {
    expect(resolveScanOutcome(unavailableOutcome('timeout'), DEFAULT_GUARD_POLICY)).toEqual({
      decision: 'block',
      cause: { kind: 'policy', reason: 'timeout' },
    });
    const developmentPolicy = applyGuardPolicyOverride({ onUnavailable: 'allow' });
    expect(developmentPolicy).not.toBeNull();
    if (!developmentPolicy) throw new Error('expected a valid policy override');
    expect(resolveScanOutcome(unavailableOutcome('timeout'), developmentPolicy)).toEqual({
      decision: 'allow',
      source: 'policy',
      reason: 'timeout',
    });
    expect(SECURE_FALLBACK_POLICY.onUnavailable).toBe('block');
  });

  test('configures oversized-file handling independently', () => {
    const policy = applyGuardPolicyOverride({ onTooLarge: 'allow' }, DEFAULT_GUARD_POLICY);
    expect(policy).not.toBeNull();
    if (!policy) throw new Error('expected a valid policy override');
    expect(resolveScanOutcome(unavailableOutcome('too_large'), policy)).toEqual({
      decision: 'allow',
      source: 'policy',
      reason: 'too_large',
    });
  });

  test('rejects invalid or scope-expanding overrides atomically', () => {
    expect(applyGuardPolicyOverride({ onUnavailable: 'ignore' })).toBeNull();
    expect(applyGuardPolicyOverride({ maxFileBytes: 8 * 1024 * 1024 + 1 })).toBeNull();
    expect(
      applyGuardPolicyOverride({ protectedOrigins: ['https://unconfigured.example'] }),
    ).toBeNull();
    expect(applyGuardPolicyOverride({ onUnavailable: 'block', unknown: true })).toBeNull();
  });

  test('accepts bounded partial overrides without mutating the base policy', () => {
    const result = applyGuardPolicyOverride({
      onUnavailable: 'allow',
      maxFileBytes: 1024,
      scanTimeoutMs: 500,
    });
    expect(result).toEqual({
      ...DEFAULT_GUARD_POLICY,
      onUnavailable: 'allow',
      maxFileBytes: 1024,
      scanTimeoutMs: 500,
    });
    expect(DEFAULT_GUARD_POLICY.onUnavailable).toBe('block');
  });
});
