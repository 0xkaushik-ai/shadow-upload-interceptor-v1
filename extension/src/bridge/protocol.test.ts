import { describe, expect, test } from 'vitest';
import {
  isNativeHealth,
  isNativeVerdict,
  isRuleId,
  isScanFileRequest,
  MAX_FILE_BYTES,
  PROTOCOL_VERSION,
  RULE_IDS,
  unavailableOutcome,
} from './protocol';

describe('extension bridge protocol', () => {
  test('accepts a bounded typed-byte scan request', () => {
    expect(
      isScanFileRequest({
        type: 'scan-file',
        scanId: '80bb0ad2-25f6-494a-9101-1f547dfa79bb',
        name: 'allow.txt',
        mime: 'text/plain',
        size: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).toBe(true);
  });

  test('rejects plain objects in place of typed bytes', () => {
    expect(
      isScanFileRequest({
        type: 'scan-file',
        scanId: 'id',
        name: 'file',
        mime: '',
        size: 1,
        bytes: { 0: 1 },
      }),
    ).toBe(false);
  });

  test('rejects control characters and oversized UTF-8 filename metadata', () => {
    const baseRequest = {
      type: 'scan-file',
      scanId: 'scan-1',
      mime: 'text/plain',
      size: 0,
      bytes: new Uint8Array(),
    };
    expect(isScanFileRequest({ ...baseRequest, name: 'line\nbreak.txt' })).toBe(false);
    expect(isScanFileRequest({ ...baseRequest, name: '界'.repeat(200) })).toBe(false);
    expect(isScanFileRequest({ ...baseRequest, scanId: 'bad/id', name: 'safe.txt' })).toBe(false);
  });

  test('accepts only the matching verdict and known rule', () => {
    expect(
      isNativeVerdict(
        {
          type: 'verdict',
          id: 'scan-1',
          decision: 'block',
          rule: 'pem_private_key',
        },
        'scan-1',
      ),
    ).toBe(true);
    expect(
      isNativeVerdict(
        { type: 'verdict', id: 'some-other-scan', decision: 'block', rule: 'pem_private_key' },
        'scan-1',
      ),
    ).toBe(false);

    expect(
      isNativeVerdict(
        { type: 'verdict', id: 'scan-1', decision: 'block', rule: 'made_up_rule' },
        'scan-1',
      ),
    ).toBe(false);
    expect(
      isNativeVerdict({ type: 'verdict', id: 'scan-1', decision: 'block', rule: null }, 'scan-1'),
    ).toBe(false);
    expect(
      isNativeVerdict(
        { type: 'verdict', id: 'scan-1', decision: 'allow', rule: 'pem_private_key' },
        'scan-1',
      ),
    ).toBe(false);
  });

  test('recognizes every registered content rule', () => {
    expect(RULE_IDS.every((rule) => isRuleId(rule))).toBe(true);
    expect(isRuleId('filename_extension')).toBe(false);
  });

  test('requires a matching, versioned native health response', () => {
    expect(
      isNativeHealth(
        {
          type: 'health',
          id: 'health-1',
          protocol: PROTOCOL_VERSION,
          status: 'ready',
        },
        'health-1',
      ),
    ).toBe(true);
    expect(
      isNativeHealth(
        { type: 'health', id: 'another-id', protocol: PROTOCOL_VERSION, status: 'ready' },
        'health-1',
      ),
    ).toBe(false);
  });

  test('transport failures remain distinct from scanner verdicts', () => {
    expect(unavailableOutcome('timeout')).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
  });
});
