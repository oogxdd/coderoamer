# Research: a "convenient PAT" — repo-scoped GitHub auth with an OAuth-style flow

**Question.** The Integrations tab offers two GitHub options: the `gh` CLI web login
(full account access) and pasting a fine-grained PAT (repo-scoped, but the user has
to hand-assemble the token on github.com). Is there a third option — an OAuth-style
tap-through flow where the user just picks repos from a list and ends up with a
credential limited to those repos?

**Status: research only, not implemented.**

## TL;DR

- A plain **OAuth app cannot do this.** OAuth scopes are coarse: `repo` grants every
  repository the user can access, and there is no per-repository scope and no repo
  picker in the OAuth authorize screen. This is exactly why the current web login is
  all-or-nothing.
- A **GitHub App can.** Repository selection is built into the *installation* step
  ("Only select repositories" — GitHub's own repo-picker UI), and a user access
  token issued for a GitHub App is limited to the intersection of (a) the repos the
  installation was granted and (b) what the user themself can access.
- The flow can be **client-only** (no CodeRoamer backend): the OAuth *device flow*
  for GitHub Apps requires no client secret, and the app already ships a working
  device-flow implementation in `src/services/github.ts` (currently pointed at an
  OAuth app). Swapping the client id for a GitHub App id + adding an
  "install the app" hop is the bulk of the work.

## Why OAuth apps are out

- Scopes (`repo`, `public_repo`, `read:org`, …) apply account-wide. `public_repo`
  is the only narrowing that exists, and it narrows by visibility, not by repo.
- The authorize page has no repository selection UI and never will — GitHub's
  documented answer to "I want per-repo grants" is GitHub Apps or fine-grained PATs.

## How the GitHub App route works

1. **Register a GitHub App** (one-time, under the developer's account or an org):
   - Repository permissions: `Contents: Read and write`, `Pull requests: Read and
     write` (Metadata: Read-only is implied). Add `Workflows: Read and write` if
     agents should be able to push changes to `.github/workflows/*`.
   - Enable **Device Flow** in the app settings.
   - Webhook: none needed.
   - Optionally opt out of user-token expiration (see caveats).
2. **In-app device flow** — identical to the existing `requestDeviceCode` /
   `pollForToken` in `src/services/github.ts`, but with the GitHub App's client id
   and **no `scope` parameter** (permissions come from the app registration):
   - `POST https://github.com/login/device/code` → user code + verification URL.
   - User enters the code at `github.com/login/device` (same UX as the gh login).
   - Poll `POST https://github.com/login/oauth/access_token` with
     `grant_type=urn:ietf:params:oauth:grant-type:device_code` → a **user access
     token** (`ghu_…`).
3. **Check / create the installation** (this is where repos get picked):
   - `GET /user/installations` with the token → is the app installed for this user?
   - If not (or the user wants to change repos), open
     `https://github.com/apps/<app-slug>/installations/new` in the browser —
     GitHub shows its native picker: *All repositories* vs *Only select
     repositories* with a searchable repo list.
   - Poll `GET /user/installations` until the installation appears, then
     `GET /user/installations/{installation_id}/repositories` to show the user
     exactly what the sprite will reach (the same "what can this sprite access"
     panel the PAT flow has).
4. **Provision the sprite** exactly like the PAT path:
   `printf '%s\n' "$TOKEN" | gh auth login --with-token && gh auth setup-git`.
   `ghu_` tokens behave like OAuth tokens for `gh` and for
   `https://x-access-token:<token>@github.com` git pushes.

No JWT signing and no installation-access-token minting is needed — those are for
server-to-server GitHub App auth (which *would* require keeping a private key, i.e.
a backend). The user-access-token path above stays entirely in the client.

## Caveats

- **Token expiry.** By default GitHub App user tokens expire after 8 hours and come
  with a refresh token (`ghr_…`, 6 months). A headless sprite can't re-run a device
  flow, so either (a) the app registration opts out of user-token expiration —
  simplest, token behaves like today's `gho_` gh token — or (b) CodeRoamer stores
  the refresh token client-side and re-provisions sprites with fresh tokens
  (refresh also needs no client secret for device-flow apps).
- **Org repositories.** Installing the app on an org (or on org repos) may require
  org-admin approval depending on org settings; SAML-protected orgs add another
  prompt. Personal repos are friction-free.
- **The installation outlives the session.** Repo grants live on the user's GitHub
  account (Settings → Applications → Installed GitHub Apps), not in the token, so
  "which repos did I grant?" has a stable server-side answer — arguably better
  than a PAT, which shows nothing after creation.
- **App identity.** Someone has to own the registered GitHub App (name, logo,
  slug); the client id ships in the app binary (that's fine — it is not a secret,
  same as the current OAuth client id).
- **`gh` CLI edge cases.** A few `gh` commands assume classic scopes (`read:org`
  for some org listings, gists). Same limitation the fine-grained PAT path already
  has; core clone/branch/push/PR flows work.

## Comparison

| | gh web login | fine-grained PAT (implemented) | GitHub App (this research) |
|---|---|---|---|
| Repo scoping | none — full account | yes, but manual assembly on github.com | yes, native picker UI |
| User effort | lowest | highest (form with ~6 decisions) | low (2 browser hops) |
| Client-only | yes | yes | yes (device flow, no secret) |
| Expiry | no (gh token) | user-chosen | 8h+refresh, or opt-out |
| Visibility of grants | n/a | app shows repo list after validation | queryable any time via `/user/installations` |
| One-time setup cost | none | none | register + maintain a GitHub App |

## Recommendation

Ship the two current options. If PAT assembly proves to be the drop-off point, the
GitHub App route is the right "convenient" upgrade: it reuses the existing device
flow code, needs no backend, and gives a *better* answer to "what did I grant"
than PATs do. Estimated effort: register the app, ~1 day of client work (install
check + picker hop + refresh handling), plus copy.

## Sources

- GitHub docs — *Scopes for OAuth apps* (no per-repo scopes)
- GitHub docs — *Choosing permissions for a GitHub App*
- GitHub docs — *Generating a user access token for a GitHub App* → "Using the
  device flow", token expiry & refresh, and the note that user access tokens are
  limited to resources both the app installation and the user can access
- GitHub docs — REST: `GET /user/installations`,
  `GET /user/installations/{installation_id}/repositories`
- Existing code: `src/services/github.ts` (device flow for the current OAuth app)
