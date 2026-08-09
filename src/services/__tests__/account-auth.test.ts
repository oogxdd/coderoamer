import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  PROVIDERS,
  buildVercelLoginCommand,
  buildGithubDeviceCommand,
  buildGithubDeviceScript,
  containsClaudeOAuthToken,
  decodeLoginOutputFrame,
  githubTokenType,
  isGithubToken,
  makeLoginStdinFrame,
  makeLoginStdinPayload,
  parseExecControlEvent,
  parseGithubAccessSummary,
  parseLoginPrompt,
  sanitizedLoginOutput,
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

  it('waits for GitHub output and normalizes a terminal-spaced device code', () => {
    expect(parseLoginPrompt('github', 'Starting GitHub sign-in…')).toEqual({
      url: undefined,
      code: undefined,
    });
    expect(parseLoginPrompt('github', 'First copy your one-time code: 7 7 0 1 - C 5 F 6')).toEqual({
      url: 'https://github.com/login/device',
      code: '7701-C5F6',
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

  it('detects a Claude setup token through terminal formatting', () => {
    expect(
      containsClaudeOAuthToken('\u001b[32msk-ant-oat01-example_token-123\u001b[0m')
    ).toBe(true);
    expect(containsClaudeOAuthToken('Waiting for browser authorization')).toBe(false);
  });

  it('redacts credentials and authorization URLs from diagnostic output', () => {
    const code = 'callback-secret-value-that-must-not-appear';
    const preview = sanitizedLoginOutput(
      `Open https://claude.com/oauth?code=secret\n${code}\nsk-ant-oat01-secret_token\nInvalid code`,
      [code]
    );
    expect(preview).toContain('[authorization URL]');
    expect(preview).toContain('[submitted code]');
    expect(preview).toContain('[redacted token]');
    expect(preview).toContain('Invalid code');
    expect(preview).not.toContain('secret');
  });
});

describe('exec login protocol', () => {
  it('recognizes lifecycle messages without treating them as provider output', () => {
    expect(
      parseExecControlEvent('{"type":"session_info","session_id":"1696","cols":0,"rows":0}')
    ).toEqual({ type: 'session_info', sessionId: '1696', cols: 0, rows: 0 });
    expect(parseExecControlEvent('{"type":"exit","exit_code":127}')).toEqual({
      type: 'exit',
      exitCode: 127,
    });
    expect(parseExecControlEvent('Open https://auth.openai.com/codex/device')).toBeUndefined();
  });

  it('prefixes stdin payloads with stream id zero', () => {
    expect(Array.from(makeLoginStdinFrame('ok'))).toEqual([0, 111, 107]);
  });

  it('sends TTY keystrokes raw and keeps non-TTY stdin framed', () => {
    expect(Array.from(makeLoginStdinPayload('ok\r', true))).toEqual([111, 107, 13]);
    expect(Array.from(makeLoginStdinPayload('ok\n', false))).toEqual([0, 111, 107, 10]);
  });

  it('treats unprefixed PTY bytes as raw stdout', () => {
    const bytes = new Uint8Array([13, 10, 67, 111, 100, 101, 120]);
    const frame = decodeLoginOutputFrame(bytes, true);
    expect(frame?.streamId).toBe(1);
    expect(frame?.rawTty).toBe(true);
    expect(frame?.payload).toBe(bytes);
  });

  it('keeps multiplexed stdout framing when a stream id is present', () => {
    const frame = decodeLoginOutputFrame(new Uint8Array([1, 79, 75]), true);
    expect(frame?.streamId).toBe(1);
    expect(frame?.rawTty).toBe(false);
    expect(Array.from(frame?.payload ?? [])).toEqual([79, 75]);
  });
});

describe('Vercel login command', () => {
  it('uses package runners instead of a crashing global npm install', () => {
    const command = buildVercelLoginCommand();
    expect(command).not.toContain('npm install -g');
    expect(command).toContain('pnpm dlx vercel@latest');
    expect(command).toContain('bunx vercel@latest');
    expect(command).toContain('npx --yes vercel@latest');
    expect(command).toContain('$HOME/.local/bin/vercel');
    expect(spawnSync('bash', ['-n', '-c', command]).status).toBe(0);
  });
});

describe('GitHub Sprite-side device flow', () => {
  it('keeps OAuth polling and token persistence inside the Sprite', () => {
    const script = buildGithubDeviceScript();
    const command = buildGithubDeviceCommand();
    expect(script).toContain('https://github.com/login/device/code');
    expect(script).toContain('https://github.com/login/oauth/access_token');
    expect(script).toContain('.sprite_env');
    expect(script).not.toContain('client_secret');
    expect(spawnSync(process.execPath, ['--check', '-'], { input: script }).status).toBe(0);
    expect(spawnSync('bash', ['-n', '-c', command]).status).toBe(0);
  });
});

describe('GitHub token helpers', () => {
  it('classifies supported token prefixes', () => {
    expect(githubTokenType('github_pat_abc')).toBe('fine-grained');
    expect(githubTokenType('ghp_abc')).toBe('classic');
    expect(githubTokenType('gho_abc')).toBe('oauth');
    expect(githubTokenType('something_else')).toBe('unknown');
  });

  it('rejects shell metacharacters before a token reaches exec stdin', () => {
    expect(isGithubToken('github_pat_safe_123')).toBe(true);
    expect(isGithubToken("github_pat_bad'quote")).toBe(false);
    expect(isGithubToken('github_pat_bad space')).toBe(false);
  });

  it('parses the sentinel access summary without exposing a token', () => {
    expect(
      parseGithubAccessSummary(
        [
          'shell noise',
          '@@WISP_GITHUB@@',
          'login=octocat',
          'mode=fine-grained',
          'repo_count=2',
          'repo=octocat/hello-world',
          'repo=octocat/private-repo',
          '@@WISP_GITHUB_END@@',
        ].join('\n')
      )
    ).toEqual({
      login: 'octocat',
      tokenType: 'fine-grained',
      repos: ['octocat/hello-world', 'octocat/private-repo'],
      repoCount: 2,
      allRepos: false,
    });
  });
});
