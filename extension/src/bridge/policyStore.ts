import { browser } from 'wxt/browser';
import {
  applyGuardPolicyOverride,
  DEFAULT_GUARD_POLICY,
  type GuardPolicy,
  POLICY_STORAGE_KEY,
} from './policy';

async function readPolicyCandidate(
  read: () => Promise<Record<string, unknown>>,
): Promise<unknown | undefined> {
  try {
    const values = await read();
    return values[POLICY_STORAGE_KEY];
  } catch {
    // Managed storage is unavailable when the browser has no enterprise policy for this extension.
    return undefined;
  }
}

/** Managed policy wins over local development policy. Invalid candidates are ignored atomically. */
export async function loadGuardPolicy(): Promise<GuardPolicy> {
  const [localCandidate, managedCandidate] = await Promise.all([
    readPolicyCandidate(() => browser.storage.local.get(POLICY_STORAGE_KEY)),
    readPolicyCandidate(() => browser.storage.managed.get(POLICY_STORAGE_KEY)),
  ]);

  const localPolicy =
    applyGuardPolicyOverride(localCandidate, DEFAULT_GUARD_POLICY) ?? DEFAULT_GUARD_POLICY;
  return applyGuardPolicyOverride(managedCandidate, localPolicy) ?? localPolicy;
}
