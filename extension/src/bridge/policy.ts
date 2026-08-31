import {
  MAX_FILE_BYTES,
  NATIVE_TIMEOUT_MS,
  type ScanFailureReason,
  type ScanFileResult,
  type ScanOutcome,
} from './protocol';

export const POLICY_STORAGE_KEY = 'guardPolicy';

export const SUPPORTED_ORIGINS = ['http://localhost:4173', 'http://127.0.0.1:4173'] as const;

export const CONTENT_SCRIPT_MATCHES = [
  'http://localhost:4173/*',
  'http://127.0.0.1:4173/*',
] as const;

export type FailureAction = 'allow' | 'block';

export interface GuardPolicy {
  onUnavailable: FailureAction;
  onTooLarge: FailureAction;
  maxFileBytes: number;
  scanTimeoutMs: number;
  protectedOrigins: readonly string[];
}

export interface GuardHealthResult {
  available: boolean;
  protocol: number | null;
  protected: boolean;
  policy: GuardPolicy;
  reason?: ScanFailureReason;
}

/**
 * The bundled posture is fail-closed: bytes that cannot be scanned must not reach the page.
 * Development installations may explicitly opt into fail-open through chrome.storage.local;
 * enterprise deployment can enforce either posture through chrome.storage.managed.
 */
export const DEFAULT_GUARD_POLICY: GuardPolicy = Object.freeze({
  onUnavailable: 'block',
  onTooLarge: 'block',
  maxFileBytes: MAX_FILE_BYTES,
  scanTimeoutMs: NATIVE_TIMEOUT_MS,
  protectedOrigins: Object.freeze([...SUPPORTED_ORIGINS]),
});

/** Used only until the background returns a validated policy. */
export const SECURE_FALLBACK_POLICY: GuardPolicy = Object.freeze({
  ...DEFAULT_GUARD_POLICY,
  onUnavailable: 'block',
  onTooLarge: 'block',
  protectedOrigins: Object.freeze([...SUPPORTED_ORIGINS]),
});

const MIN_SCAN_TIMEOUT_MS = 250;
const MAX_SCAN_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFailureAction(value: unknown): value is FailureAction {
  return value === 'allow' || value === 'block';
}

function isSupportedOrigins(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (origin) =>
        typeof origin === 'string' &&
        SUPPORTED_ORIGINS.some((supportedOrigin) => supportedOrigin === origin),
    )
  );
}

/**
 * Applies an all-or-nothing policy override. Invalid candidates cannot partially weaken the
 * current policy, and configured origins can only narrow the content-script's build-time scope.
 */
export function applyGuardPolicyOverride(
  candidate: unknown,
  base: GuardPolicy = DEFAULT_GUARD_POLICY,
): GuardPolicy | null {
  if (candidate === undefined) return { ...base, protectedOrigins: [...base.protectedOrigins] };
  if (!isRecord(candidate)) return null;

  const knownKeys = new Set([
    'onUnavailable',
    'onTooLarge',
    'maxFileBytes',
    'scanTimeoutMs',
    'protectedOrigins',
  ]);
  if (Object.keys(candidate).some((key) => !knownKeys.has(key))) return null;

  const onUnavailable = candidate.onUnavailable ?? base.onUnavailable;
  const onTooLarge = candidate.onTooLarge ?? base.onTooLarge;
  const maxFileBytes = candidate.maxFileBytes ?? base.maxFileBytes;
  const scanTimeoutMs = candidate.scanTimeoutMs ?? base.scanTimeoutMs;
  const protectedOrigins = candidate.protectedOrigins ?? base.protectedOrigins;

  if (!isFailureAction(onUnavailable) || !isFailureAction(onTooLarge)) return null;
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    (maxFileBytes as number) < 1 ||
    (maxFileBytes as number) > MAX_FILE_BYTES
  ) {
    return null;
  }
  if (
    !Number.isSafeInteger(scanTimeoutMs) ||
    (scanTimeoutMs as number) < MIN_SCAN_TIMEOUT_MS ||
    (scanTimeoutMs as number) > MAX_SCAN_TIMEOUT_MS
  ) {
    return null;
  }
  if (!isSupportedOrigins(protectedOrigins)) return null;

  return {
    onUnavailable,
    onTooLarge,
    maxFileBytes: maxFileBytes as number,
    scanTimeoutMs: scanTimeoutMs as number,
    protectedOrigins: [...new Set(protectedOrigins)],
  };
}

export function originIsProtected(origin: string, policy: GuardPolicy): boolean {
  return policy.protectedOrigins.includes(origin);
}

export function resolveScanOutcome(outcome: ScanOutcome, policy: GuardPolicy): ScanFileResult {
  if (outcome.kind === 'verdict') {
    return {
      decision: outcome.decision,
      rule: outcome.rule,
      failOpen: false,
    };
  }

  const action = outcome.reason === 'too_large' ? policy.onTooLarge : policy.onUnavailable;
  return {
    decision: action,
    rule: null,
    failOpen: action === 'allow',
    reason: outcome.reason,
  };
}
