# Releasing iOS builds, and proving where they came from

The goal is not a bit-for-bit reproducible build — Apple re-signs and re-encrypts every binary it
distributes, so an `.ipa` downloaded from TestFlight can never be byte-identical to one built
locally. The goal is **provenance**: what Apple received came from one specific public commit,
through a public workflow run, and the claim is signed by someone other than the maintainer.

The chain is:

```
git tag v1.5.0  →  GitHub Actions  →  EAS Build  →  TestFlight 1.5.0 (137)
                                          │
                                          └── commit SHA recorded in: the binary, the GitHub
                                              Release, the EAS build record, and a Sigstore
                                              attestation signed by GitHub's workflow identity
```

## What this proves — and what it does not

Summarised: the checks below catch accidental drift, and the attestation catches a release
published by hand claiming a commit it was not built from. They do **not** cover a maintainer who
bypasses CI and submits a local build directly to Apple, and they do not let a user verify the copy
already installed on their phone.

The full reasoning — the threat model, who can attest to what, the ladder from "trust me" to
reproducible builds, and what would strengthen this further — is in
[`PROVENANCE.md`](PROVENANCE.md). Read that before changing anything here, because most of these
steps exist to support a specific claim made in that document.

## What the workflow enforces

`.github/workflows/ios-testflight.yml` runs on a `v*` tag push and refuses to release unless:

1. the tag is semver (`v1.2.3`) and points at a commit that is on `origin/main`;
2. the tag version equals `expo.version` in `app.json`;
3. the EAS build reports the same `gitCommitHash` as the tagged commit — this is the check that
   makes the published claim true rather than merely intended;
4. the build finished successfully.

Only then does it download the exact artifact that was submitted to Apple, hash it, attest it, and
publish a GitHub Release stating the commit, marketing version, iOS build number, EAS build id,
and the SHA-256 of both the IPA and the JavaScript bundle inside it.

## The two things a stranger can check

**The attestation.** `actions/attest-build-provenance` signs a SLSA provenance statement through
Sigstore, using the OIDC identity GitHub issues to this workflow. The maintainer cannot produce
that signature by hand, and it lands in a public transparency log:

```bash
gh attestation verify main.jsbundle --repo oogxdd/coderoamer
```

**The JavaScript bundle.** `main.jsbundle` is attached to every release. It is the code that
actually runs: Apple re-signs and FairPlay-encrypts the Mach-O binary, but leaves resources
untouched, so the bundle that ships is the bundle in the release. Anyone can read it, diff it
against the tagged source, or hash it and compare with the release notes.

Do not promise that a locally produced bundle will hash identically — Metro output is not
guaranteed byte-stable across environments. The bundle is auditable, not (yet) reproducible.

## The commit is inside the app

`app.config.js` stamps the commit into `extra.build.gitCommit`. On EAS it comes from
`EAS_BUILD_GIT_COMMIT_HASH`, which the build worker sets itself — the app cannot claim a commit
that EAS did not build. Locally it falls back to `git rev-parse HEAD` and marks the build dirty if
the working tree had uncommitted changes.

`src/constants/build-info.ts` reads it back, and **Settings → About** shows:

```
Version          1.5.0 (137)
Reported commit  eac4631          ← tap to open on GitHub, long-press to copy
Release record   Open             ← the release, its attestation, and the bundle hash
```

The row is labelled *reported* on purpose: the app is asserting where it came from, and an app
cannot vouch for itself. The release record is where that assertion becomes checkable.

The version and build number come from the native binary (`expo-application`), not from the JS
bundle, so they are exactly the values TestFlight shows.

## How a user verifies a build

1. Open Settings → About in the installed app; note version, build number, commit.
2. Open the release for that version. The version and build number must match what TestFlight
   shows, and the commit must match the About screen.
3. Run `gh attestation verify main.jsbundle --repo oogxdd/coderoamer` on the attached bundle. This
   is the step that does not rely on the maintainer's word.
4. Read the bundle, or the source at that commit, and judge for yourself.

Steps 1–2 catch mistakes. Step 3 is what catches a fabricated release.

## One-time setup

1. **`EXPO_TOKEN`** — create an Expo access token (expo.dev → account settings → access tokens)
   and add it as a repository secret named `EXPO_TOKEN`.
2. **EAS project link** — `app.json` already has `extra.eas.projectId`; confirm it points at the
   Expo project you ship from.
3. **iOS credentials in EAS** for bundle id `com.digital.coderoamer`: distribution certificate and
   App Store provisioning profile. EAS-managed credentials are the simplest option.
4. **EAS Submit** — store an App Store Connect API key in EAS for the `production` submit profile.
   `eas.json` already carries `ascAppId`. Keep that key *only* in EAS: every local copy is another
   way for a build that no workflow ever saw to reach TestFlight.
5. **App Store Connect record** for `com.digital.coderoamer`, with TestFlight enabled.

Nothing else is needed for the attestation — it uses the workflow's own OIDC identity, so there is
no signing key to manage or rotate.

## Cutting a release

```bash
git checkout main
git pull
# bump expo.version in app.json if this is a new marketing version, commit it
git tag v1.5.0
git push origin v1.5.0
```

EAS owns the build number (`appVersionSource: "remote"` with `autoIncrement: true`) — never set
`ios.buildNumber` by hand.

## Why EAS rather than a self-hosted macOS runner

GitHub-hosted macOS runners are free for public repositories, so cost is not the deciding factor.
The reasons to stay on EAS:

- **Credentials.** A self-hosted build means the distribution certificate, private key, and App
  Store Connect API key live in repository secrets. For an open-source repo, every workflow change
  becomes a potential path to those secrets. EAS holds them instead, and the token in GitHub only
  authorises "start a build".
- **Provenance for free.** EAS records `gitCommitHash` per build and can list builds by it, giving
  a second independent record besides the GitHub Release.
- **Less to maintain.** Xcode versions, CocoaPods caches, and provisioning refreshes are somebody
  else's problem.

Moving to a self-hosted runner later does not break anything here: the app reads the commit from
`EAS_BUILD_GIT_COMMIT_HASH` first but falls back to `GITHUB_SHA` and then to git itself, so the
same About screen keeps working.

## If OTA updates are ever added

This project does not use `expo-updates` today, so "binary 1.5.0 (137) == commit X" describes all
the code that runs. If EAS Update is adopted, the binary and the running JS bundle can diverge, and
Settings → About must then show both:

```
Version        1.5.0 (137)
Binary commit  eac4631
Update         a26bd91
```

Otherwise the claim on the About screen quietly stops being true after the first OTA push.
