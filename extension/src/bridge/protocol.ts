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

export interface ScanFileRequest {
  type: 'scan-file';
  scanId: string;
  name: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
}

export type ScanFailureReason =
  | 'host_unavailable'
  | 'host_disconnected'
  | 'invalid_request'
  | 'invalid_response'
  | 'protocol_mismatch'
  | 'timeout'
  | 'too_large';

export interface ScanFileResult {
  decision: 'allow' | 'block';
  rule: RuleId | null;
  failOpen: boolean;
  reason?: ScanFailureReason;
}

export type ScanOutcome =
  | {
      kind: 'verdict';
      decision: 'allow' | 'block';
      rule: RuleId | null;
    }
  | {
      kind: 'unavailable';
      reason: ScanFailureReason;
    };

export type NativeRequest =
  | { type: 'health'; id: string; protocol: number }
  | { type: 'scan_begin'; id: string; name: string; size: number; protocol: number }
  | { type: 'scan_chunk'; id: string; offset: number; data: string }
  | { type: 'scan_end'; id: string };

export interface NativeVerdict {
  type: 'verdict';
  id: string;
  decision: 'allow' | 'block';
  rule: RuleId | null;
}

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

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function isScanFileRequest(value: unknown): value is ScanFileRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ScanFileRequest>;
  return (
    message.type === 'scan-file' &&
    typeof message.scanId === 'string' &&
    message.scanId.length > 0 &&
    message.scanId.length <= 64 &&
    /^[A-Za-z0-9_-]+$/u.test(message.scanId) &&
    typeof message.name === 'string' &&
    message.name.length > 0 &&
    new TextEncoder().encode(message.name).byteLength <= 512 &&
    !containsControlCharacter(message.name) &&
    typeof message.mime === 'string' &&
    message.mime.length <= 256 &&
    Number.isSafeInteger(message.size) &&
    (message.size ?? -1) >= 0 &&
    message.bytes instanceof Uint8Array
  );
}

export function isNativeVerdict(value: unknown, scanId: string): value is NativeVerdict {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<NativeVerdict>;
  const envelopeIsValid =
    message.type === 'verdict' &&
    message.id === scanId &&
    (message.decision === 'allow' || message.decision === 'block') &&
    (message.rule === null || isRuleId(message.rule));
  if (!envelopeIsValid) return false;
  return message.decision === 'allow' ? message.rule === null : isRuleId(message.rule);
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
