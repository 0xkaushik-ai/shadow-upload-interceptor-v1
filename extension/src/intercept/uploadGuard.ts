import { browser } from 'wxt/browser';
import type { FailureAction, GuardHealthResult } from '../bridge/policy';
import {
  isScanFileResult,
  type ScanFailureReason,
  type ScanFileResult,
  type ScanPreflightResult,
} from '../bridge/protocol';
import type { DaemonStatusState } from '../overlay/DaemonStatus';
import { mountDaemonStatus } from '../overlay/mountDaemonStatus';
import { mountUploadOverlay } from '../overlay/mountUploadOverlay';
import type { UploadBlockCause } from '../overlay/UploadBlocked';
import { resumeIntoInput } from './resumeUpload';

const FILE_INPUT_SELECTOR = 'input[type="file"]';
const CONTENT_HEALTH_TIMEOUT_MS = 2_000;
// The content script has no policy copy. This fixed outer deadline only prevents a wedged worker
// from retaining page bytes forever, and always resolves fail-closed.
const CONTENT_SCAN_TIMEOUT_MS = 12_000;
const HEALTH_POLL_INTERVAL_MS = 10_000;
const RESTORED_DISPLAY_MS = 3_000;

interface DemoStatus {
  state: 'scanning' | 'allowed' | 'blocked' | 'canceled';
}

interface InputOperation {
  suppressFollowingChange: boolean;
  scanning: boolean;
  removeOverlay: (() => void) | null;
}

export interface UploadGuardOptions {
  requestHealth?: () => Promise<GuardHealthResult>;
  requestScan?: (file: File) => Promise<ScanFileResult>;
  isTrustedEvent?: (event: Event) => boolean;
  healthPollIntervalMs?: number;
}

function notifyPage(status: DemoStatus): void {
  document.documentElement.dataset.secureintentStatus = JSON.stringify(status);
}

function failClosed(reason: ScanFailureReason): ScanFileResult {
  return { decision: 'block', cause: { kind: 'policy', reason } };
}

function settleWithTimeout<T>(request: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    void request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function requestScanThroughBackground(file: File): Promise<ScanFileResult> {
  const scanId = crypto.randomUUID();
  const preflight = (await browser.runtime.sendMessage({
    type: 'scan-preflight',
    scanId,
    size: file.size,
  })) as ScanPreflightResult;
  if (!preflight || typeof preflight !== 'object') return failClosed('invalid_response');
  if (preflight.kind === 'final')
    return isScanFileResult(preflight.result) ? preflight.result : failClosed('invalid_response');
  if (preflight.kind !== 'scan') return failClosed('invalid_response');

  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    const result = (await browser.runtime.sendMessage({
      type: 'scan-file',
      scanId,
      size: file.size,
      bytes,
    })) as unknown;
    return isScanFileResult(result) ? result : failClosed('invalid_response');
  } catch {
    return failClosed('host_unavailable');
  } finally {
    bytes?.fill(0);
  }
}

function containsFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function fileInputFromElement(element: Element): HTMLInputElement | null {
  if (element instanceof HTMLInputElement && element.matches(FILE_INPUT_SELECTOR)) return element;
  const label = element.closest('label');
  return label?.control instanceof HTMLInputElement && label.control.matches(FILE_INPUT_SELECTOR)
    ? label.control
    : null;
}

function fileInputForEvent(event: Event): HTMLInputElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof Element) {
      const input = fileInputFromElement(target);
      if (input) return input;
    }
  }
  const inputs = document.querySelectorAll<HTMLInputElement>(FILE_INPUT_SELECTOR);
  return inputs.length === 1 ? inputs.item(0) : null;
}

function blockCause(result: Extract<ScanFileResult, { decision: 'block' }>): UploadBlockCause {
  return result.cause;
}

export function installUploadGuard(options: UploadGuardOptions = {}): () => void {
  const checkHealth = options.requestHealth;
  const scanFile = options.requestScan ?? requestScanThroughBackground;
  const isTrustedEvent = options.isTrustedEvent ?? ((event: Event) => event.isTrusted);
  const operations = new WeakMap<HTMLInputElement, InputOperation>();
  const activeOperations = new Set<InputOperation>();
  let unresolvedDropOverlay: (() => void) | null = null;
  let installed = true;
  const healthPollIntervalMs = options.healthPollIntervalMs ?? HEALTH_POLL_INTERVAL_MS;
  let healthInFlight = false;
  let scanningCount = 0;
  let lastAvailable: boolean | null = null;
  let onUnavailable: FailureAction = 'block';
  let statusMounted = true;
  let restoredTimer: ReturnType<typeof setTimeout> | null = null;
  const daemonStatus = mountDaemonStatus('checking', onUnavailable);
  document.documentElement.dataset.secureintentGuard = 'checking';

  const setDaemonStatus = (state: DaemonStatusState) => {
    if (!installed || !statusMounted) return;
    daemonStatus.update(state, onUnavailable);
  };

  const showAvailable = () => {
    const restored = lastAvailable === false;
    lastAvailable = true;
    document.documentElement.dataset.secureintentGuard = 'active';
    if (scanningCount > 0) return;
    if (restored) {
      setDaemonStatus('restored');
      if (restoredTimer) clearTimeout(restoredTimer);
      restoredTimer = setTimeout(() => {
        restoredTimer = null;
        if (installed && scanningCount === 0 && lastAvailable) setDaemonStatus('online');
      }, RESTORED_DISPLAY_MS);
      return;
    }
    setDaemonStatus('online');
  };

  const showUnavailable = () => {
    lastAvailable = false;
    document.documentElement.dataset.secureintentGuard = 'degraded';
    if (scanningCount === 0) setDaemonStatus('offline');
  };

  const applyHealth = (health: GuardHealthResult) => {
    onUnavailable = health.onUnavailable;
    if (!health.protected) {
      delete document.documentElement.dataset.secureintentGuard;
      daemonStatus.remove();
      statusMounted = false;
      return;
    }
    if (health.available) showAvailable();
    else showUnavailable();
  };

  const healthRequest =
    checkHealth ??
    (() => browser.runtime.sendMessage({ type: 'health-check' }) as Promise<GuardHealthResult>);
  const refreshHealth = async () => {
    if (!installed || !statusMounted || healthInFlight || scanningCount > 0) return;
    healthInFlight = true;
    try {
      applyHealth(
        await settleWithTimeout(healthRequest(), CONTENT_HEALTH_TIMEOUT_MS, {
          available: false,
          protocol: null,
          protected: true,
          onUnavailable: 'block',
          reason: 'timeout',
        }),
      );
    } finally {
      healthInFlight = false;
    }
  };

  void refreshHealth();
  const healthPoll = setInterval(() => {
    if (document.visibilityState !== 'hidden') void refreshHealth();
  }, healthPollIntervalMs);
  const refreshWhenVisible = () => {
    if (document.visibilityState !== 'hidden') void refreshHealth();
  };
  window.addEventListener('focus', refreshWhenVisible);
  document.addEventListener('visibilitychange', refreshWhenVisible);

  const showKnownStatus = () => {
    if (scanningCount > 0) return;
    if (lastAvailable === true) setDaemonStatus('online');
    else if (lastAvailable === false) setDaemonStatus('offline');
    else setDaemonStatus('checking');
  };

  const applyScanHealth = (result: ScanFileResult) => {
    if (result.decision === 'allow') {
      if (result.source === 'scanner') showAvailable();
      else if (result.source === 'policy' && result.reason !== 'too_large') showUnavailable();
      else showKnownStatus();
      return;
    }
    if (result.cause.kind === 'rule') showAvailable();
    else if (result.cause.reason === 'too_large') showKnownStatus();
    else showUnavailable();
  };

  const start = (file: File, input: HTMLInputElement, suppressFollowingChange: boolean) => {
    const previous = operations.get(input);
    previous?.removeOverlay?.();
    if (previous?.scanning) scanningCount -= 1;
    if (previous) activeOperations.delete(previous);
    const operation: InputOperation = {
      suppressFollowingChange,
      scanning: true,
      removeOverlay: null,
    };
    operations.set(input, operation);
    activeOperations.add(operation);
    scanningCount += 1;
    setDaemonStatus('scanning');
    notifyPage({ state: 'scanning' });

    void settleWithTimeout(scanFile(file), CONTENT_SCAN_TIMEOUT_MS, failClosed('timeout')).then(
      (result) => {
        if (!installed || operations.get(input) !== operation) return;
        operation.scanning = false;
        scanningCount = Math.max(0, scanningCount - 1);
        applyScanHealth(result);
        if (result.decision === 'block') {
          notifyPage({ state: 'blocked' });
          operation.removeOverlay = mountUploadOverlay(file.name, blockCause(result)).remove;
          return;
        }
        activeOperations.delete(operation);
        if (!input.isConnected || operations.get(input) !== operation) {
          notifyPage({ state: 'canceled' });
          return;
        }
        notifyPage({ state: 'allowed' });
        if (!resumeIntoInput(input, file)) notifyPage({ state: 'canceled' });
      },
    );
  };

  const interceptInput = (event: Event) => {
    if (!installed || !isTrustedEvent(event)) return;
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches(FILE_INPUT_SELECTOR)) return;
    const file = input.files?.[0];
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    start(file, input, true);
  };

  const interceptChange = (event: Event) => {
    if (!installed || !isTrustedEvent(event)) return;
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches(FILE_INPUT_SELECTOR)) return;
    const operation = operations.get(input);
    if (operation?.suppressFollowingChange) {
      operation.suppressFollowingChange = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Fallback for engines that emit only change after a picker selection.
    const file = input.files?.[0];
    if (!file) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    start(file, input, false);
  };

  const onDragOver = (event: DragEvent) => {
    if (!installed || !isTrustedEvent(event) || !containsFiles(event) || !fileInputForEvent(event))
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (event: DragEvent) => {
    if (!installed || !isTrustedEvent(event) || !containsFiles(event)) return;
    // A destination page must never receive a trusted file drop, even when this demo cannot map
    // its drop zone to one unambiguous native input.
    event.preventDefault();
    event.stopImmediatePropagation();
    const file = event.dataTransfer?.files?.[0];
    const input = fileInputForEvent(event);
    if (!file || !input) {
      unresolvedDropOverlay?.();
      unresolvedDropOverlay = mountUploadOverlay(file?.name ?? 'Selected file', {
        kind: 'policy',
        reason: 'invalid_request',
      }).remove;
      document.documentElement.dataset.secureintentGuard = 'degraded';
      notifyPage({ state: 'blocked' });
      return;
    }
    unresolvedDropOverlay?.();
    unresolvedDropOverlay = null;
    input.value = '';
    start(file, input, false);
  };

  window.addEventListener('input', interceptInput, true);
  window.addEventListener('change', interceptChange, true);
  window.addEventListener('dragover', onDragOver, true);
  window.addEventListener('drop', onDrop, true);
  return () => {
    installed = false;
    clearInterval(healthPoll);
    if (restoredTimer) clearTimeout(restoredTimer);
    for (const operation of activeOperations) operation.removeOverlay?.();
    activeOperations.clear();
    unresolvedDropOverlay?.();
    daemonStatus.remove();
    delete document.documentElement.dataset.secureintentGuard;
    delete document.documentElement.dataset.secureintentStatus;
    window.removeEventListener('focus', refreshWhenVisible);
    document.removeEventListener('visibilitychange', refreshWhenVisible);
    window.removeEventListener('input', interceptInput, true);
    window.removeEventListener('change', interceptChange, true);
    window.removeEventListener('dragover', onDragOver, true);
    window.removeEventListener('drop', onDrop, true);
  };
}
