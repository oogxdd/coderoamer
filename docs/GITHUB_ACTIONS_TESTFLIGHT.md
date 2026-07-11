# GitHub Actions TestFlight setup

This repo has one release workflow:

- `.github/workflows/ios-testflight.yml`
- Trigger: push a semver `v*` tag, for example `v1.2.3`, whose commit is on
  `main`
- Command: `eas build --platform ios --profile production --auto-submit --wait`

## What you need to finish once

1. Create an Expo access token and add it as a GitHub Actions secret named
   `EXPO_TOKEN`.
2. Make sure this repo is linked to the correct EAS project. `app.json` already
   contains `extra.eas.projectId`, so verify it points at the Expo project you
   want to ship.
3. In EAS, configure iOS credentials for `com.digital.spritespack`:
   distribution certificate and App Store provisioning profile. EAS-managed
   credentials are the simplest option.
4. Configure EAS Submit for App Store Connect. The recommended setup is an App
   Store Connect API key stored in EAS for the production submit profile.
5. Confirm the App Store Connect app record exists for bundle ID
   `com.digital.spritespack` and TestFlight is enabled.

## Cutting a release

Release only from `main`:

```bash
git checkout main
git pull
git tag v1.2.3
git push origin v1.2.3
```

The workflow rejects tags that are not on `origin/main`.

`eas.json` uses `appVersionSource: "remote"` and production
`autoIncrement: true`, so EAS owns the iOS build number. Bump the user-facing
version in `app.json` when you want a new marketing version.
