// Public OAuth client used by GitHub CLI's device flow. Keeping the Sprite-side
// integration on the same client makes it equivalent to `gh auth login` while
// avoiding gh's interactive terminal prompts.
export const GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a';
export const GITHUB_DEVICE_SCOPE = 'repo user:email read:org';
