import { createServer } from 'node:http';
import { readFile } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dummy-page');
const port = Number(process.argv[3] ?? '4173');
const healthToken = process.env.SHADOW_DEMO_HEALTH_TOKEN ?? 'ready';

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid demo port: ${process.argv[3]}`);
}

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/__secureintent_health') {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(healthToken);
    return;
  }

  const entry = files.get(pathname);
  if (!entry) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  readFile(resolve(root, entry[0]), (error, body) => {
    if (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to read demo page');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
      'Content-Type': entry[1],
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  });
});

server.on('error', (error) => {
  console.error(`Forge server failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Forge listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(process.exitCode ?? 0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
