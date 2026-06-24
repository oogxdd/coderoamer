# TODO

## Credential provisioning follow-ups

### 1. Verify the captured `claude login` credentials replay
The "Log in with browser" → Capture flow stores `~/.claude/.credentials.json` from a
sprite and replays it onto new sprites via `buildProvisionCommand` (the `claudeCreds`
branch). This path is **not yet verified on a real sprite** — Claude Code reading a
replayed credentials file (and refreshing the access token via the embedded refresh
token) is the part most likely to break across CLI versions.

- Smoke-test on one sprite: capture a login, create a fresh sprite, confirm Claude runs
  authed and keeps working past the access-token expiry (refresh works).
- Safe default meanwhile: the pasted-token path (`CLAUDE_CODE_OAUTH_TOKEN` written to
  `~/.sprite_env`) is well-trodden and stays the fallback.
- Note (decision): we deliberately did **not** use `apiKeyHelper` for the pasted
  subscription token. `apiKeyHelper` sends its value as `X-Api-Key` + `Authorization:
  Bearer` *without* the OAuth beta header, so a subscription `sk-ant-oat01-` token likely
  won't authenticate through it. The documented `CLAUDE_CODE_OAUTH_TOKEN` env var is the
  reliable mechanism and is what we ship. Revisit only if Anthropic documents
  `apiKeyHelper` support for OAuth tokens.
- Refs: `src/services/provision.ts` (`buildProvisionCommand`, `captureClaudeCreds`),
  `src/app/(app)/claude-login.tsx`.

### 2. Add a "Re-provision this sprite" action
Credentials are written once per sprite (guarded by `~/.config/.sprite_provisioned`).
Already-provisioned sprites keep stale credentials after a token rotation or a new
captured login — only newly created sprites pick up the latest.

- Add an action (sprite screen or settings) that clears the marker + the credential
  files and re-runs `provisionSprite`, so a rotated token / replaced login propagates to
  an existing sprite.
- Refs: `src/services/provision.ts` (`ensureProvisioned`, `MARKER`, `provisionSprite`).
