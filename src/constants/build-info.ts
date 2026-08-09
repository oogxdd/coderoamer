import Constants from 'expo-constants';
import * as Application from 'expo-application';

/**
 * Where this binary came from.
 *
 * `app.config.js` stamps the commit into `extra.build` at build time; the
 * version/build number come from the native binary (EAS owns the build number
 * via `appVersionSource: "remote"`, so it is only knowable after the build).
 * Together they are what a TestFlight tester needs to match the app in their
 * hand against a commit on GitHub.
 */

interface BuildExtra {
  repositoryUrl?: string;
  gitCommit?: string | null;
  gitDirty?: boolean;
  easBuildId?: string | null;
  easBuildProfile?: string | null;
}

const extra = (Constants.expoConfig?.extra?.build ?? {}) as BuildExtra;

/** Expo's config serializer can replace absent values with `{}`, which is truthy. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const REPOSITORY_URL =
  str(extra.repositoryUrl) ?? 'https://github.com/oogxdd/coderoamer';

/** Full commit SHA the binary was built from, or null for an untracked build. */
export const GIT_COMMIT = str(extra.gitCommit);

/** True when the build was made from a working tree with uncommitted changes. */
export const GIT_DIRTY = extra.gitDirty === true;

export const EAS_BUILD_ID = str(extra.easBuildId);

/** Marketing version, e.g. `1.5.0`. */
export const APP_VERSION =
  Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? 'dev';

/** Native build number, e.g. `137`. Matches what TestFlight shows in parentheses. */
export const BUILD_NUMBER = Application.nativeBuildVersion ?? null;

/** Abbreviated SHA, the form used in release notes and GitHub URLs. */
export function shortCommit(sha: string | null = GIT_COMMIT): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/** `1.5.0 (137)`, or just `1.5.0` when the build number is unavailable. */
export function versionLabel(): string {
  return BUILD_NUMBER ? `${APP_VERSION} (${BUILD_NUMBER})` : APP_VERSION;
}

/** Public URL for the commit this binary was built from. */
export function commitUrl(sha: string | null = GIT_COMMIT): string | null {
  return sha ? `${REPOSITORY_URL}/commit/${sha}` : null;
}

/** Public URL for the release that shipped this version, if tagged as `v<version>`. */
export function releaseUrl(): string {
  return `${REPOSITORY_URL}/releases/tag/v${APP_VERSION}`;
}
