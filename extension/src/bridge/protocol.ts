export const NATIVE_HOST = 'com.secureintent.shadow';
export const PROTOCOL_VERSION = 1;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const RAW_CHUNK_BYTES = 256 * 1024;
export const NATIVE_TIMEOUT_MS = 2_500;
export const HEALTH_TIMEOUT_MS = 1_500;

export const RULE_IDS = [
  'pem_private_key',
  'pkcs8_private_key',
  'openssh_private_key',
  'aws_access_key_id',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type ScanFailureReason =
  | 'host_unavailable'
  | 'host_disconnected'
  | 'invalid_request'
  | 'invalid_response'
  | 'protocol_mismatch'
  | 'timeout'
  | 'too_large';

/** File bytes only: names and MIME types stay in the content world for presentation. */
export interface ScanFileRequest {
  type: 'scan-file';
  scanId: string;
  size: number;
  bytes: Uint8Array;
}

export interface ScanPreflightRequest {
  type: 'scan-preflight';
  scanId: string;
  size: number;
}

export type ScanFileResult =
  | { decision: 'allow'; source: 'scanner' }
  | { decision: 'allow'; source: 'policy'; reason: ScanFailureReason }
  | { decision: 'allow'; source: 'unprotected' }
  | { decision: 'block'; cause: { kind: 'rule'; rule: RuleId } }
  | { decision: 'block'; cause: { kind: 'policy'; reason: ScanFailureReason } };

export type ScanPreflightResult = { kind: 'scan' } | { kind: 'final'; result: ScanFileResult };

export type ScanOutcome =
  | { kind: 'verdict'; decision: 'allow'; rule: null }
  | { kind: 'verdict'; decision: 'block'; rule: RuleId }
  | { kind: 'unavailable'; reason: ScanFailureReason };

export type NativeRequest =
  | { type: 'health'; id: string; protocol: number }
  | { type: 'scan_begin'; id: string; size: number; protocol: number }
  | { type: 'scan_chunk'; id: string; offset: number; data: string }
  | { type: 'scan_end'; id: string };

export type NativeVerdict =
  | { type: 'verdict'; id: string; decision: 'allow'; rule: null }
  | { type: 'verdict'; id: string; decision: 'block'; rule: RuleId };

export interface NativeHealth {
  type: 'health';
  id: string;
  protocol: number;
  status: 'ready' | 'incompatible';
}

export interface HealthCheckResult {
  available: boolean;
  protocol: number | null;
  reason?: ScanFailureReason;
}

export function isRuleId(value: unknown): value is RuleId {
  return typeof value === 'string' && RULE_IDS.some((rule) => rule === value);
}

export function isScanFailureReason(value: unknown): value is ScanFailureReason {
  return [
    'host_unavailable',
    'host_disconnected',
    'invalid_request',
    'invalid_response',
    'protocol_mismatch',
    'timeout',
    'too_large',
  ].includes(value as ScanFailureReason);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isScanId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function isSafeSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isScanPreflightRequest(value: unknown): value is ScanPreflightRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ScanPreflightRequest>;
  return (
    hasOnlyKeys(value, ['type', 'scanId', 'size']) &&
    message.type === 'scan-preflight' &&
    isScanId(message.scanId) &&
    isSafeSize(message.size)
  );
}

export function isScanFileRequest(value: unknown): value is ScanFileRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ScanFileRequest>;
  return (
    hasOnlyKeys(value, ['type', 'scanId', 'size', 'bytes']) &&
    message.type === 'scan-file' &&
    isScanId(message.scanId) &&
    isSafeSize(message.size) &&
    message.bytes instanceof Uint8Array
  );
}

export function isNativeVerdict(value: unknown, scanId: string): value is NativeVerdict {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<NativeVerdict>;
  if (message.type !== 'verdict' || message.id !== scanId) return false;
  return (
    (message.decision === 'allow' && message.rule === null) ||
    (message.decision === 'block' && isRuleId(message.rule))
  );
}

export function isScanFileResult(value: unknown): value is ScanFileResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<ScanFileResult>;
  if (result.decision === 'allow') {
    return (
      (result.source === 'scanner' && hasOnlyKeys(value, ['decision', 'source'])) ||
      (result.source === 'policy' &&
        hasOnlyKeys(value, ['decision', 'source', 'reason']) &&
        isScanFailureReason(result.reason)) ||
      (result.source === 'unprotected' && hasOnlyKeys(value, ['decision', 'source']))
    );
  }
  if (result.decision !== 'block' || !result.cause || typeof result.cause !== 'object')
    return false;
  const cause = result.cause as { kind?: unknown; rule?: unknown; reason?: unknown };
  return (
    (cause.kind === 'rule' &&
      hasOnlyKeys(value, ['decision', 'cause']) &&
      hasOnlyKeys(result.cause, ['kind', 'rule']) &&
      isRuleId(cause.rule)) ||
    (cause.kind === 'policy' &&
      hasOnlyKeys(value, ['decision', 'cause']) &&
      hasOnlyKeys(result.cause, ['kind', 'reason']) &&
      isScanFailureReason(cause.reason))
  );
}

export function isNativeHealth(value: unknown, id: string): value is NativeHealth {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<NativeHealth>;
  return (
    message.type === 'health' &&
    message.id === id &&
    Number.isSafeInteger(message.protocol) &&
    (message.status === 'ready' || message.status === 'incompatible')
  );
}

export function unavailableOutcome(reason: ScanFailureReason): ScanOutcome {
  return { kind: 'unavailable', reason };
}
