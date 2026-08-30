import { createRoot } from 'react-dom/client';
import { overlayStyles } from './styles';
import { type UploadBlockCause, UploadBlocked } from './UploadBlocked';

let removeActive: (() => void) | null = null;

export function mountUploadOverlay(
  filename: string,
  cause: UploadBlockCause,
): { remove: () => void } {
  removeActive?.();

  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const host = document.createElement('secureintent-shadow-warning');
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.zIndex = '2147483647';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = overlayStyles;
  const container = document.createElement('div');
  shadow.append(style, container);
  document.documentElement.append(host);

  const root = createRoot(container);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    root.unmount();
    host.remove();
    previouslyFocused?.focus({ preventScroll: true });
    if (removeActive === remove) removeActive = null;
  };
  removeActive = remove;
  root.render(<UploadBlocked filename={filename} cause={cause} onDismiss={remove} />);
  return { remove };
}
