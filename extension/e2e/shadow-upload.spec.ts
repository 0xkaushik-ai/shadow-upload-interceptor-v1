import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, expect, type Page, test } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const extensionPath = resolve(repoRoot, 'extension/.output/chrome-mv3');
const demoUrl = 'http://localhost:4173';
const hostName = 'com.secureintent.shadow';
const isMacOS = process.platform === 'darwin';

interface RunningExtension {
  context: BrowserContext;
  profile: string;
}

interface RunningDaemon {
  process: ChildProcess;
  directory: string;
  socketPath: string;
  stderr: Buffer[];
}

interface GuardPolicyOverride {
  onUnavailable?: 'allow' | 'block';
  onTooLarge?: 'allow' | 'block';
}

function deriveExtensionId(): string {
  const manifest = JSON.parse(readFileSync(resolve(extensionPath, 'manifest.json'), 'utf8')) as {
    key?: unknown;
  };
  if (typeof manifest.key !== 'string' || manifest.key.length === 0) {
    throw new Error('Built extension manifest does not contain its pinned development key.');
  }
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
  const alphabet = 'abcdefghijklmnop';
  return Array.from(digest.subarray(0, 16), (byte) => {
    return `${alphabet[byte >> 4]}${alphabet[byte & 15]}`;
  }).join('');
}

async function setGuardPolicy(context: BrowserContext, policy: GuardPolicyOverride): Promise<void> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(async (guardPolicy) => {
    const extensionApi = (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome;
    await extensionApi.storage.local.set({ guardPolicy });
  }, policy);
}

async function launchExtension(
  hostBinary?: string,
  policy?: GuardPolicyOverride,
  daemonSocket?: string,
): Promise<RunningExtension> {
  // macOS AF_UNIX paths are short; this is also the isolated HOME used for CFT registration.
  const profile = isMacOS
    ? mkdtempSync('/tmp/secureintent-e2e.')
    : mkdtempSync(join(tmpdir(), 'secureintent-shadow-e2e.'));
  const browserProfile = isMacOS ? join(profile, 'chrome-profile') : profile;
  try {
    if (hostBinary) {
      const absoluteBinary = resolve(repoRoot, hostBinary);
      chmodSync(absoluteBinary, 0o755);
      // Chromium resolves user NativeMessagingHosts from its effective --user-data-dir on every
      // supported desktop platform. The CFT Application Support path is only its default when no
      // user-data directory has been supplied.
      const hostDirectory = join(browserProfile, 'NativeMessagingHosts');
      mkdirSync(hostDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(hostDirectory, `${hostName}.json`),
        `${JSON.stringify(
          {
            name: hostName,
            description: 'SecureIntent Shadow Upload E2E native scanner',
            path: absoluteBinary,
            type: 'stdio',
            allowed_origins: [`chrome-extension://${deriveExtensionId()}/`],
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    }

    const executablePath = process.env.SHADOW_E2E_CHROME_BIN;
    const browserEnvironment = {
      ...process.env,
      ...(daemonSocket ? { SECUREINTENT_SHADOW_SOCKET: daemonSocket } : {}),
      ...(isMacOS ? { HOME: profile, CFFIXED_USER_HOME: profile } : {}),
    };
    const context = await chromium.launchPersistentContext(browserProfile, {
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      env: browserEnvironment,
      headless: process.env.SHADOW_E2E_HEADED !== '1',
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    if (policy) await setGuardPolicy(context, policy);
    return { context, profile };
  } catch (error) {
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

async function startDaemon(): Promise<RunningDaemon> {
  const directory = mkdtempSync(join(tmpdir(), 'secureintent-shadow-daemon-e2e.'));
  const socketPath = join(directory, 'daemon.sock');
  const daemonBinary = resolve(
    repoRoot,
    process.env.SHADOW_E2E_DAEMON_BINARY ?? 'daemon/target/debug/secureintent-shadow-daemon',
  );
  chmodSync(daemonBinary, 0o755);
  const stderr: Buffer[] = [];
  const daemon = spawn(daemonBinary, [], {
    env: { ...process.env, SECUREINTENT_SHADOW_SOCKET: socketPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  daemon.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (daemon.exitCode !== null) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(
        `detached daemon exited before listening (${daemon.exitCode}): ${Buffer.concat(stderr).toString('utf8')}`,
      );
    }
    try {
      const metadata = statSync(socketPath);
      if (metadata.isSocket()) {
        expect(metadata.mode & 0o777).toBe(0o600);
        return { process: daemon, directory, socketPath, stderr };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }

  daemon.kill('SIGKILL');
  rmSync(directory, { recursive: true, force: true });
  throw new Error('detached daemon did not create its private socket within 10 seconds');
}

async function stopDaemon(running: RunningDaemon | undefined): Promise<void> {
  if (!running) return;
  try {
    if (running.process.exitCode === null) {
      const closed = new Promise<void>((resolveClose) =>
        running.process.once('close', () => resolveClose()),
      );
      running.process.kill('SIGTERM');
      const stopped = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolveDelay) => setTimeout(() => resolveDelay(false), 1_000)),
      ]);
      if (!stopped && running.process.exitCode === null) {
        running.process.kill('SIGKILL');
        await closed;
      }
    }
  } finally {
    rmSync(running.directory, { recursive: true, force: true });
  }
}

async function closeExtension(running: RunningExtension | undefined): Promise<void> {
  if (!running) return;
  try {
    await running.context.close();
  } finally {
    rmSync(running.profile, { recursive: true, force: true });
  }
}

function requireContext(running: RunningExtension | undefined): BrowserContext {
  if (!running) throw new Error('Extension context did not start.');
  return running.context;
}

async function openForge(context: BrowserContext, guard: 'active' | 'degraded'): Promise<Page> {
  const page = await context.newPage();
  await page.goto(demoUrl);
  await expect.poll(() => page.locator('html').getAttribute('data-secureintent-guard')).toBe(guard);
  return page;
}

async function chooseFile(page: Page, filePath: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByText('Choose file', { exact: true }).click();
  await (await chooserPromise).setFiles(filePath);
}

async function chooseFileWithKeyboard(page: Page, filePath: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#forge-drop-zone').focus();
  await page.keyboard.press('Enter');
  await (await chooserPromise).setFiles(filePath);
}

async function dropFile(page: Page, filePath: string): Promise<void> {
  const zone = page.locator('#forge-drop-zone');
  const box = await zone.boundingBox();
  if (!box) throw new Error('Drop zone is not visible.');
  const client = await page.context().newCDPSession(page);
  const dragData = {
    items: [],
    files: [filePath],
    dragOperationsMask: 1,
  };
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  try {
    await client.send('Input.dispatchDragEvent', { type: 'dragEnter', ...point, data: dragData });
    await client.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data: dragData });
    await client.send('Input.dispatchDragEvent', { type: 'drop', ...point, data: dragData });
  } finally {
    await client.detach();
  }
}

async function expectAllowed(page: Page, filename: string): Promise<void> {
  await expect(page.locator('#status-title')).toHaveText('Allowed — uploaded');
  await expect(page.locator('#received-name')).toHaveText(filename);
  await expect(page.locator('#received-file')).toBeVisible();
  expect(
    await page
      .locator('input[type=file]')
      .evaluate((input: HTMLInputElement) => input.files?.length),
  ).toBe(1);
  await expect(page.locator('secureintent-shadow-warning')).toHaveCount(0);
}

async function expectBlocked(page: Page): Promise<void> {
  await expect(page.locator('#status-title')).toHaveText('Blocked — not sent');
  await expect(page.locator('#received-file')).toBeHidden();
  await expect(page.locator('secureintent-shadow-warning')).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const host = document.querySelector('secureintent-shadow-warning');
      return host ? host.shadowRoot : 'missing';
    }),
  ).toBeNull();
  expect(
    await page
      .locator('input[type=file]')
      .evaluate((input: HTMLInputElement) => input.files?.length),
  ).toBe(0);
  const publicStatus = await page.locator('html').getAttribute('data-secureintent-status');
  expect(publicStatus).toBe('{"state":"blocked"}');
}

test.describe('protected upload loop', () => {
  test.describe.configure({ mode: 'serial' });
  let running: RunningExtension | undefined;
  let daemon: RunningDaemon | undefined;
  let fixtureDirectory: string;

  test.beforeAll(async () => {
    daemon = await startDaemon();
    const hostBinary =
      process.env.SHADOW_E2E_HOST_BINARY ?? 'daemon/target/debug/secureintent-shadow-host';
    running = await launchExtension(hostBinary, undefined, daemon.socketPath);
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'secureintent-shadow-fixtures.'));
    copyFileSync(
      resolve(repoRoot, 'testdata/block.pem'),
      join(fixtureDirectory, 'meeting-notes.txt'),
    );
    copyFileSync(
      resolve(repoRoot, 'testdata/allow.txt'),
      join(fixtureDirectory, 'private-key.pem'),
    );
  });

  test.afterAll(async () => {
    try {
      await closeExtension(running);
      if (daemon && daemon.process.exitCode !== null) {
        throw new Error(
          `detached daemon exited with Chrome: ${Buffer.concat(daemon?.stderr ?? []).toString('utf8')}`,
        );
      }
    } finally {
      try {
        await stopDaemon(daemon);
      } finally {
        if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true });
      }
    }
  });

  test('allows harmless bytes even when the filename looks secret', async () => {
    const page = await openForge(requireContext(running), 'active');
    await chooseFileWithKeyboard(page, join(fixtureDirectory, 'private-key.pem'));
    await expectAllowed(page, 'private-key.pem');
    await page.close();
  });

  test('never exposes the original picker FileList to page input listeners', async () => {
    const page = await openForge(requireContext(running), 'active');
    await page.evaluate(() => {
      (
        globalThis as unknown as { secureintentTrustedInputs: unknown[] }
      ).secureintentTrustedInputs = [];
      document.querySelector('input[type=file]')?.addEventListener('input', (event) => {
        (
          globalThis as unknown as { secureintentTrustedInputs: unknown[] }
        ).secureintentTrustedInputs.push({
          trusted: event.isTrusted,
          files: (event.target as HTMLInputElement).files?.length ?? 0,
        });
      });
    });
    await chooseFile(page, resolve(repoRoot, 'testdata/allow.txt'));
    await expectAllowed(page, 'allow.txt');
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { secureintentTrustedInputs: unknown[] })
            .secureintentTrustedInputs,
      ),
    ).toEqual([{ trusted: false, files: 1 }]);
    await page.close();
  });

  test('blocks private-key bytes even when renamed as text', async () => {
    const page = await openForge(requireContext(running), 'active');
    await chooseFile(page, join(fixtureDirectory, 'meeting-notes.txt'));
    await expectBlocked(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('secureintent-shadow-warning')).toHaveCount(0);
    await page.close();
  });

  test('intercepts a trusted drag-and-drop upload', async () => {
    const page = await openForge(requireContext(running), 'active');
    await chooseFile(page, resolve(repoRoot, 'testdata/allow.txt'));
    await expectAllowed(page, 'allow.txt');
    await dropFile(page, resolve(repoRoot, 'testdata/block.pem'));
    await expectBlocked(page);
    await page.close();
  });

  test('blocks over-limit files by default without sending them to the daemon', async () => {
    const page = await openForge(requireContext(running), 'active');
    const oversized = join(fixtureDirectory, `${randomUUID()}.bin`);
    writeFileSync(oversized, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    await chooseFile(page, oversized);
    await expectBlocked(page);
    await expect(page.locator('html')).toHaveAttribute('data-secureintent-guard', 'active');
    await page.close();
  });
});

test('fails closed by default when the native host is absent', async () => {
  const running = await launchExtension();
  try {
    const page = await openForge(running.context, 'degraded');
    await chooseFile(page, resolve(repoRoot, 'testdata/block.pem'));
    await expectBlocked(page);
    await expect(page.locator('html')).toHaveAttribute('data-secureintent-guard', 'degraded');
  } finally {
    await closeExtension(running);
  }
});

test('supports an explicit fail-open development policy', async () => {
  const missingDaemonDirectory = mkdtempSync(join(tmpdir(), 'secureintent-shadow-missing-daemon.'));
  const hostBinary =
    process.env.SHADOW_E2E_HOST_BINARY ?? 'daemon/target/debug/secureintent-shadow-host';
  const running = await launchExtension(
    hostBinary,
    {
      onUnavailable: 'allow',
      onTooLarge: 'allow',
    },
    join(missingDaemonDirectory, 'missing.sock'),
  );
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'secureintent-shadow-policy.'));
  try {
    const unavailablePage = await openForge(running.context, 'degraded');
    await chooseFile(unavailablePage, resolve(repoRoot, 'testdata/allow.txt'));
    await expectAllowed(unavailablePage, 'allow.txt');
    await expect(unavailablePage.locator('#status-detail')).toContainText(
      'local scanning was unavailable',
    );
    await unavailablePage.close();

    const oversized = join(fixtureDirectory, `${randomUUID()}.bin`);
    writeFileSync(oversized, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    const oversizedPage = await openForge(running.context, 'degraded');
    await chooseFile(oversizedPage, oversized);
    await expectAllowed(oversizedPage, basename(oversized));
    await oversizedPage.close();
  } finally {
    try {
      await closeExtension(running);
    } finally {
      rmSync(fixtureDirectory, { recursive: true, force: true });
      rmSync(missingDaemonDirectory, { recursive: true, force: true });
    }
  }
});
