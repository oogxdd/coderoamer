/**
 * WebSocket proxy for web development.
 * Browsers can't send Authorization headers on WebSocket connections.
 * This proxy accepts connections with the token as a query param,
 * then connects upstream with the token as a proper Authorization header.
 */
const { WebSocketServer, WebSocket } = require('ws');

const PORT = parseInt(process.env.WS_PROXY_PORT || '8082', 10);
const UPSTREAM = 'wss://api.sprites.dev';

const wss = new WebSocketServer({ port: PORT });
let nextConnectionId = 1;

function frameSummary(data, isBinary) {
  if (isBinary) {
    return { kind: 'binary', bytes: data.length, streamId: data.length ? data[0] : undefined };
  }
  const text = data.toString();
  try {
    const value = JSON.parse(text);
    return { kind: 'control', bytes: data.length, type: value?.type ?? 'json' };
  } catch {
    return { kind: 'text', bytes: data.length };
  }
}

wss.on('connection', (client, req) => {
  const connectionId = nextConnectionId++;
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const token = url.searchParams.get('token');
  url.searchParams.delete('token');

  const commandParts = url.searchParams.getAll('cmd');
  const verbose = commandParts.some((part) =>
    /codex login|claude setup-token|gh auth login|vercel login|WISP_GITHUB/.test(part)
  );
  const log = (event, details = {}) => {
    if (verbose) console.log(`[ws-proxy:${connectionId}] ${event}`, details);
  };

  log('client.connected', {
    path: url.pathname,
    tty: url.searchParams.get('tty'),
    commandParts: commandParts.length,
    tokenPresent: Boolean(token),
  });

  const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`;

  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const pendingClientMessages = [];

  // The browser-side socket opens before the upstream Sprites socket. Queue
  // early frames (notably the initial PTY resize) instead of silently dropping
  // them during that gap.
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      log('client.forward', frameSummary(data, isBinary));
      upstream.send(data, { binary: isBinary });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      log('client.queue', frameSummary(data, isBinary));
      pendingClientMessages.push({ data: Buffer.from(data), isBinary });
    }
  });

  upstream.on('open', () => {
    log('upstream.open', { queuedMessages: pendingClientMessages.length });
    if (client.readyState !== WebSocket.OPEN) {
      upstream.close();
      return;
    }
    for (const message of pendingClientMessages.splice(0)) {
      log('client.flush', frameSummary(message.data, message.isBinary));
      upstream.send(message.data, { binary: message.isBinary });
    }
  });

  upstream.on('message', (data, isBinary) => {
    log('upstream.forward', frameSummary(data, isBinary));
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  upstream.on('close', (code, reason) => {
    log('upstream.close', { code, reasonBytes: reason.length });
    pendingClientMessages.length = 0;
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
  });

  client.on('close', () => {
    log('client.close');
    pendingClientMessages.length = 0;
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      upstream.close();
    }
  });

  upstream.on('error', (error) => {
    log('upstream.error', { code: error.code, message: error.message });
    if (client.readyState === WebSocket.OPEN) client.close(1011, 'Upstream error');
  });

  client.on('error', (error) => {
    log('client.error', { code: error.code, message: error.message });
    if (
      upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING
    ) {
      upstream.close();
    }
  });
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`WS proxy: port ${PORT} already in use (proxy likely already running)`);
  } else {
    console.error('WS proxy error:', err);
  }
});

console.log(`WS proxy listening on ws://localhost:${PORT}`);
