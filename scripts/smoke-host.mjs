import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(
  root,
  process.env.SHADOW_HOST_BINARY ?? 'daemon/target/debug/secureintent-shadow-host',
);
const healthMode = process.argv[2] === '--health';
const fixturePath = healthMode
  ? null
  : resolve(root, process.argv[2] ?? 'testdata/block.pem');
const expected = process.argv[3] ?? 'block';
const protocol = 1;
const maxResponseBytes = 1024 * 1024;

if (!existsSync(binary)) {
  console.error(`Native host binary does not exist: ${binary}`);
  process.exit(2);
}
if (!healthMode && !['allow', 'block'].includes(expected)) {
  console.error('Expected verdict must be "allow" or "block".');
  process.exit(2);
}

const scanId = 'smoke-test';
const messages = healthMode
  ? [{ type: 'health', id: scanId, protocol }]
  : (() => {
      const bytes = readFileSync(fixturePath);
      return [
        {
          type: 'scan_begin',
          id: scanId,
          size: bytes.length,
          protocol,
        },
        { type: 'scan_chunk', id: scanId, offset: 0, data: bytes.toString('base64') },
        { type: 'scan_end', id: scanId },
      ];
    })();

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

const host = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const stdout = [];
const stderr = [];
host.stdout.on('data', (chunk) => stdout.push(chunk));
host.stderr.on('data', (chunk) => stderr.push(chunk));
for (const message of messages) host.stdin.write(frame(message));
host.stdin.end();

const exitCode = await new Promise((resolveExit, rejectExit) => {
  const timer = setTimeout(() => {
    host.kill('SIGKILL');
    rejectExit(new Error(`native host did not exit after stdin closed: ${binary}`));
  }, 10_000);
  host.on('close', (code) => {
    clearTimeout(timer);
    resolveExit(code);
  });
  host.on('error', (error) => {
    clearTimeout(timer);
    rejectExit(error);
  });
});
if (exitCode !== 0) {
  console.error(Buffer.concat(stderr).toString('utf8'));
  process.exit(exitCode ?? 1);
}

const response = Buffer.concat(stdout);
if (response.length < 4) throw new Error('native host returned no framed verdict');
const length = response.readUInt32LE(0);
if (length === 0 || length > maxResponseBytes || response.length !== length + 4) {
  throw new Error('native host returned an invalid response frame');
}
const verdict = JSON.parse(response.subarray(4, 4 + length).toString('utf8'));
if (healthMode) {
  if (
    verdict.type !== 'health' ||
    verdict.id !== scanId ||
    verdict.status !== 'ready' ||
    verdict.protocol !== protocol
  ) {
    throw new Error(`native health check failed: ${JSON.stringify(verdict)}`);
  }
  console.log(`Native Messaging smoke test: HEALTHY protocol v${verdict.protocol} (${binary})`);
  process.exit(0);
}
if (verdict.type !== 'verdict' || verdict.id !== scanId || verdict.decision !== expected) {
  throw new Error(`expected ${expected}, received ${verdict.decision}`);
}
if (expected === 'block' && typeof verdict.rule !== 'string') {
  throw new Error('block verdict did not include a rule id');
}
if (expected === 'allow' && verdict.rule !== null) {
  throw new Error('allow verdict unexpectedly included a rule id');
}
console.log(`Native Messaging smoke test: ${verdict.decision.toUpperCase()} (${fixturePath})`);
