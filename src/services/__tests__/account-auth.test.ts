import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  parseLoginPrompt,
  stripAnsi,
} from '@/services/account-auth';

describe('integration provider metadata', () => {
  it('includes every per-sprite integration', () => {
    expect(PROVIDERS.map((provider) => provider.id)).toEqual([
      'codex',
      'github',
      'claude',
      'vercel',
    ]);
  });
});

describe('parseLoginPrompt', () => {
  it('extracts the Codex device code', () => {
    expect(parseLoginPrompt('codex', 'Enter code ABCD-EFGH')).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGH',
    });
  });

  it('extracts the current Codex 0.144 device output', () => {
    const output = [
      '1. Open this link in your browser and sign in to your account',
      '   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
      '',
      '2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m',
      '   \u001b[94mU7CV-78WZN\u001b[0m',
    ].join('\r\n');

    expect(parseLoginPrompt('codex', output)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'U7CV-78WZN',
    });
  });

  it('extracts the GitHub device code from ANSI output', () => {
    expect(
      parseLoginPrompt('github', '\u001b[32mFirst copy your one-time code: WXYZ-1234\u001b[0m')
    ).toEqual({
      url: 'https://github.com/login/device',
      code: 'WXYZ-1234',
    });
  });

  it('prefers Claude’s manual callback URL', () => {
    const local =
      'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost';
    const manual =
      'https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com';
    expect(parseLoginPrompt('claude', `${local}\n${manual}`).url).toBe(manual);
  });

  it('extracts Vercel’s device URL and code', () => {
    expect(
      parseLoginPrompt(
        'vercel',
        'Visit https://vercel.com/login/device?user_code=VCEL-1234. Code: VCEL-1234'
      )
    ).toEqual({
      url: 'https://vercel.com/login/device?user_code=VCEL-1234',
      code: 'VCEL-1234',
    });
  });
});

describe('stripAnsi', () => {
  it('removes terminal colors', () => {
    expect(stripAnsi('\u001b[1;32mConnected\u001b[0m')).toBe('Connected');
  });
});
