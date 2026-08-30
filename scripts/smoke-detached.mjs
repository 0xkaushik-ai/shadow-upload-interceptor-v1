import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const daemonBinary = resolve(
  root,
  process.env.SHADOW_DAEMON_BINARY ?? 'daemon/target/debug/secureintent-shadow-daemon',
);
const hostBinary = resolve(
  root,
  process.env.SHADOW_HOST_BINARY ?? 'daemon/target/debug/secureintent-shadow-host',
);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'secureintent-detached-smoke.'));
const socketPath = join(temporaryDirectory, 'daemon.sock');
const daemonErrors = [];

for (const binary of [daemonBinary, hostBinary]) {
  if (!existsSync(binary)) {
    console.error(`Required binary does not exist: ${binary}`);
    process.exit(2);
  }
}

const environment = {
  ...process.env,
  SECUREINTENT_SHADOW_SOCKET: socketPath,
  SHADOW_HOST_BINARY: hostBinary,
};
const daemon = spawn(daemonBinary, [], {
  env: environment,
  stdio: ['ignore', 'ignore', 'pipe'],
});
daemon.stderr.on('data', (chunk) => {
  if (daemonErrors.reduce((total, item) => total + item.length, 0) < 64 * 1024) {
    daemonErrors.push(chunk);
  }
});

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitForSocket() {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (daemon.exitCode !== null) {
      throw new Error(
        `daemon exited before listening (${daemon.exitCode}): ${Buffer.concat(daemonErrors).toString('utf8')}`,
      );
    }
    try {
      const metadata = statSync(socketPath);
      if (metadata.isSocket()) {
        if ((metadata.mode & 0o777) !== 0o600) {
          throw new Error(`daemon socket mode is ${(metadata.mode & 0o777).toString(8)}, expected 600`);
        }
        return;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error(
    `detached daemon did not create its socket within 10 seconds: ${Buffer.concat(daemonErrors).toString('utf8')}`,
  );
}

async function runSmoke(arguments_) {
  const child = spawn(process.execPath, [resolve(root, 'scripts/smoke-host.mjs'), ...arguments_], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', resolveExit);
  });
  if (code !== 0) {
    throw new Error(
      `broker smoke test failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`,
    );
  }
  process.stdout.write(Buffer.concat(stdout));
  if (daemon.exitCode !== null) {
    throw new Error('detached daemon exited when a Chrome-style broker disconnected');
  }
  process.kill(daemon.pid, 0);
}

async function sendMalformedFrame() {
  await new Promise((resolveClose, rejectConnection) => {
    const client = createConnection(socketPath);
    client.once('error', rejectConnection);
    client.once('connect', () => client.end(Buffer.alloc(4)));
    client.once('close', resolveClose);
  });
  if (daemon.exitCode !== null) {
    throw new Error('malformed client frame terminated the persistent daemon');
  }
}

async function stopDaemon() {
  if (daemon.exitCode !== null) return;
  const closed = new Promise((resolveClose) => daemon.once('close', resolveClose));
  daemon.kill('SIGTERM');
  const stopped = await Promise.race([closed.then(() => true), delay(1_000).then(() => false)]);
  if (!stopped && daemon.exitCode === null) {
    daemon.kill('SIGKILL');
    await closed;
  }
}

let failed = false;
try {
  await waitForSocket();
  const persistentPid = daemon.pid;
  await sendMalformedFrame();
  await runSmoke(['--health']);
  await runSmoke(['testdata/block.pem', 'block']);
  await runSmoke(['testdata/allow.txt', 'allow']);
  if (daemon.pid !== persistentPid || daemon.exitCode !== null) {
    throw new Error('daemon identity changed across short-lived broker sessions');
  }
  console.log(
    `Detached lifecycle smoke test: daemon PID ${persistentPid} survived malformed input and three broker sessions.`,
  );
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await stopDaemon();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

if (failed) process.exit(1);
