const input = document.querySelector('[data-forge-upload]');
const dropZone = document.querySelector('#forge-drop-zone');
const statusCard = document.querySelector('.status-card');
const statusTitle = document.querySelector('#status-title');
const statusDetail = document.querySelector('#status-detail');
const received = document.querySelector('#received-file');
const receivedName = document.querySelector('#received-name');
const receivedSize = document.querySelector('#received-size');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(status, title, detail) {
  statusCard.dataset.status = status;
  dropZone.dataset.state = status;
  dropZone.setAttribute('aria-busy', status === 'scanning' ? 'true' : 'false');
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function acceptFile(file) {
  if (!file) return;
  receivedName.textContent = file.name;
  receivedSize.textContent = formatBytes(file.size);
  received.hidden = false;
  const detail =
    document.documentElement.dataset.secureintentGuard === 'degraded'
      ? `${file.name} was received while local scanning was unavailable.`
      : `${file.name} was received by Forge.`;
  setStatus('allowed', 'Allowed — uploaded', detail);
}

input.addEventListener('change', () => acceptFile(input.files?.[0]));

dropZone.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  input.click();
});

dropZone.addEventListener('dragenter', () => dropZone.classList.add('is-dragging'));
dropZone.addEventListener('dragleave', (event) => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-dragging');
});
dropZone.addEventListener('dragover', (event) => event.preventDefault());
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

function applySecureIntentStatus(rawStatus) {
  let status;
  try {
    status = JSON.parse(rawStatus);
  } catch {
    return;
  }
  const { state } = status;
  dropZone.classList.remove('is-dragging');
  if (state === 'scanning') {
    received.hidden = true;
    setStatus('scanning', 'Scanning locally…', 'The selected file has not been sent to Forge.');
  }
  if (state === 'blocked') {
    received.hidden = true;
    setStatus('blocked', 'Blocked — not sent', 'The selected file was stopped before Forge received it.');
  }
  if (state === 'canceled') {
    received.hidden = true;
    setStatus('blocked', 'Upload canceled', 'The original upload control is no longer available.');
  }
}

function applyGuardState() {
  const guard = document.documentElement.dataset.secureintentGuard;
  const current = statusCard.dataset.status;
  const canShowGuard = ['waiting', 'checking', 'ready', 'unavailable'].includes(current);
  if (!canShowGuard) return;

  if (guard === 'checking') {
    setStatus('checking', 'Checking local scanner…', 'Starting the on-device protection service.');
  }
  if (guard === 'active') {
    setStatus(
      'ready',
      'Protected — scanner ready',
      'Files are checked on this device before Forge can receive them.',
    );
  }
  if (guard === 'degraded') {
    setStatus(
      'unavailable',
      'Local scanner unavailable',
      'Uploads that cannot be scanned are blocked unless fail-open development policy was explicitly enabled.',
    );
  }
}

new MutationObserver(() => {
  const status = document.documentElement.dataset.secureintentStatus;
  if (status) applySecureIntentStatus(status);
  applyGuardState();
}).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-secureintent-status', 'data-secureintent-guard'],
});

applyGuardState();
setTimeout(() => {
  if (
    document.documentElement.dataset.secureintentGuard !== 'active' &&
    statusCard.dataset.status === 'waiting'
  ) {
    setStatus(
      'unavailable',
      'Protection unavailable',
      'Reload SecureIntent to scan files locally before Forge receives them.',
    );
  }
}, 800);
