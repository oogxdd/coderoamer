/**
 * AWS Signature Version 4 for the EC2 query protocol (POST, form-encoded body,
 * empty canonical query string). Built on the vendored crypto in ./crypto.ts —
 * no @aws-sdk, no native crypto. See docs/custom-vm-providers.md §3.6.
 */
import { sha256Hex, hmacSha256, toHex, utf8 } from './crypto';

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional STS session token (for temporary credentials). */
  sessionToken?: string;
}

/** Format a Date as the SigV4 `YYYYMMDDTHHMMSSZ` timestamp (UTC). */
export function amzDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

export interface SignedRequest {
  headers: Record<string, string>;
  amzDate: string;
}

/**
 * Sign a request and return the headers to send. The Host header is signed (per
 * SigV4) but not returned — `fetch` sets Host from the URL, which must equal the
 * `host` passed here.
 */
export function signQuery(opts: {
  creds: AwsCreds;
  region: string;
  service: string; // 'ec2'
  host: string; // ec2.<region>.amazonaws.com (or a LocalStack host)
  body: string; // form-encoded request
  path?: string; // '/'
  now?: Date;
}): SignedRequest {
  const { creds, region, service, host, body } = opts;
  const path = opts.path ?? '/';
  const now = opts.now ?? new Date();
  const amz = amzDate(now);
  const dateStamp = amz.slice(0, 8);
  const contentType = 'application/x-www-form-urlencoded; charset=utf-8';
  const payloadHash = sha256Hex(utf8(body));

  // Canonical headers: lowercase names, sorted, trimmed values, each `\n`-terminated.
  const headerMap: Record<string, string> = {
    'content-type': contentType,
    host: host,
    'x-amz-date': amz,
  };
  if (creds.sessionToken) headerMap['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(headerMap).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headerMap[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    'POST',
    path,
    '', // canonical query string (empty — everything is in the body)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amz,
    scope,
    sha256Hex(utf8(canonicalRequest)),
  ].join('\n');

  const kDate = hmacSha256(utf8('AWS4' + creds.secretAccessKey), utf8(dateStamp));
  const kRegion = hmacSha256(kDate, utf8(region));
  const kService = hmacSha256(kRegion, utf8(service));
  const kSigning = hmacSha256(kService, utf8('aws4_request'));
  const signature = toHex(hmacSha256(kSigning, utf8(stringToSign)));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-Amz-Date': amz,
    Authorization: authorization,
  };
  if (creds.sessionToken) headers['X-Amz-Security-Token'] = creds.sessionToken;
  return { headers, amzDate: amz };
}
