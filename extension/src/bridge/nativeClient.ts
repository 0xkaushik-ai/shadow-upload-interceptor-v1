import { browser } from 'wxt/browser';
import {
  HEALTH_TIMEOUT_MS,
  type HealthCheckResult,
  isNativeHealth,
  isNativeVerdict,
  NATIVE_HOST,
  NATIVE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RAW_CHUNK_BYTES,
  type ScanFileRequest,
  type ScanOutcome,
  unavailableOutcome,
} from './protocol';

function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const sliceSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += sliceSize) {
    const slice = bytes.subarray(offset, Math.min(offset + sliceSize, bytes.length));
    let binary = '';
    for (const byte of slice) binary += String.fromCharCode(byte);
    parts.push(binary);
  }
  return btoa(parts.join(''));
}

/** One Native Messaging process and port per scan. Chrome owns the u32 framing. */
export function scanWithNativeHost(
  request: ScanFileRequest,
  timeoutMs = NATIVE_TIMEOUT_MS,
): Promise<ScanOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let port: ReturnType<typeof browser.runtime.connectNative> | undefined;

    const finish = (result: ScanOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port?.disconnect();
      } catch {
        // Already disconnected.
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(unavailableOutcome('timeout')), timeoutMs);

    try {
      port = browser.runtime.connectNative(NATIVE_HOST);
      port.onMessage.addListener((message: unknown) => {
        if (!isNativeVerdict(message, request.scanId)) {
          finish(unavailableOutcome('invalid_response'));
          return;
        }
        finish({
          kind: 'verdict',
          decision: message.decision,
          rule: message.rule,
        });
      });
      port.onDisconnect.addListener(() => finish(unavailableOutcome('host_disconnected')));

      port.postMessage({
        type: 'scan_begin',
        id: request.scanId,
        name: request.name,
        size: request.size,
        protocol: PROTOCOL_VERSION,
      });
      for (let offset = 0; offset < request.bytes.length; offset += RAW_CHUNK_BYTES) {
        const chunk = request.bytes.subarray(
          offset,
          Math.min(offset + RAW_CHUNK_BYTES, request.bytes.length),
        );
        port.postMessage({
          type: 'scan_chunk',
          id: request.scanId,
          offset,
          data: encodeBase64(chunk),
        });
      }
      port.postMessage({ type: 'scan_end', id: request.scanId });
    } catch {
      finish(unavailableOutcome('host_unavailable'));
    }
  });
}

/** Confirms that Chrome can launch a host speaking this exact protocol version. */
export function checkNativeHost(id: string): Promise<HealthCheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    let port: ReturnType<typeof browser.runtime.connectNative> | undefined;

    const finish = (result: HealthCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port?.disconnect();
      } catch {
        // Already disconnected.
      }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ available: false, protocol: null, reason: 'timeout' }),
      HEALTH_TIMEOUT_MS,
    );

    try {
      port = browser.runtime.connectNative(NATIVE_HOST);
      port.onMessage.addListener((message: unknown) => {
        if (!isNativeHealth(message, id)) {
          finish({ available: false, protocol: null, reason: 'invalid_response' });
          return;
        }
        if (message.status !== 'ready' || message.protocol !== PROTOCOL_VERSION) {
          finish({
            available: false,
            protocol: message.protocol,
            reason: 'protocol_mismatch',
          });
          return;
        }
        finish({ available: true, protocol: message.protocol });
      });
      port.onDisconnect.addListener(() =>
        finish({ available: false, protocol: null, reason: 'host_disconnected' }),
      );
      port.postMessage({ type: 'health', id, protocol: PROTOCOL_VERSION });
    } catch {
      finish({ available: false, protocol: null, reason: 'host_unavailable' });
    }
  });
}
