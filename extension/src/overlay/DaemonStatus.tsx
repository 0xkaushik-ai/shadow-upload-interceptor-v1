import type { FailureAction } from '../bridge/policy';

export type DaemonStatusState = 'checking' | 'online' | 'scanning' | 'offline' | 'restored';

const DAEMON_STATUS_COPY: Record<DaemonStatusState, { title: string; detail: string }> = {
  checking: {
    title: 'Checking local scanner',
    detail: 'Confirming the daemon connection…',
  },
  online: {
    title: 'Local scanner online',
    detail: 'Upload protection is active.',
  },
  scanning: {
    title: 'Scanning locally',
    detail: 'The file has not been released to this page.',
  },
  offline: {
    title: 'Local scanner offline',
    detail: 'Unverified uploads are blocked by policy.',
  },
  restored: {
    title: 'Local scanner restored',
    detail: 'Upload protection is active again.',
  },
};

export function daemonStatusCopy(state: DaemonStatusState, onUnavailable: FailureAction) {
  if (state !== 'offline') return DAEMON_STATUS_COPY[state];
  return {
    title: 'Local scanner offline',
    detail:
      onUnavailable === 'block'
        ? 'Unverified uploads are blocked by policy.'
        : 'Development policy permits unverified uploads.',
  };
}

function ShieldMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.8 20 6v5.7c0 5-3.25 8.4-8 9.75-4.75-1.35-8-4.75-8-9.75V6l8-3.2Z" />
      <path d="m8.7 12 2.1 2.1 4.7-4.8" />
    </svg>
  );
}

export function DaemonStatus({
  state,
  onUnavailable,
}: {
  state: DaemonStatusState;
  onUnavailable: FailureAction;
}) {
  const copy = daemonStatusCopy(state, onUnavailable);
  return (
    <section className="si-daemon-card" data-state={state} role="status" aria-live="polite">
      <span className="si-daemon-mark" aria-hidden="true">
        <ShieldMark />
      </span>
      <span className="si-daemon-copy">
        <strong>{copy.title}</strong>
        <small>{copy.detail}</small>
      </span>
      <span className="si-daemon-dot" aria-hidden="true" />
    </section>
  );
}
