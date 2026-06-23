/**
 * Dummy WebSocket server that mimics the Sprites exec API.
 * Spawns a local bash PTY and proxies stdin/stdout over WebSocket.
 *
 * Usage:  node scripts/test-ws-server.js
 * Client: ws://localhost:8082/v1/sprites/{name}/exec?cmd=bash&tty=true&cols=120&rows=40
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { URL } = require('url');

const PORT = 8082;

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const cmds = url.searchParams.getAll('cmd');
  const tty = url.searchParams.get('tty') === 'true';
  const cols = parseInt(url.searchParams.get('cols') || '80', 10);
  const rows = parseInt(url.searchParams.get('rows') || '24', 10);

  const command = cmds[0] || 'bash';
  const args = cmds.slice(1);

  console.log(`[connect] cmd=${command} args=${JSON.stringify(args)} tty=${tty} ${cols}x${rows}`);

  const shell = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const sessionId = `test-${Date.now()}`;

  // Send session_info
  ws.send(JSON.stringify({
    type: 'session_info',
    session_id: sessionId,
    command,
    created: Math.floor(Date.now() / 1000),
    cols,
    rows,
    is_owner: true,
    tty,
  }));

  // PTY stdout → WebSocket (raw text in PTY mode)
  shell.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  shell.onExit(({ exitCode }) => {
    console.log(`[exit] session ${sessionId} code=${exitCode}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exit_code: exitCode }));
      ws.close();
    }
  });

  // WebSocket → PTY
  ws.on('message', (data, isBinary) => {
    const str = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);

    // Check for JSON control messages (resize)
    if (!isBinary || str.startsWith('{')) {
      try {
        const msg = JSON.parse(str);
        if (msg.type === 'resize') {
          shell.resize(msg.cols, msg.rows);
          console.log(`[resize] ${msg.cols}x${msg.rows}`);
          return;
        }
      } catch {}
    }

    // Otherwise treat as stdin
    shell.write(str);
  });

  ws.on('close', () => {
    console.log(`[close] session ${sessionId}`);
    shell.kill();
  });

  ws.on('error', (err) => {
    console.error(`[error] ${err.message}`);
    shell.kill();
  });
});

server.listen(PORT, () => {
  console.log(`Test WS server on ws://localhost:${PORT}`);
  console.log(`Exec endpoint: ws://localhost:${PORT}/v1/sprites/test/exec?cmd=bash&tty=true&cols=120&rows=40`);
});
