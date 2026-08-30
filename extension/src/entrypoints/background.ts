import { browser, defineBackground } from '#imports';
import { checkNativeHost } from '../bridge/nativeClient';
import { type GuardHealthResult, originIsProtected, SUPPORTED_ORIGINS } from '../bridge/policy';
import { loadGuardPolicy } from '../bridge/policyStore';
import type { HealthCheckResult } from '../bridge/protocol';
import { preflightScan, scanFile } from '../bridge/scanService';

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
    if (!['scan-preflight', 'scan-file', 'health-check'].includes(String(messageType)))
      return false;

    const respond = (request: Promise<unknown>, fallback: unknown) => {
      void request.then(sendResponse).catch(() => sendResponse(fallback));
      return true;
    };

    if (messageType === 'scan-preflight') {
      return respond(preflightScan(message, sender.url), {
        kind: 'final',
        result: { decision: 'block', cause: { kind: 'policy', reason: 'invalid_request' } },
      });
    }
    if (messageType === 'scan-file')
      return respond(scanFile(message, sender.url), {
        decision: 'block',
        cause: { kind: 'policy', reason: 'invalid_request' },
      });

    const health = async (): Promise<GuardHealthResult> => {
      const policy = await loadGuardPolicy();
      const origin = senderOrigin(sender.url);
      const buildTimeOrigin = origin !== null && SUPPORTED_ORIGINS.includes(origin as never);
      if (!buildTimeOrigin || !originIsProtected(origin, policy)) {
        return {
          available: false,
          protocol: null,
          protected: false,
          reason: 'invalid_request',
        };
      }
      const native: HealthCheckResult = await checkNativeHost(crypto.randomUUID());
      return { ...native, protected: true };
    };
    return respond(health(), {
      available: false,
      protocol: null,
      protected: true,
      reason: 'host_unavailable',
    } satisfies GuardHealthResult);
  });
});
