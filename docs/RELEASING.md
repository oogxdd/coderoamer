# Releasing iOS builds, and proving where they came from

The goal is not a bit-for-bit reproducible build — Apple re-signs and re-encrypts every binary it
distributes, so an `.ipa` downloaded from TestFlight can never be byte-identical to one built
locally. The goal is **provenance**: anyone holding a TestFlight or App Store build can establish,
without trusting us, that it was produced from one specific public commit.

The chain is:

```
git tag v1.5.0  →  GitHub Actions  →  EAS Build  →  TestFlight 1.5.0 (137)
                                          │
                                          └── commit SHA recorded in three places:
                                              the binary, the GitHub Release, the EAS build record
```

## What the workflow enforces

`.github/workflows/ios-testflight.yml` runs on a `v*` tag push and refuses to release unless:

1. the tag is semver (`v1.2.3`) and points at a commit that is on `origin/main`;
2. the tag version equals `expo.version` in `app.json`;
3. the EAS build reports the same `gitCommitHash` as the tagged commit — this is the check that
   makes the published claim true rather than merely intended;
4. the build finished successfully.

Only then does it publish a GitHub Release stating the commit, marketing version, iOS build
number, and EAS build id.

## The commit is inside the app

`app.config.js` stamps the commit into `extra.build.gitCommit`. On EAS it comes from
`EAS_BUILD_GIT_COMMIT_HASH`, which the build worker sets itself — the app cannot claim a commit
that EAS did not build. Locally it falls back to `git rev-parse HEAD` and marks the build dirty if
the working tree had uncommitted changes.

`src/constants/build-info.ts` reads it back, and **Settings → About** shows:

```
Version            1.5.0 (137)
Built from commit  eac4631          ← tap to open on GitHub, long-press to copy
```

The version and build number come from the native binary (`expo-application`), not from the JS
bundle, so they are exactly the values TestFlight shows.

## How a user verifies a build

1. Open Settings → About in the installed app; note version, build number, commit.
2. Open the GitHub Release for that version. It lists the same three values.
3. Tap the commit to read the source that produced the binary.

If any of the three disagree, the build did not come from that commit.

## One-time setup

1. **`EXPO_TOKEN`** — create an Expo access token (expo.dev → account settings → access tokens)
   and add it as a repository secret named `EXPO_TOKEN`.
2. **EAS project link** — `app.json` already has `extra.eas.projectId`; confirm it points at the
   Expo project you ship from.
3. **iOS credentials in EAS** for bundle id `com.digital.coderoamer`: distribution certificate and
   App Store provisioning profile. EAS-managed credentials are the simplest option.
4. **EAS Submit** — store an App Store Connect API key in EAS for the `production` submit profile.
   `eas.json` already carries `ascAppId`.
5. **App Store Connect record** for `com.digital.coderoamer`, with TestFlight enabled.

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
