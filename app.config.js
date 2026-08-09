const { execSync } = require('child_process');

/**
 * Build provenance.
 *
 * The point is that anyone holding a TestFlight/App Store build can tell which
 * commit it came from. `app.json` stays the static config; this file only adds
 * the commit the bundle was built from into `extra.build`, which the app reads
 * back at runtime (see `src/constants/build-info.ts`).
 *
 * EAS Build sets `EAS_BUILD_GIT_COMMIT_HASH` on the build worker, which is the
 * authoritative value for a cloud build — the worker has no `.git` directory,
 * so shelling out to git only works for local runs.
 */
const REPOSITORY_URL = 'https://github.com/oogxdd/coderoamer';

function resolveGitCommit() {
  const fromEas = process.env.EAS_BUILD_GIT_COMMIT_HASH;
  if (fromEas) return fromEas.trim();

  // Set by GitHub Actions, and by `eas build` when the CLI forwards it.
  const fromCi = process.env.GITHUB_SHA ?? process.env.EXPO_PUBLIC_GIT_SHA;
  if (fromCi) return fromCi.trim();

  try {
    return execSync('git rev-parse HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    // Not a git checkout (or git missing) — a dev build, so provenance is moot.
    return null;
  }
}

function resolveGitDirty() {
  if (process.env.EAS_BUILD_GIT_COMMIT_HASH || process.env.GITHUB_SHA) return false;
  try {
    const status = execSync('git status --porcelain', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

/**
 * Only keep keys that have a value: Expo serializes the public config through a
 * schema that turns `null` into `{}`, and `{}` is truthy — an absent commit
 * would then read as a present one.
 */
function defined(entries) {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value != null));
}

module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    build: defined({
      repositoryUrl: REPOSITORY_URL,
      gitCommit: resolveGitCommit(),
      gitDirty: resolveGitDirty() || undefined,
      // Deliberately no build timestamp: the config feeds the Expo fingerprint,
      // and a value that changes on every evaluation would make the fingerprint
      // useless. The release notes carry the build time.
      easBuildId: process.env.EAS_BUILD_ID,
      easBuildProfile: process.env.EAS_BUILD_PROFILE,
    }),
  },
});
