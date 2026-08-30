import { createRoot } from 'react-dom/client';
import type { FailureAction } from '../bridge/policy';
import { DaemonStatus, type DaemonStatusState } from './DaemonStatus';
import { daemonStatusStyles } from './daemonStatusStyles';

export interface DaemonStatusHandle {
  update: (state: DaemonStatusState, onUnavailable: FailureAction) => void;
  remove: () => void;
}

export function mountDaemonStatus(
  initialState: DaemonStatusState,
  initialFailureAction: FailureAction,
): DaemonStatusHandle {
  const host = document.createElement('secureintent-daemon-status');
  host.style.position = 'fixed';
  host.style.top = '16px';
  host.style.right = '16px';
  host.style.zIndex = '2147483646';
  host.style.pointerEvents = 'none';
  host.dataset.state = initialState;

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = daemonStatusStyles;
  const container = document.createElement('div');
  shadow.append(style, container);
  document.documentElement.append(host);

  const root = createRoot(container);
  let removed = false;
  const update = (state: DaemonStatusState, onUnavailable: FailureAction) => {
    if (removed) return;
    host.dataset.state = state;
    root.render(<DaemonStatus state={state} onUnavailable={onUnavailable} />);
  };
  const remove = () => {
    if (removed) return;
    removed = true;
    root.unmount();
    host.remove();
  };

  update(initialState, initialFailureAction);
  return { update, remove };
}
