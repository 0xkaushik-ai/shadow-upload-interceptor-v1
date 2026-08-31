import { browser, defineBackground } from '#imports';
import { checkNativeHost, scanWithNativeHost } from '../bridge/nativeClient';
import {
  type GuardHealthResult,
  originIsProtected,
  resolveScanOutcome,
  SECURE_FALLBACK_POLICY,
} from '../bridge/policy';
import { loadGuardPolicy } from '../bridge/policyStore';
import {
  type HealthCheckResult,
  isScanFileRequest,
  type ScanFileResult,
  unavailableOutcome,
} from '../bridge/protocol';

function senderOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const messageType = (message as { type?: unknown })?.type;
    if (messageType !== 'scan-file' && messageType !== 'health-check') return false;

    if (messageType === 'health-check') {
      const handleHealth = async (): Promise<GuardHealthResult> => {
        const policy = await loadGuardPolicy();
        const origin = senderOrigin(sender.url);
        const protectedOrigin = origin !== null && originIsProtected(origin, policy);
        if (!protectedOrigin) {
          return {
            available: false,
            protocol: null,
            protected: false,
            policy,
            reason: 'invalid_request',
          };
        }
        const health: HealthCheckResult = await checkNativeHost(crypto.randomUUID());
        return { ...health, protected: true, policy };
      };

      void handleHealth()
        .then(sendResponse)
        .catch(() =>
          sendResponse({
            available: false,
            protocol: null,
            protected: true,
            policy: SECURE_FALLBACK_POLICY,
            reason: 'host_unavailable',
          } satisfies GuardHealthResult),
        );
      return true;
    }

    const handle = async (): Promise<ScanFileResult> => {
      const policy = await loadGuardPolicy();
      const origin = senderOrigin(sender.url);
      if (origin === null || !originIsProtected(origin, policy)) {
        return resolveScanOutcome(unavailableOutcome('invalid_request'), SECURE_FALLBACK_POLICY);
      }
      if (!isScanFileRequest(message)) {
        return resolveScanOutcome(unavailableOutcome('invalid_request'), policy);
      }

      try {
        if (message.size !== message.bytes.byteLength) {
          return resolveScanOutcome(unavailableOutcome('invalid_request'), policy);
        }
        if (message.size > policy.maxFileBytes) {
          return resolveScanOutcome(unavailableOutcome('too_large'), policy);
        }
        const outcome = await scanWithNativeHost(message, policy.scanTimeoutMs);
        return resolveScanOutcome(outcome, policy);
      } finally {
        // Best-effort scrubbing of the worker's structured-clone allocation.
        message.bytes.fill(0);
      }
    };

    void handle()
      .then(sendResponse)
      .catch(() =>
        sendResponse(
          resolveScanOutcome(unavailableOutcome('host_unavailable'), SECURE_FALLBACK_POLICY),
        ),
      );
    return true;
  });
});
