#!/usr/bin/env node
'use strict';

/**
 * remote-agent — a lightweight daemon that speaks the Sprites exec + services
 * wire protocol so the sprites-rn-manager app can connect to any Linux machine,
 * not just Fly.io Sprites.
 *
 * Implements exactly the endpoints the app uses:
 *   PUT    /sprites/:name/services/:svc          → run a command, stream NDJSON
 *   GET    /sprites/:name/services/:svc/logs     → replay + stream NDJSON
 *   DELETE /sprites/:name/services/:svc          → kill service
 *   GET    /sprites/:name/exec                   → list live TTY sessions
 *   WS     /sprites/:name/exec?cmd=...           → new TTY session
 *   WS     /sprites/:name/exec/:sessionId        → attach (replays scrollback)
 *   POST   /sprites/:name/exec/:sessionId/kill   → kill TTY session
 *
 * The :name segment is accepted but ignored — this daemon runs on one machine.
 *
 * Usage:
 *   AGENT_TOKEN=<secret> PORT=8765 node index.js
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8765', 10);
const TOKEN = process.env.AGENT_TOKEN;

// How many chunks of PTY output to keep in the scrollback buffer per session.
// Each chunk is whatever node-pty emits in one onData call (a few hundred bytes
// on average), so 4000 ≈ a few hundred KB — plenty for Claude's TUI.
const SCROLLBACK_MAX_CHUNKS = 4000;

// How long to keep a dead exec session in memory (for late attaches).
const DEAD_SESSION_TTL_MS = 5 * 60 * 1000;

if (!TOKEN) {
  console.error('[remote-agent] AGENT_TOKEN is required. Set it in your environment.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

// serviceName → { proc, events, subs, alive, exitCode }
const services = new Map();

// sessionId → { pty, scrollback: Buffer[], subs: Set<WebSocket>, alive, cmd, lastActivity }
const execSessions = new Map();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authorized(req) {
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}`;
}

function rejectAuth(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

// ---------------------------------------------------------------------------
// Services helpers
// ---------------------------------------------------------------------------

/**
 * Send a NDJSON line to a response stream.
 * The app's parseServiceEventLine() strips SSE "data:" prefixes and parses
 * each newline-terminated JSON object, so plain NDJSON (no SSE wrapping) works.
 */
function ndjsonLine(obj) {
  return JSON.stringify(obj) + '\n';
}

function startService(res, serviceName, config) {
  // Stop any existing service with the same name cleanly.
  const existing = services.get(serviceName);
  if (existing) {
    existing.subs.clear();
    if (existing.proc && existing.alive) {
      try { existing.proc.kill('SIGTERM'); } catch {}
    }
  }

  const events = [];
  const subs = new Set();
  const svc = { proc: null, events, subs, alive: true, exitCode: null };
  services.set(serviceName, svc);

  // Schedule cleanup after a reasonable TTL so stale entries don't pile up.
  // Re-PUT to the same name just overwrites anyway.

  const emit = (obj) => {
    events.push(obj);
    const line = ndjsonLine(obj);
    if (res && !res.writableEnded) res.write(line);
    for (const cb of subs) cb(line);
  };

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const cmd = config.cmd || 'bash';
  const args = Array.isArray(config.args) ? config.args : [];

  emit({ type: 'started', data: `${cmd} ${args.join(' ')}`.trim() });

  let proc;
  try {
    proc = spawn(cmd, args, {
      shell: false,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    emit({ type: 'error', data: err.message });
    emit({ type: 'exit', exit_code: 1 });
    res.end();
    return;
  }

  svc.proc = proc;

  proc.stdout.on('data', (d) => emit({ type: 'stdout', data: d.toString() }));
  proc.stderr.on('data', (d) => emit({ type: 'stderr', data: d.toString() }));
  proc.on('error', (err) => emit({ type: 'error', data: err.message }));
  proc.on('close', (code) => {
    svc.alive = false;
    svc.exitCode = code ?? 0;
    emit({ type: 'exit', exit_code: code ?? 0 });
    emit({ type: 'complete' });
    if (!res.writableEnded) res.end();
  });
}

function streamLogs(req, res, serviceName) {
  const svc = services.get(serviceName);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  if (!svc) {
    res.write(ndjsonLine({ type: 'error', data: `Service '${serviceName}' not found` }));
    res.end();
    return;
  }

  // Replay cached events so the client catches up.
  for (const obj of svc.events) {
    res.write(ndjsonLine(obj));
  }

  if (!svc.alive) {
    res.end();
    return;
  }

  // Subscribe to future events.
  const onLine = (line) => {
    if (!res.writableEnded) res.write(line);
  };
  svc.subs.add(onLine);

  const cleanup = () => svc.subs.delete(onLine);
  res.on('close', cleanup);
  req.on('close', cleanup);
}

// ---------------------------------------------------------------------------
// HTTP router
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (!authorized(req)) return rejectAuth(res);

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  // PUT /sprites/:name/services/:svc
  let match = p.match(/^\/sprites\/([^/]+)\/services\/([^/]+)$/);
  if (match) {
    const [, , svcName] = match;
    if (m === 'GET') {
      const svc = services.get(svcName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: svcName,
        state: { status: svc ? (svc.alive ? 'running' : 'stopped') : 'not_found' },
      }));
      return;
    }
    if (m === 'PUT') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let config = {};
        try { config = JSON.parse(body); } catch {}
        startService(res, svcName, config);
      });
      return;
    }
    if (m === 'DELETE') {
      const svc = services.get(svcName);
      if (svc) {
        svc.subs.clear();
        if (svc.proc && svc.alive) try { svc.proc.kill('SIGTERM'); } catch {}
        services.delete(svcName);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
  }

  // GET /sprites/:name/services/:svc/logs
  match = p.match(/^\/sprites\/([^/]+)\/services\/([^/]+)\/logs$/);
  if (match && m === 'GET') {
    streamLogs(req, res, match[2]);
    return;
  }

  // GET /sprites/:name/exec  (list live sessions — REST, not WS)
  match = p.match(/^\/sprites\/([^/]+)\/exec$/);
  if (match && m === 'GET') {
    const list = [];
    for (const [id, sess] of execSessions) {
      if (sess.alive) {
        list.push({ id, cmd: sess.cmd, tty: true, last_activity: sess.lastActivity });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /sprites/:name/exec/:id/kill
  match = p.match(/^\/sprites\/([^/]+)\/exec\/([^/]+)\/kill$/);
  if (match && m === 'POST') {
    const sess = execSessions.get(match[2]);
    if (sess && sess.alive) {
      try { sess.pty.kill(); } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: p }));
});

// ---------------------------------------------------------------------------
// WebSocket router
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  // WS auth: the app passes the token in the Authorization header.
  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${TOKEN}`) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // WS /sprites/:name/exec/:sessionId  → attach
  let match = p.match(/^\/sprites\/([^/]+)\/exec\/([^/]+)$/);
  if (match) {
    handleExecAttach(ws, match[2]);
    return;
  }

  // WS /sprites/:name/exec?cmd=...  → new session
  match = p.match(/^\/sprites\/([^/]+)\/exec$/);
  if (match) {
    handleExecNew(ws, url);
    return;
  }

  ws.close(4004, 'Not found');
});

// ---------------------------------------------------------------------------
// Exec: new TTY session
// ---------------------------------------------------------------------------

function handleExecNew(ws, url) {
  const cols = parseInt(url.searchParams.get('cols') || '120', 10);
  const rows = parseInt(url.searchParams.get('rows') || '40', 10);
  // The app URL-encodes the command: ?cmd=bash or ?cmd=claude
  const cmdRaw = decodeURIComponent(url.searchParams.get('cmd') || 'bash');

  // Split into argv[0] + rest.  The app typically sends `cmd=bash` and types
  // the real command as initial TTY input, so simple splitting is fine.
  const argv = cmdRaw.split(/\s+/).filter(Boolean);
  const bin = argv[0] || 'bash';
  const args = argv.slice(1);

  const sessionId = randomUUID();
  const scrollback = [];

  let term;
  try {
    term = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols,
      rows,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', data: `spawn failed: ${err.message}` }));
    ws.close();
    return;
  }

  const sess = {
    pty: term,
    scrollback,
    subs: new Set(),
    alive: true,
    cmd: cmdRaw,
    lastActivity: new Date().toISOString(),
  };
  execSessions.set(sessionId, sess);

  // Send session_info first so exec-poc.ts captures the session id and cols/rows.
  ws.send(JSON.stringify({ type: 'session_info', session_id: sessionId, cols, rows }));

  term.onData((data) => {
    sess.lastActivity = new Date().toISOString();
    const buf = Buffer.from(data, 'binary');
    // Bounded scrollback
    scrollback.push(buf);
    if (scrollback.length > SCROLLBACK_MAX_CHUNKS) scrollback.shift();
    // Send to originator
    if (ws.readyState === ws.OPEN) ws.send(buf);
    // Fan out to any attached clients
    for (const sub of sess.subs) {
      if (sub.readyState === sub.OPEN) sub.send(buf);
    }
  });

  term.onExit(({ exitCode }) => {
    sess.alive = false;
    const msg = JSON.stringify({ type: 'exit', exit_code: exitCode ?? 0 });
    if (ws.readyState === ws.OPEN) ws.send(msg);
    for (const sub of sess.subs) {
      if (sub.readyState === sub.OPEN) sub.send(msg);
    }
    setTimeout(() => execSessions.delete(sessionId), DEAD_SESSION_TTL_MS);
  });

  ws.on('message', (data) => {
    if (!sess.alive) return;
    handlePtyInput(sess.pty, data);
  });

  ws.on('close', () => { sess.subs.delete(ws); });
  ws.on('error', () => { sess.subs.delete(ws); });
}

// ---------------------------------------------------------------------------
// Exec: attach to existing session
// ---------------------------------------------------------------------------

function handleExecAttach(ws, sessionId) {
  const sess = execSessions.get(sessionId);
  if (!sess) {
    ws.send(JSON.stringify({ type: 'error', data: `Session ${sessionId} not found` }));
    ws.close(4404, 'Session not found');
    return;
  }

  // Replay scrollback so the client sees everything that happened before attach.
  ws.send(JSON.stringify({ type: 'session_info', session_id: sessionId }));
  for (const chunk of sess.scrollback) {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  }

  if (!sess.alive) {
    ws.send(JSON.stringify({ type: 'exit', exit_code: 0 }));
    ws.close();
    return;
  }

  sess.subs.add(ws);

  ws.on('message', (data) => {
    if (!sess.alive) return;
    handlePtyInput(sess.pty, data);
  });
  ws.on('close', () => sess.subs.delete(ws));
  ws.on('error', () => sess.subs.delete(ws));
}

// ---------------------------------------------------------------------------
// PTY input dispatcher
// ---------------------------------------------------------------------------

function handlePtyInput(term, data) {
  // The app sends resize as a JSON string; all other input is binary (stdin).
  let str;
  try {
    str = data instanceof Buffer ? data.toString('utf8') : String(data);
  } catch {
    return;
  }

  try {
    const obj = JSON.parse(str);
    if (obj && obj.type === 'resize' && obj.cols > 0 && obj.rows > 0) {
      term.resize(obj.cols, obj.rows);
      return;
    }
  } catch {}

  // Plain stdin
  term.write(str);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`[remote-agent] listening on port ${PORT}`);
  console.log(`[remote-agent] token: ${TOKEN.slice(0, 4)}${'*'.repeat(Math.max(0, TOKEN.length - 4))}`);
  console.log(`[remote-agent] base URL for the app: http://<your-host>:${PORT}/v1`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[remote-agent] shutting down…');
  for (const [, svc] of services) {
    if (svc.proc && svc.alive) try { svc.proc.kill('SIGTERM'); } catch {}
  }
  for (const [, sess] of execSessions) {
    if (sess.alive) try { sess.pty.kill(); } catch {}
  }
  process.exit(0);
});
