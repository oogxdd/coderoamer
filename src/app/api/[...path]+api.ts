const API_TARGET = 'https://api.sprites.dev';

async function proxyRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const targetPath = url.pathname.replace(/^\/api/, '');
  const targetUrl = `${API_TARGET}${targetPath}${url.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== 'host' && lowerKey !== 'accept-encoding') {
      headers.set(key, value);
    }
  }
  // Browsers may advertise zstd, which Node's fetch does not decompress.
  // Request an uncompressed upstream body so the proxy always returns bytes
  // matching its response headers.
  headers.set('accept-encoding', 'identity');

  const init: RequestInit = {
    method: request.method,
    headers,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text();
  }

  const response = await fetch(targetUrl, init);

  // Node's fetch auto-decompresses, so strip encoding headers
  // to avoid the browser trying to decompress again.
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export function GET(request: Request) {
  return proxyRequest(request);
}

export function POST(request: Request) {
  return proxyRequest(request);
}

export function PUT(request: Request) {
  return proxyRequest(request);
}

export function DELETE(request: Request) {
  return proxyRequest(request);
}

export function OPTIONS(request: Request) {
  return proxyRequest(request);
}
