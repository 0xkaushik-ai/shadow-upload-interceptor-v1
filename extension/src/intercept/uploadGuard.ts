import { browser } from 'wxt/browser';
import {
  type GuardHealthResult,
  type GuardPolicy,
  originIsProtected,
  resolveScanOutcome,
  SECURE_FALLBACK_POLICY,
} from '../bridge/policy';
import {
  type ScanFailureReason,
  type ScanFileResult,
  unavailableOutcome,
} from '../bridge/protocol';
import { mountUploadOverlay } from '../overlay/mountUploadOverlay';
import type { UploadBlockCause } from '../overlay/UploadBlocked';
import { resumeIntoInput } from './resumeUpload';

const FILE_INPUT_SELECTOR = 'input[type="file"]';
const CONTENT_TIMEOUT_GRACE_MS = 1_000;
const CONTENT_HEALTH_TIMEOUT_MS = 2_000;
let warnedFailOpen = false;

interface DemoStatus {
  state: 'scanning' | 'allowed' | 'blocked' | 'canceled';
}

export interface UploadGuardOptions {
  requestHealth?: () => Promise<GuardHealthResult>;
  requestScan?: (file: File, policy: GuardPolicy) => Promise<ScanFileResult>;
  isTrustedEvent?: (event: Event) => boolean;
}

function notifyPage(status: DemoStatus): void {
  // This channel is presentation-only and deliberately contains no filename, rule, or file data.
  // Enforcement never trusts values written into the destination page's DOM.
  document.documentElement.dataset.secureintentStatus = JSON.stringify(status);
}

function fallbackResult(reason: ScanFailureReason, policy: GuardPolicy): ScanFileResult {
  return resolveScanOutcome(unavailableOutcome(reason), policy);
}

function settleWithTimeout<T>(request: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function requestScan(file: File, policy: GuardPolicy): Promise<ScanFileResult> {
  if (file.size > policy.maxFileBytes) return fallbackResult('too_large', policy);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const request = browser.runtime.sendMessage({
    type: 'scan-file',
    scanId: crypto.randomUUID(),
    name: file.name,
    mime: file.type,
    size: file.size,
    bytes,
  }) as Promise<ScanFileResult>;

  try {
    return await settleWithTimeout(
      request,
      policy.scanTimeoutMs + CONTENT_TIMEOUT_GRACE_MS,
      fallbackResult('timeout', policy),
    );
  } finally {
    // V8 may retain other copies, but this content-script allocation no longer needs the bytes.
    bytes.fill(0);
  }
}

async function requestHealth(): Promise<GuardHealthResult> {
  const request = browser.runtime.sendMessage({
    type: 'health-check',
  }) as Promise<GuardHealthResult>;
  return settleWithTimeout(request, CONTENT_HEALTH_TIMEOUT_MS, {
    available: false,
    protocol: null,
    protected: true,
    policy: SECURE_FALLBACK_POLICY,
    reason: 'timeout',
  });
}

function containsFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function fileInputFromElement(element: Element): HTMLInputElement | null {
  if (element instanceof HTMLInputElement && element.matches(FILE_INPUT_SELECTOR)) return element;

  const label = element.closest('label');
  if (label?.control instanceof HTMLInputElement && label.control.matches(FILE_INPUT_SELECTOR)) {
    return label.control;
  }

  return null;
}

function fileInputForEvent(event: Event): HTMLInputElement | null {
  for (const target of event.composedPath()) {
    if (target instanceof Element) {
      const input = fileInputFromElement(target);
      if (input) return input;
    }
  }

  const inputs = document.querySelectorAll<HTMLInputElement>(FILE_INPUT_SELECTOR);
  return inputs.length === 1 ? (inputs.item(0) ?? null) : null;
}

function blockCause(result: ScanFileResult): UploadBlockCause {
  if (result.rule) return { kind: 'rule', rule: result.rule };
  return { kind: 'policy', reason: result.reason ?? 'invalid_response' };
}

export function installUploadGuard(options: UploadGuardOptions = {}): () => void {
  const checkHealth = options.requestHealth ?? requestHealth;
  const scanFile = options.requestScan ?? requestScan;
  const isTrustedEvent = options.isTrustedEvent ?? ((event: Event) => event.isTrusted);

  let generation = 0;
  let installed = true;
  let protectionEnabled = true;
  let policy = SECURE_FALLBACK_POLICY;
  let removeOverlay: (() => void) | null = null;
  document.documentElement.dataset.secureintentGuard = 'checking';

  const healthGeneration = generation;
  void checkHealth()
    .then((health) => {
      if (!installed) return;
      policy = health.policy;
      protectionEnabled = health.protected && originIsProtected(location.origin, policy);
      if (!protectionEnabled) {
        delete document.documentElement.dataset.secureintentGuard;
        return;
      }
      if (generation === healthGeneration) {
        document.documentElement.dataset.secureintentGuard = health.available
          ? 'active'
          : 'degraded';
      }
    })
    .catch(() => {
      if (!installed || generation !== healthGeneration) return;
      document.documentElement.dataset.secureintentGuard = 'degraded';
    });

  const processFile = async (file: File, input: HTMLInputElement, ownGeneration: number) => {
    removeOverlay?.();
    removeOverlay = null;
    notifyPage({ state: 'scanning' });

    let result: ScanFileResult;
    try {
      result = await scanFile(file, policy);
    } catch {
      result = fallbackResult('host_unavailable', policy);
    }
    if (!installed || generation !== ownGeneration) return;

    if (result.reason && result.reason !== 'too_large') {
      document.documentElement.dataset.secureintentGuard = 'degraded';
    } else {
      document.documentElement.dataset.secureintentGuard = 'active';
    }

    if (result.decision === 'block') {
      notifyPage({ state: 'blocked' });
      const overlay = mountUploadOverlay(file.name, blockCause(result));
      removeOverlay = overlay.remove;
      return;
    }

    if (result.failOpen && !warnedFailOpen) {
      warnedFailOpen = true;
      console.warn('SecureIntent policy allowed an unverified upload.', result.reason);
    }

    if (!input.isConnected) {
      notifyPage({ state: 'canceled' });
      console.warn(
        'SecureIntent did not resume into a file input that was removed during scanning.',
      );
      return;
    }

    notifyPage({ state: 'allowed' });
    if (!resumeIntoInput(input, file)) {
      notifyPage({ state: 'canceled' });
      console.warn('SecureIntent could not reconstruct the file input after scanning.');
    }
  };

  const onChange = (event: Event) => {
    if (!installed || !protectionEnabled || !isTrustedEvent(event)) return;
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches(FILE_INPUT_SELECTOR)) return;
    const file = input.files?.[0];
    if (!file) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    const ownGeneration = ++generation;
    void processFile(file, input, ownGeneration);
  };

  const onDragOver = (event: DragEvent) => {
    if (
      !installed ||
      !protectionEnabled ||
      !isTrustedEvent(event) ||
      !containsFiles(event) ||
      !fileInputForEvent(event)
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (event: DragEvent) => {
    if (!installed || !protectionEnabled || !isTrustedEvent(event) || !containsFiles(event)) return;
    const file = event.dataTransfer?.files?.[0];
    const input = fileInputForEvent(event);
    if (!file || !input) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    const ownGeneration = ++generation;
    void processFile(file, input, ownGeneration);
  };

  window.addEventListener('change', onChange, true);
  window.addEventListener('dragover', onDragOver, true);
  window.addEventListener('drop', onDrop, true);

  return () => {
    installed = false;
    generation += 1;
    removeOverlay?.();
    delete document.documentElement.dataset.secureintentGuard;
    delete document.documentElement.dataset.secureintentStatus;
    window.removeEventListener('change', onChange, true);
    window.removeEventListener('dragover', onDragOver, true);
    window.removeEventListener('drop', onDrop, true);
  };
}
