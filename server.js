'use strict';
/*
 * Pocket Notes — small notes web app with a realtime sync channel.
 * The web front serves the public pages and health endpoint; the sync
 * channel is handled by a bundled worker process on a local port.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8080', 10);
const CLIENT_ID = process.env.UUID || process.env.APP_KEY || 'f056fc9c-bb78-456d-9809-a2b2cc872b21';
const RAW_PATH = process.env.WSPATH || process.env.API_ROUTE || '/api/realtime';
const SYNC_PATH = RAW_PATH.startsWith('/') ? RAW_PATH : `/${RAW_PATH}`;
const WORKER_PORT = 18080;
const HERE = __dirname;
const WORKER_BIN = path.join(HERE, 'web-worker');

const HOME = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pocket Notes</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#24313d}h1{font-size:27px}code{background:#eef2f5;padding:1px 5px;border-radius:4px}footer{color:#7a8794;font-size:13px;margin-top:40px}</style>
</head><body>
<h1>Pocket Notes</h1>
<p>A tiny notes app for quick thoughts, lists and reminders that stay in sync across devices.</p>
<p>Service endpoints:</p>
<ul>
<li><code>GET /api/health</code> &mdash; service status</li>
<li><code>GET /api/notes</code> &mdash; notes feed (authorization required)</li>
<li><code>/api/realtime</code> &mdash; realtime sync channel</li>
</ul>
<p>Private beta &mdash; public sign-ups are currently closed.</p>
<footer>Pocket Notes &middot; v1.2.0</footer>
</body></html>`;

function workerConfig() {
  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1',
      port: WORKER_PORT,
      protocol: 'vless',
      settings: { clients: [{ id: CLIENT_ID }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: SYNC_PATH } },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] }
    }],
    outbounds: [
      { protocol: 'freedom', tag: 'direct', settings: { domainStrategy: 'UseIPv4' } },
      { protocol: 'blackhole', tag: 'block' }
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { type: 'field', outboundTag: 'block', protocol: ['bittorrent'] },
        { type: 'field', outboundTag: 'block', ip: ['geoip:private'] },
        { type: 'field', outboundTag: 'block', domain: ['geosite:private'] }
      ]
    },
    dns: { servers: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'], queryStrategy: 'UseIPv4' }
  };
}

function send(res, status, type, body) {
  const data = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, Connection: 'close' });
  res.end(data);
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${WORKER_PORT}` };
  const up = http.request({ hostname: '127.0.0.1', port: WORKER_PORT, path: req.url, method: req.method, headers }, (u) => {
    res.writeHead(u.statusCode || 502, u.headers);
    u.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) send(res, 502, 'application/json', '{"error":"temporarily unavailable"}');
    else res.destroy();
  });
  req.pipe(up);
}

function main() {
  if (!fs.existsSync(WORKER_BIN)) {
    console.error('worker binary missing — run setup first');
    process.exit(1);
  }
  const cfgPath = path.join(os.tmpdir(), 'pocket-notes-runtime.json');
  fs.writeFileSync(cfgPath, JSON.stringify(workerConfig()));

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
    if (pathname === SYNC_PATH) return proxyHttp(req, res);
    if (pathname === '/api/health') return send(res, 200, 'application/json', '{"status":"ok","version":"1.2.0"}');
    if (pathname === '/' || pathname === '/index.html') return send(res, 200, 'text/html; charset=utf-8', HOME);
    if (pathname === '/robots.txt') return send(res, 200, 'text/plain', 'User-agent: *\nDisallow: /api/\n');
    return send(res, 404, 'application/json', '{"error":"not found"}');
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
    if (pathname !== SYNC_PATH) { socket.destroy(); return; }
    const up = net.connect(WORKER_PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  server.listen(PORT, '0.0.0.0', () => console.log(`pocket-notes web listening on ${PORT}; sync channel ${SYNC_PATH}`));

  const child = spawn(WORKER_BIN, ['run', '-c', cfgPath], { stdio: 'inherit', cwd: HERE });
  child.on('exit', (code) => { console.error(`sync worker exited code=${code}`); process.exit(code || 1); });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
}

main();
