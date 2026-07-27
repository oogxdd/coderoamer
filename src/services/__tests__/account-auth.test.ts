import { describe, expect, it } from 'vitest';
import {
  parseLoginPrompt,
  stripAnsi,
  buildGithubPatCommand,
  githubTokenType,
} from '../account-auth';

// Trimmed real output captured from `codex login --device-auth` (codex-cli 0.144.0).
const CODEX_OUTPUT =
  'Welcome to Codex [v\x1b[90m0.144.0\x1b[0m]\r\n' +
  '\x1b[90mOpenAI’s command-line coding agent\x1b[0m\r\n\r\n' +
  'Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n' +
  '1. Open this link in your browser and sign in to your account\r\n' +
  '   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n' +
  '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n' +
  '   \x1b[94mU79V-EZHWN\x1b[0m\r\n';

// Trimmed real output captured from `vercel login` (Vercel CLI 57.0.0),
// including the OSC browser-open sequence it emits mid-spinner.
const VERCEL_OUTPUT =
  '\x1b[2mVercel CLI 57.0.0 (Node.js 24.18.0)\x1b[22m\r\n' +
  '\x1b[90m>\x1b[39m \r\n' +
  '  Visit \x1b[1mhttps://vercel.com/oauth/device?user_code=WHFP-LJMC\x1b[22m\r\n\r\n' +
  '\x1b]9999;browser-open;https://vercel.com/oauth/device?user_code=WHFP-LJMC\x1b\\' +
  '\x1b[90mWaiting for authentication...\x1b[39m';

describe('parseLoginPrompt', () => {
  it('extracts the codex device URL and one-time code', () => {
    const prompt = parseLoginPrompt('codex', CODEX_OUTPUT);
    expect(prompt.url).toBe('https://auth.openai.com/codex/device');
    expect(prompt.code).toBe('U79V-EZHWN');
  });

  it('reports nothing for codex when the CLI failed to start', () => {
    const prompt = parseLoginPrompt('codex', "error: unexpected argument '--device-auth' found\n");
    expect(prompt.url).toBeUndefined();
    expect(prompt.code).toBeUndefined();
  });

  it('extracts the vercel device URL with the embedded code', () => {
    const prompt = parseLoginPrompt('vercel', VERCEL_OUTPUT);
    expect(prompt.url).toBe('https://vercel.com/oauth/device?user_code=WHFP-LJMC');
    expect(prompt.code).toBe('WHFP-LJMC');
  });

  it('returns an empty prompt for vercel before the URL is printed', () => {
    expect(parseLoginPrompt('vercel', 'Vercel CLI 57.0.0\n')).toEqual({});
  });

  it('extracts the github one-time code', () => {
    const prompt = parseLoginPrompt(
      'github',
      '! First copy your one-time code: 1D2E-A3F4\nOpen this URL to continue…\n'
    );
    expect(prompt.url).toBe('https://github.com/login/device');
    expect(prompt.code).toBe('1D2E-A3F4');
  });

  it('picks the manual (platform.claude.com) authorize URL for claude', () => {
    const raw =
      'Open: https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5173&state=x\n' +
      'Or visit: https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Fcallback&state=y\n';
    const prompt = parseLoginPrompt('claude', raw);
    expect(prompt.url).toContain('platform.claude.com');
  });
});

describe('stripAnsi', () => {
  it('removes CSI colors and OSC browser-open sequences', () => {
    const text = stripAnsi(VERCEL_OUTPUT);
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('browser-open');
    expect(text).toContain('Visit https://vercel.com/oauth/device?user_code=WHFP-LJMC');
  });
});

describe('buildGithubPatCommand', () => {
  it('pipes the token into gh with a git-credentials fallback', () => {
    const cmd = buildGithubPatCommand('github_pat_abc123');
    expect(cmd).toContain("printf '%s\\n' 'github_pat_abc123' | gh auth login");
    expect(cmd).toContain('--with-token');
    expect(cmd).toContain('gh auth setup-git');
    expect(cmd).toContain('WISP_PAT_GH');
    expect(cmd).toContain('~/.git-credentials');
    expect(cmd).toContain('WISP_PAT_GIT_ONLY');
  });

  it('escapes single quotes so the token cannot break out of the shell string', () => {
    const cmd = buildGithubPatCommand("ab'c");
    expect(cmd).toContain("'ab'\\''c'");
  });
});

describe('githubTokenType', () => {
  it('classifies token prefixes', () => {
    expect(githubTokenType('github_pat_x')).toBe('fine-grained');
    expect(githubTokenType('ghp_x')).toBe('classic');
    expect(githubTokenType('gho_x')).toBe('oauth');
    expect(githubTokenType('something')).toBe('unknown');
  });
});
