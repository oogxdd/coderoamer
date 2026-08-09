# Developing & shipping to iOS / TestFlight

How to run the app on a simulator or a real iPhone, then build and publish to TestFlight. This is an
[Expo](https://expo.dev) app, so the build/submit path uses **EAS** (Expo Application Services).

> **Important:** this app bundles custom native modules (`@shopify/react-native-skia`,
> `react-native-webview`, `react-native-reanimated`/worklets). It will **not** run in the stock
> Expo Go app — you need a *dev build* (a compiled app that includes those modules). Everything
> below uses dev builds.

---

## 0. One-time prerequisites

- **macOS + Xcode** (from the App Store), then once:
  ```bash
  xcode-select --install
  sudo xcodebuild -license accept
  ```
- **Node 18+** and a package install:
  ```bash
  npm install            # .npmrc already sets legacy-peer-deps=true
  ```
- **Apple Developer Program** membership ($99/yr) — required for TestFlight and for running on a
  physical device beyond 7 days. A free Apple ID can sideload to your *own* device for 7 days.
- **EAS CLI** and login (free Expo account):
  ```bash
  npm install -g eas-cli
  eas login
  ```

The iOS bundle identifier is already set in `app.json` (`com.digital.coderoamer`). Change it if
you don't own that identifier.

---

## 1. Run on the iOS Simulator

```bash
npx expo run:ios
```

This prebuilds the native `ios/` project, compiles a dev build, boots a simulator, and starts the
Metro bundler. Subsequent runs are faster. To pick a specific simulator:

```bash
npx expo run:ios --list-devices
```

Once it's running, just `npx expo start` on later sessions and press `i` — it reuses the installed
dev build.

---

## 2. Run on a physical iPhone

1. Plug the iPhone in via USB and trust the computer.
2. Open `ios/sprites-manager.xcworkspace` in Xcode once, select your **Team** under
   *Signing & Capabilities* (this registers the device + provisioning). Free Apple IDs work for a
   7-day signing; the paid program is needed for longer.
3. Then from the terminal:
   ```bash
   npx expo run:ios --device          # choose your iPhone from the list
   ```
4. On the device, Settings → General → VPN & Device Management → trust your developer cert (first
   run only).

Wireless reloads: keep the phone and Mac on the same network; Metro pushes JS updates over the
dev server. You only need to recompile (`run:ios`) when **native** code/deps change — JS/TSX changes
hot-reload via Fast Refresh.

---

## 3. The dev loop

- **JS/TSX changes** → saved instantly via Fast Refresh. No rebuild.
- **Added/updated a native module, changed `app.json` native config, or app icon/splash** → rebuild
  with `npx expo run:ios` (or `npx expo prebuild --clean` first if the native project drifted).
- Press `r` in the Metro terminal to reload, `j` to open the debugger.

> The optional dev-client menu (shake gesture) gives you network inspection and reload controls.
> Add it once with `npx expo install expo-dev-client`, then rebuild.

---

## 4. Build for TestFlight with EAS

`eas.json` in the repo already defines `development`, `preview`, and `production` profiles.

> Store releases should not be built from a laptop. Push a `v*` tag and let
> `.github/workflows/ios-testflight.yml` build, submit, and publish the release record — that is
> what ties a TestFlight build to a public commit. See [`docs/RELEASING.md`](docs/RELEASING.md).
> The commands below are for local experimentation.

### 4a. First-time project setup

```bash
eas init                # links this repo to an EAS project (writes extra.eas.projectId)
```

### 4b. (Optional) a simulator build to share

A `preview` build runs on any simulator without Apple credentials — handy for quick sharing:

```bash
eas build --platform ios --profile preview
```

### 4c. Production build for the store

```bash
eas build --platform ios --profile production
```

- EAS asks to **generate/manage your iOS credentials** (distribution certificate + provisioning
  profile) the first time — let it manage them unless you have your own.
- `production` uses `autoIncrement` + `appVersionSource: "remote"`, so EAS bumps the **build number**
  automatically. The user-facing **version** comes from `app.json` → `expo.version` (bump it for
  each marketing release).
- The build runs in the cloud and produces an `.ipa`.

### 4d. Submit to App Store Connect / TestFlight

```bash
eas submit --platform ios --latest
```

First submit: EAS can **create the App Store Connect app record** for you. You'll authenticate with
either an **App Store Connect API key** (recommended — create one at
App Store Connect → Users and Access → Integrations → App Store Connect API) or your Apple ID.

You can also do build + submit in one step:

```bash
eas build --platform ios --profile production --auto-submit
```

### 4e. TestFlight

1. App Store Connect → your app → **TestFlight**. The build appears as *Processing* for a few minutes.
2. **Internal testers** (up to 100 App Store Connect users): no Apple review — available as soon as
   processing finishes. Add them under *Internal Testing*.
3. **External testers** (public/link or email, up to 10k): require a one-time **Beta App Review**
   and basic test info (what to test, contact email).
4. Testers install the **TestFlight app** from the App Store and accept the invite.

> **Export compliance:** TestFlight asks about encryption on each build. This app only uses standard
> HTTPS/system crypto, so it's normally exempt. To stop being asked, add to `app.json`:
> ```json
> "ios": { "config": { "usesNonExemptEncryption": false } }
> ```

---

## 5. Releasing updates

- **JS-only change** (no native change): you can ship over-the-air with EAS Update without a new
  TestFlight build — `npx expo install expo-updates`, then `eas update --branch production`. (Native
  changes still require a new build.)
- **New TestFlight build:** bump `expo.version` in `app.json` for a new marketing version, then
  `eas build -p ios --profile production --auto-submit` (build number auto-increments).

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `npm install` peer-dep error | Ensure `.npmrc` (with `legacy-peer-deps=true`) is present; it's committed. |
| EAS cloud build fails on install | Same — `.npmrc` is read by EAS. Confirm it's committed, not gitignored. |
| Native module "undefined"/red screen after adding a dep | Rebuild: `npx expo prebuild --clean && npx expo run:ios`. |
| Signing errors on device | Open the workspace in Xcode, set your Team under Signing & Capabilities, run once from Xcode. |
| Build uploads but never appears in TestFlight | Wait for *Processing*; check email for an Apple "Invalid binary" notice (often missing export-compliance or an entitlement). |
| Wrong/duplicate build number | `production` uses remote `autoIncrement`; don't also bump `ios.buildNumber` by hand. |

---

## Quick reference

```bash
npm install                                            # deps (.npmrc handles peer conflict)
npx expo run:ios                                       # dev build on simulator
npx expo run:ios --device                              # dev build on connected iPhone
eas build  --platform ios --profile preview            # shareable simulator build
eas build  --platform ios --profile production         # store build (.ipa)
eas submit --platform ios --latest                     # upload to TestFlight
eas build  --platform ios --profile production --auto-submit   # build + upload
```
