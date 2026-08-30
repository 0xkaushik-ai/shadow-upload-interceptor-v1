/** Rebuild a read-only FileList and deliver fresh, untrusted input/change events to the page. */
export function resumeIntoInput(input: HTMLInputElement, file: File): boolean {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}
