import { useEffect, useRef } from 'react';
import type { RuleId, ScanFailureReason } from '../bridge/protocol';

export type UploadBlockCause =
  | { kind: 'rule'; rule: RuleId }
  | { kind: 'policy'; reason: ScanFailureReason };

export interface UploadBlockedProps {
  filename: string;
  cause: UploadBlockCause;
  onDismiss: () => void;
}

function ruleFindingCopy(rule: RuleId): string {
  switch (rule) {
    case 'openssh_private_key':
      return 'looks like an OpenSSH private key';
    case 'aws_access_key_id':
      return 'contains an AWS access-key identifier';
    case 'pkcs8_private_key':
    case 'pem_private_key':
      return 'looks like a private key (PEM)';
  }
}

function findingLabel(cause: UploadBlockCause): string {
  if (cause.kind === 'policy') {
    return cause.reason === 'too_large' ? 'Scan limit enforced' : 'Scanner unavailable';
  }
  const { rule } = cause;
  return rule === 'aws_access_key_id' ? 'Access key detected' : 'Private key detected';
}

function findingCopy(filename: string, cause: UploadBlockCause) {
  if (cause.kind === 'rule') {
    return (
      <>
        <strong>{filename}</strong> {ruleFindingCopy(cause.rule)}. It was not sent to this page. The
        file never left your machine.
      </>
    );
  }
  if (cause.reason === 'too_large') {
    return (
      <>
        <strong>{filename}</strong> exceeds the configured local scan limit. Your protection policy
        requires a completed scan, so it was not sent to this page.
      </>
    );
  }
  return (
    <>
      The local scanner could not verify <strong>{filename}</strong>. Your protection policy blocks
      unverified uploads, so it was not sent to this page.
    </>
  );
}

function ShieldMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.8 20 6v5.7c0 5-3.25 8.4-8 9.75-4.75-1.35-8-4.75-8-9.75V6l8-3.2Z" />
      <path d="M9.2 9.2 14.8 14.8M14.8 9.2 9.2 14.8" />
    </svg>
  );
}

export function UploadBlocked({ filename, cause, onDismiss }: UploadBlockedProps) {
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
      if (event.key === 'Tab') {
        event.preventDefault();
        primaryRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    primaryRef.current?.focus();
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onDismiss]);

  return (
    <div className="si-scrim">
      <button
        className="si-backdrop"
        type="button"
        tabIndex={-1}
        aria-label="Dismiss warning"
        onClick={onDismiss}
      />
      <section
        className="si-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="si-upload-title"
        aria-describedby="si-upload-description"
      >
        <div className="si-brand">
          <span className="si-brand-mark">
            <ShieldMark />
          </span>
          <span>SecureIntent</span>
          <span className="si-brand-ai">.ai</span>
        </div>
        <div className="si-divider" />
        <div className="si-alert-row">
          <div className="si-alert-mark">
            <ShieldMark />
          </div>
          <span className="si-finding">{findingLabel(cause)}</span>
        </div>
        <h1 id="si-upload-title">Upload blocked</h1>
        <p id="si-upload-description">{findingCopy(filename, cause)}</p>
        <div className="si-assurance">
          <span className="si-assurance-mark" aria-hidden="true">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m3.5 8.2 2.8 2.8 6.2-6" />
            </svg>
          </span>
          <span>
            <strong>{cause.kind === 'rule' ? 'Stopped before upload' : 'Blocked by policy'}</strong>
            <small>No file content was delivered to this destination.</small>
          </span>
        </div>
        <button ref={primaryRef} className="si-primary" type="button" onClick={onDismiss}>
          Got it
        </button>
        <div className="si-footnote">
          <span>
            {cause.kind === 'rule'
              ? 'Scanned locally · Zero retention'
              : 'Local scan required · Upload not released'}
          </span>
          <span>
            <kbd>Esc</kbd> to dismiss
          </span>
        </div>
      </section>
    </div>
  );
}
