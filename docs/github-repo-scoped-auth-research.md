# GitHub repo-scoped OAuth research

Status: research only. This flow is **not implemented** in CodeRoamer.

## Conclusion

GitHub cannot generate a fine-grained personal access token (PAT) through an
OAuth authorization flow. A normal OAuth App returns an OAuth token with coarse
scopes such as `repo`; organization owners also cannot approve an OAuth App for
only selected repositories.

The closest supported experience is a **GitHub App installation plus a GitHub
App user access token**:

- GitHub's installation screen provides the desired **Only select
  repositories** picker.
- The app can request narrowly defined repository permissions.
- Device authorization works for a phone-driven/headless flow without shipping
  a client secret.
- The resulting credential is a GitHub App user access token (`ghu_`), not a PAT.

GitHub recommends GitHub Apps over OAuth Apps when an integration needs
fine-grained permissions and selected-repository access. See
[Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
and
[GitHub's organization access rules](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/limiting-oauth-app-and-github-app-access-requests-and-installations).

## Recommended third option

If this is implemented later, the user-facing flow should be:

1. Open the CodeRoamer GitHub App installation page.
2. Choose a personal account or organization.
3. Choose **Only select repositories**, select the repositories, and install
   the app.
4. Return to CodeRoamer and complete the GitHub App device flow at
   `https://github.com/login/device`.
5. CodeRoamer requests a GitHub App user access token and queries
   `GET /user/installations` followed by
   `GET /user/installations/{installation_id}/repositories`.
6. Show the exact accessible repositories before storing anything in the
   Sprite.
7. Provision the token through the existing Exec WebSocket stdin path, never in
   a shell command, URL, task name, or log.

GitHub documents the installation repository picker in
[Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).
The token's effective access is the intersection of the app's permissions, the
repositories selected for its installation, and the user's own access. The
installation/repository discovery endpoints are documented under
[REST API endpoints for GitHub App installations](https://docs.github.com/en/rest/apps/installations).

An optional `repository_id` can further restrict a device-flow user token to
one repository. It does not replace the installation step or grant the GitHub
App access to a repository that was not selected during installation. See
[Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

## Minimal GitHub App permissions

The initial GitHub App registration should request:

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read | Automatically included for repository discovery |
| Contents | Read and write | Clone, create branches, commit, and push over HTTPS |
| Pull requests | Read and write | Read and create pull requests |
| Workflows | None by default | Add only if the agent must modify files in `.github/workflows` |

GitHub explicitly supports both installation and user access tokens as the
password for HTTP Git when the app has the Contents permission. See
[Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).
Actions performed on behalf of a person should use a user access token rather
than an installation access token, as recommended in
[GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

## Token lifetime and architecture

Device flow is the best fit for the current app because it only needs the
registered GitHub App's client ID. A client secret is not required to issue the
token, and is also not required to refresh a token originally issued through
device flow.

There is still lifecycle work:

- GitHub App user access tokens expire after eight hours by default.
- Their refresh tokens expire after six months.
- Refresh rotates both credentials, so CodeRoamer must store the refresh token
  securely, refresh before expiry, and update the credential inside each
  connected Sprite.
- If the refresh token expires or is revoked, the user must authorize again.
- Token expiry can be disabled in the GitHub App settings, but GitHub recommends
  expiring tokens.

The exact rules and refresh request are in
[Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

A backend is therefore not strictly required for the device/refresh protocol.
However, native CodeRoamer should keep refresh tokens in SecureStore. The web
client currently uses browser storage, so a production web rollout needs a
separate threat-model decision before retaining long-lived refresh credentials.
A backend would also be required if the design switched to installation tokens,
because minting those requires the GitHub App private key.

## Product and organization caveats

- A user needs repository admin or organization-owner permission to install the
  app directly. Otherwise GitHub turns the action into an approval request.
- Organization policies and SAML SSO may require an owner approval or an active
  SSO session.
- The installation can later gain or lose repositories. The Integrations tab
  must refresh the displayed access list, not treat the initial selection as
  permanent.
- Public-client device flow can be impersonated through a reused client ID.
  GitHub considers it appropriate for constrained/headless clients, but the UI
  must clearly identify CodeRoamer and avoid phishing-like prompts.

## Required proof before implementation

Build a disposable GitHub App and verify the complete flow against both a
personal repository and an organization repository:

1. install with one selected repository;
2. obtain a `ghu_` token through device flow;
3. list only the selected repository through the installation endpoints;
4. `git clone`, create a branch, and `git push`;
5. create a pull request with `gh pr create`;
6. confirm a second, non-selected private repository is inaccessible;
7. refresh the token and repeat Git and `gh` operations;
8. test organization approval and SAML SSO behavior;
9. test refresh while the phone app is backgrounded and while the Sprite has
   been asleep.

Until that proof passes, keep the shipped choices as GitHub CLI login and a
user-created fine-grained PAT.
