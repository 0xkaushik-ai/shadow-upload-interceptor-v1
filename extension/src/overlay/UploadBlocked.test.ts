import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';
import { UploadBlocked } from './UploadBlocked';

describe('upload block messaging', () => {
  test('explains daemon recovery separately from a secret finding', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(UploadBlocked, {
            filename: 'allow.txt',
            cause: { kind: 'policy', reason: 'host_disconnected' },
            onDismiss: vi.fn(),
          }),
        );
      });
      expect(container.textContent).toContain('Local scanner unavailable');
      expect(container.textContent).toContain('local scanner daemon is offline or unreachable');
      expect(container.textContent).toContain('Start or restart the daemon');
      expect(container.textContent).not.toContain('Private key detected');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
