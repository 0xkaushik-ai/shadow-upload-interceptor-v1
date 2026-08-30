import { scanWithNativeHost } from './nativeClient';
import {
  originIsProtected,
  resolveScanOutcome,
  SECURE_FALLBACK_POLICY,
  SUPPORTED_ORIGINS,
} from './policy';
import { loadGuardPolicy } from './policyStore';
import {
  isScanFileRequest,
  isScanPreflightRequest,
  type ScanFileResult,
  type ScanPreflightResult,
  unavailableOutcome,
} from './protocol';

function senderOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function denied(): ScanFileResult {
  return resolveScanOutcome(unavailableOutcome('invalid_request'), SECURE_FALLBACK_POLICY);
}

function isBuildTimeOrigin(origin: string | null): origin is (typeof SUPPORTED_ORIGINS)[number] {
  return (
    origin !== null && SUPPORTED_ORIGINS.includes(origin as (typeof SUPPORTED_ORIGINS)[number])
  );
}

export async function preflightScan(
  message: unknown,
  senderUrl: string | undefined,
): Promise<ScanPreflightResult> {
  const origin = senderOrigin(senderUrl);
  if (!isScanPreflightRequest(message) || !isBuildTimeOrigin(origin))
    return { kind: 'final', result: denied() };
  // One load determines both current protection and bounds. Content receives no policy snapshot.
  const policy = await loadGuardPolicy();
  if (!originIsProtected(origin, policy))
    return { kind: 'final', result: { decision: 'allow', source: 'unprotected' } };
  return message.size > policy.maxFileBytes
    ? { kind: 'final', result: resolveScanOutcome(unavailableOutcome('too_large'), policy) }
    : { kind: 'scan' };
}

export async function scanFile(
  message: unknown,
  senderUrl: string | undefined,
): Promise<ScanFileResult> {
  const policy = await loadGuardPolicy();
  const origin = senderOrigin(senderUrl);
  if (!isBuildTimeOrigin(origin) || !isScanFileRequest(message)) return denied();
  try {
    if (!originIsProtected(origin, policy)) return { decision: 'allow', source: 'unprotected' };
    if (message.size !== message.bytes.byteLength)
      return resolveScanOutcome(unavailableOutcome('invalid_request'), policy);
    if (message.size > policy.maxFileBytes)
      return resolveScanOutcome(unavailableOutcome('too_large'), policy);
    return resolveScanOutcome(await scanWithNativeHost(message, policy.scanTimeoutMs), policy);
  } finally {
    message.bytes.fill(0);
  }
}
