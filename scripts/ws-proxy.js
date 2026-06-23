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

wss.on('connection', (client, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const token = url.searchParams.get('token');
  url.searchParams.delete('token');

  const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`;

  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  upstream.on('open', () => {
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });

    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
  });

  upstream.on('close', (code, reason) => {
    client.close(code, reason);
  });

  client.on('close', () => {
    upstream.close();
  });

  upstream.on('error', () => {
    client.close(1011, 'Upstream error');
  });

  client.on('error', () => {
    upstream.close();
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
