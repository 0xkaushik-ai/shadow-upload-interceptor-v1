import { browser } from 'wxt/browser';
import type { GuardHealthResult } from '../bridge/policy';
import {
  isScanFileResult,
  type ScanFailureReason,
  type ScanFileResult,
  type ScanPreflightResult,
} from '../bridge/protocol';
import { mountUploadOverlay } from '../overlay/mountUploadOverlay';
import type { UploadBlockCause } from '../overlay/UploadBlocked';
import { resumeIntoInput } from './resumeUpload';

const FILE_INPUT_SELECTOR = 'input[type="file"]';
const CONTENT_HEALTH_TIMEOUT_MS = 2_000;
// The content script has no policy copy. This fixed outer deadline only prevents a wedged worker
// from retaining page bytes forever, and always resolves fail-closed.
const CONTENT_SCAN_TIMEOUT_MS = 12_000;

interface DemoStatus {
  state: 'scanning' | 'allowed' | 'blocked' | 'canceled';
}

interface InputOperation {
  suppressFollowingChange: boolean;
  removeOverlay: (() => void) | null;
}

export interface UploadGuardOptions {
  requestHealth?: () => Promise<GuardHealthResult>;
  requestScan?: (file: File) => Promise<ScanFileResult>;
  isTrustedEvent?: (event: Event) => boolean;
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
  document.documentElement.dataset.secureintentGuard = 'checking';

  const healthRequest =
    checkHealth ??
    (() => browser.runtime.sendMessage({ type: 'health-check' }) as Promise<GuardHealthResult>);
  void settleWithTimeout(healthRequest(), CONTENT_HEALTH_TIMEOUT_MS, {
    available: false,
    protocol: null,
    protected: true,
    reason: 'timeout',
  }).then((health) => {
    if (!installed) return;
    if (!health.protected) {
      delete document.documentElement.dataset.secureintentGuard;
      return;
    }
    document.documentElement.dataset.secureintentGuard = health.available ? 'active' : 'degraded';
  });

  const start = (file: File, input: HTMLInputElement, suppressFollowingChange: boolean) => {
    const previous = operations.get(input);
    previous?.removeOverlay?.();
    if (previous) activeOperations.delete(previous);
    const operation: InputOperation = {
      suppressFollowingChange,
      removeOverlay: null,
    };
    operations.set(input, operation);
    activeOperations.add(operation);
    notifyPage({ state: 'scanning' });

    void settleWithTimeout(scanFile(file), CONTENT_SCAN_TIMEOUT_MS, failClosed('timeout')).then(
      (result) => {
        if (!installed || operations.get(input) !== operation) return;
        if (result.decision === 'block') {
          document.documentElement.dataset.secureintentGuard =
            result.cause.kind === 'policy' && result.cause.reason !== 'too_large'
              ? 'degraded'
              : 'active';
          notifyPage({ state: 'blocked' });
          operation.removeOverlay = mountUploadOverlay(file.name, blockCause(result)).remove;
          return;
        }
        activeOperations.delete(operation);
        if (result.source === 'policy')
          document.documentElement.dataset.secureintentGuard = 'degraded';
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
    for (const operation of activeOperations) operation.removeOverlay?.();
    activeOperations.clear();
    unresolvedDropOverlay?.();
    delete document.documentElement.dataset.secureintentGuard;
    delete document.documentElement.dataset.secureintentStatus;
    window.removeEventListener('input', interceptInput, true);
    window.removeEventListener('change', interceptChange, true);
    window.removeEventListener('dragover', onDragOver, true);
    window.removeEventListener('drop', onDrop, true);
  };
}
