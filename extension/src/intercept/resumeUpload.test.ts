import { afterEach, describe, expect, test, vi } from 'vitest';
import { resumeIntoInput } from './resumeUpload';

class FakeDataTransfer {
  private stored: File[] = [];

  readonly items = {
    add: (file: File) => {
      this.stored.push(file);
      return null;
    },
  };

  get files(): FileList {
    return this.stored as unknown as FileList;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FileList reconstruction', () => {
  test('assigns the retained file and sends a fresh change to the page', () => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    const input = document.createElement('input');
    input.type = 'file';
    Object.defineProperty(input, 'files', { value: [], writable: true, configurable: true });
    const file = new File(['harmless'], 'allow.txt', { type: 'text/plain' });
    const listener = vi.fn();
    input.addEventListener('change', listener);

    expect(resumeIntoInput(input, file)).toBe(true);
    expect(input.files?.[0]).toBe(file);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0].isTrusted).toBe(false);
  });

  test('returns false when the browser refuses FileList reconstruction', () => {
    vi.stubGlobal(
      'DataTransfer',
      class {
        constructor() {
          throw new Error('unavailable');
        }
      },
    );
    const input = document.createElement('input');
    const file = new File(['x'], 'file.txt');
    expect(resumeIntoInput(input, file)).toBe(false);
  });
});
