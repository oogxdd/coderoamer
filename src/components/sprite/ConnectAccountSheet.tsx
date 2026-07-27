import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Platform,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import {
  ProviderId,
  providerMeta,
  parseLoginPrompt,
  stripAnsi,
  getAccountSignatures,
  startLogin,
  LoginStream,
  LoginPrompt,
  GithubPatInfo,
  validateGithubPat,
  connectGithubWithPat,
} from '@/services/account-auth';

type Phase = 'starting' | 'awaiting' | 'submitting' | 'success' | 'error';

// GitHub offers two paths: the interactive CLI web login (full account access)
// or pasting a fine-grained PAT (scoped to chosen repos). Other providers go
// straight to the interactive flow.
type Mode = 'method' | 'interactive' | 'pat';

const GITHUB_NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

interface ConnectAccountSheetProps {
  spriteName: string;
  provider: ProviderId;
  onClose: () => void;
  onConnected: (provider: ProviderId) => void;
}

const POLL_INTERVAL_MS = 2500;

export function ConnectAccountSheet({
  spriteName,
  provider,
  onClose,
  onConnected,
}: ConnectAccountSheetProps) {
  const colors = useTheme();
  const meta = providerMeta(provider);

  const [mode, setMode] = useState<Mode>(provider === 'github' ? 'method' : 'interactive');
  const [phase, setPhase] = useState<Phase>('starting');
  const [prompt, setPrompt] = useState<LoginPrompt>({});
  const [codeInput, setCodeInput] = useState('');
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  // PAT path state
  const [patToken, setPatToken] = useState('');
  const [patInfo, setPatInfo] = useState<GithubPatInfo | null>(null);
  const [patBusy, setPatBusy] = useState<'validate' | 'connect' | null>(null);
  const [patError, setPatError] = useState<string>();
  const [patNote, setPatNote] = useState<string>();

  const streamRef = useRef<LoginStream | null>(null);
  const bufferRef = useRef('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settledRef = useRef(false);
  // Credential signature (mtime:size) captured before login begins. Success is a
  // *change* from this baseline, so pre-existing creds (Reconnect) don't count
  // and Codex — which clears its auth file at login start — can't false-succeed.
  const baselineRef = useRef<string | undefined>(undefined);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const finishSuccess = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    stopPolling();
    streamRef.current?.close();
    setPhase('success');
    setTimeout(() => onConnected(provider), 900);
  }, [onConnected, provider, stopPolling]);

  const poll = useCallback(async () => {
    if (baselineRef.current === undefined) return;
    const sig = (await getAccountSignatures(spriteName))[provider];
    if (sig && sig !== baselineRef.current) finishSuccess();
  }, [spriteName, provider, finishSuccess]);

  // Drive the interactive login: capture the baseline, open the stream, parse
  // prompts, and poll the credential signature for a fresh login. Waits until
  // the user has picked the interactive method (GitHub shows a chooser first).
  useEffect(() => {
    if (mode !== 'interactive') return;
    let cancelled = false;

    (async () => {
      try {
        baselineRef.current = (await getAccountSignatures(spriteName))[provider];
      } catch {
        baselineRef.current = '';
      }
      if (cancelled) return;

      pollRef.current = setInterval(() => {
        poll().catch(() => {});
      }, POLL_INTERVAL_MS);

      try {
        const stream = await startLogin(spriteName, provider, {
          onData: (chunk) => {
            bufferRef.current += chunk;
            const next = parseLoginPrompt(provider, bufferRef.current);
            setPrompt((prev) => ({
              url: next.url ?? prev.url,
              code: next.code ?? prev.code,
            }));
            if (next.url || next.code) {
              setPhase((p) => (p === 'starting' ? 'awaiting' : p));
            }
          },
          onExit: () => {
            if (cancelled) return;
            // The CLI finished — confirm against the credential files.
            poll().catch(() => {});
            // If it died without ever producing a sign-in prompt, show its
            // output instead of waiting forever. Delay a beat so a success
            // poll (login completed → CLI exits) can settle first.
            setTimeout(() => {
              if (settledRef.current || cancelled) return;
              const parsed = parseLoginPrompt(provider, bufferRef.current);
              if (!parsed.url && !parsed.code) {
                const tail = stripAnsi(bufferRef.current)
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .slice(-6)
                  .join('\n');
                setError(tail || 'The sign-in command exited unexpectedly.');
                setPhase('error');
              }
            }, 3500);
          },
          onError: () => {
            /* transient; the signature poll is the source of truth */
          },
        });
        if (cancelled) {
          stream.close();
          return;
        }
        streamRef.current = stream;
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message ?? 'Failed to start sign-in');
          setPhase('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
      streamRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const openBrowser = useCallback(async () => {
    if (!prompt.url) return;
    try {
      await WebBrowser.openBrowserAsync(prompt.url);
    } catch {
      /* ignore — the URL is also shown for manual opening */
    }
  }, [prompt.url]);

  const copyCode = useCallback(async () => {
    if (!prompt.code) return;
    await Clipboard.setStringAsync(prompt.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [prompt.code]);

  const submitCode = useCallback(() => {
    const value = codeInput.trim();
    if (!value || !streamRef.current) return;
    streamRef.current.send(`${value}\r`);
    setCodeInput('');
    setPhase('submitting');
    // Check right after submitting so success shows promptly.
    poll().catch(() => {});
  }, [codeInput, poll]);

  // ── PAT path ────────────────────────────────────────────────────────────────

  const openTokenPage = useCallback(async () => {
    try {
      await WebBrowser.openBrowserAsync(GITHUB_NEW_TOKEN_URL);
    } catch {
      /* ignore — the URL is spelled out in the instructions */
    }
  }, []);

  const validatePat = useCallback(async () => {
    const token = patToken.trim();
    if (!token) return;
    setPatBusy('validate');
    setPatError(undefined);
    try {
      setPatInfo(await validateGithubPat(token));
    } catch (err: any) {
      setPatInfo(null);
      setPatError(err?.message ?? 'Token validation failed');
    }
    setPatBusy(null);
  }, [patToken]);

  const connectPat = useCallback(async () => {
    const token = patToken.trim();
    if (!token) return;
    setPatBusy('connect');
    setPatError(undefined);
    try {
      const result = await connectGithubWithPat(spriteName, token);
      if (result === 'git-only') {
        setPatNote(
          'Stored for git push/pull. The gh CLI did not accept this token, so `gh pr create` may not work — agents can still push and open PRs via the API.'
        );
      }
      finishSuccess();
    } catch (err: any) {
      setPatError(err?.message ?? 'Failed to store the token on the sprite');
    }
    setPatBusy(null);
  }, [patToken, spriteName, finishSuccess]);

  const handleClose = useCallback(() => {
    if (!settledRef.current) {
      streamRef.current?.cancel();
    }
    stopPolling();
    streamRef.current?.close();
    onClose();
  }, [onClose, stopPolling]);

  const retry = useCallback(() => {
    // Simplest reliable reset: close and let the parent reopen.
    handleClose();
  }, [handleClose]);

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={handleClose} />
      <View style={[styles.sheet, { backgroundColor: colors.card }]}>
        {/* Header */}
        <View style={styles.header}>
          <View style={[styles.badge, { backgroundColor: meta.accent }]}>
            <Text style={styles.badgeText}>{meta.monogram}</Text>
          </View>
          <Text style={[styles.title, { color: colors.text }]}>Connect {meta.label}</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Text style={[styles.close, { color: colors.textSecondary }]}>✕</Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {mode === 'interactive' && phase === 'starting' && (
            <View style={styles.centerBlock}>
              <ActivityIndicator color={colors.tint} />
              <Text style={[styles.muted, { color: colors.textSecondary }]}>
                Starting sign-in on {spriteName}…
              </Text>
            </View>
          )}

          {phase === 'success' && (
            <View style={styles.centerBlock}>
              <View style={[styles.successCircle, { backgroundColor: colors.success }]}>
                <Text style={styles.successCheck}>✓</Text>
              </View>
              <Text style={[styles.successText, { color: colors.text }]}>Connected!</Text>
              {patNote && (
                <Text style={[styles.muted, { color: colors.textSecondary, textAlign: 'center' }]}>
                  {patNote}
                </Text>
              )}
            </View>
          )}

          {/* GitHub: choose between the CLI web login and a pasted token */}
          {phase !== 'success' && mode === 'method' && (
            <>
              <Text style={[styles.muted, { color: colors.textSecondary }]}>
                How do you want to connect GitHub on this sprite?
              </Text>
              <Pressable
                style={[styles.methodCard, { borderColor: colors.border }]}
                onPress={() => setMode('interactive')}
              >
                <Text style={[styles.methodTitle, { color: colors.text }]}>
                  Sign in with browser
                </Text>
                <Text style={[styles.methodBlurb, { color: colors.textSecondary }]}>
                  GitHub CLI web login. Fastest — but the sprite gets access to all your
                  repositories.
                </Text>
              </Pressable>
              <Pressable
                style={[styles.methodCard, { borderColor: colors.border }]}
                onPress={() => setMode('pat')}
              >
                <Text style={[styles.methodTitle, { color: colors.text }]}>
                  Paste an access token
                </Text>
                <Text style={[styles.methodBlurb, { color: colors.textSecondary }]}>
                  Fine-grained token you create on github.com — the sprite only reaches the
                  repositories you pick.
                </Text>
              </Pressable>
            </>
          )}

          {/* GitHub: fine-grained PAT flow */}
          {phase !== 'success' && mode === 'pat' && (
            <>
              <Pressable onPress={() => setMode('method')} hitSlop={8}>
                <Text style={[styles.backLink, { color: colors.tint }]}>‹ Other methods</Text>
              </Pressable>

              <View style={styles.section}>
                <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                  1 · Create a fine-grained token
                </Text>
                <Text style={[styles.muted, { color: colors.textSecondary }]}>
                  Opens github.com in the browser (the GitHub mobile app can’t create tokens).
                  Under “Repository access” choose “Only select repositories” and pick your
                  repo(s). Under “Repository permissions” set Contents and Pull requests to
                  “Read and write” — enough to create branches, push, and open PRs.
                </Text>
                <Pressable
                  style={[styles.primaryButton, { backgroundColor: colors.tint }]}
                  onPress={openTokenPage}
                >
                  <Text style={styles.primaryButtonText}>Open GitHub token page ↗</Text>
                </Pressable>
              </View>

              <View style={styles.section}>
                <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                  2 · Paste the token
                </Text>
                <TextInput
                  style={[
                    styles.input,
                    {
                      color: colors.text,
                      backgroundColor: colors.inputBackground,
                      borderColor: colors.border,
                    },
                  ]}
                  value={patToken}
                  onChangeText={(t) => {
                    setPatToken(t);
                    setPatInfo(null);
                    setPatError(undefined);
                  }}
                  placeholder="github_pat_…"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={validatePat}
                />
                {!patInfo && (
                  <Pressable
                    style={[
                      styles.primaryButton,
                      {
                        backgroundColor: patToken.trim() ? colors.tint : colors.backgroundElement,
                        marginTop: Spacing.sm,
                      },
                    ]}
                    disabled={!patToken.trim() || patBusy !== null}
                    onPress={validatePat}
                  >
                    {patBusy === 'validate' ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Check token</Text>
                    )}
                  </Pressable>
                )}
              </View>

              {patInfo && (
                <View
                  style={[
                    styles.patReview,
                    { borderColor: colors.border, backgroundColor: colors.backgroundElement },
                  ]}
                >
                  <Text style={[styles.methodTitle, { color: colors.text }]}>
                    @{patInfo.login} · {patInfo.tokenType} token
                  </Text>
                  {patInfo.allRepos ? (
                    <Text style={[styles.warnText, { color: colors.warning }]}>
                      This token type grants access to every repository on the account. For a
                      tighter scope, create a fine-grained token instead.
                    </Text>
                  ) : (
                    <>
                      <Text style={[styles.muted, { color: colors.textSecondary }]}>
                        The sprite will only reach{' '}
                        {patInfo.repos.length === 1
                          ? 'this repository'
                          : `these ${patInfo.repos.length} repositories`}
                        :
                      </Text>
                      {patInfo.repos.slice(0, 20).map((r) => (
                        <Text key={r} style={[styles.repoLine, { color: colors.text }]}>
                          {r}
                        </Text>
                      ))}
                      {patInfo.repos.length > 20 && (
                        <Text style={[styles.muted, { color: colors.textSecondary }]}>
                          …and {patInfo.repos.length - 20} more
                        </Text>
                      )}
                      {patInfo.repos.length === 0 && (
                        <Text style={[styles.warnText, { color: colors.warning }]}>
                          No repositories are selected for this token — pick at least one on
                          the GitHub token page.
                        </Text>
                      )}
                    </>
                  )}
                  <Pressable
                    style={[
                      styles.primaryButton,
                      { backgroundColor: colors.tint, marginTop: Spacing.sm },
                    ]}
                    disabled={patBusy !== null}
                    onPress={connectPat}
                  >
                    {patBusy === 'connect' ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Connect to {spriteName}</Text>
                    )}
                  </Pressable>
                </View>
              )}

              {patError && (
                <Text style={[styles.errorText, { color: colors.destructive }]}>{patError}</Text>
              )}
            </>
          )}

          {phase === 'error' && (
            <View style={styles.centerBlock}>
              <Text style={[styles.errorText, { color: colors.destructive }]}>
                {error ?? 'Something went wrong.'}
              </Text>
              <Pressable
                style={[styles.primaryButton, { backgroundColor: colors.tint }]}
                onPress={retry}
              >
                <Text style={styles.primaryButtonText}>Close &amp; try again</Text>
              </Pressable>
            </View>
          )}

          {(phase === 'awaiting' || phase === 'submitting') && (
            <>
              {/* Step 1: code (codex / github) */}
              {prompt.code && (
                <View style={styles.section}>
                  <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                    1 · Your one-time code
                  </Text>
                  <Pressable
                    onPress={copyCode}
                    style={[
                      styles.codeBox,
                      { backgroundColor: colors.backgroundElement, borderColor: colors.border },
                    ]}
                  >
                    <Text style={[styles.codeText, { color: colors.text }]}>{prompt.code}</Text>
                    <Text style={[styles.copyHint, { color: colors.tint }]}>
                      {copied ? 'Copied' : 'Tap to copy'}
                    </Text>
                  </Pressable>
                </View>
              )}

              {/* Step 2: open browser */}
              <View style={styles.section}>
                <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                  {prompt.code ? '2 · Open the sign-in page' : '1 · Open the sign-in page'}
                </Text>
                <Pressable
                  style={[
                    styles.primaryButton,
                    { backgroundColor: prompt.url ? colors.tint : colors.backgroundElement },
                  ]}
                  disabled={!prompt.url}
                  onPress={openBrowser}
                >
                  {prompt.url ? (
                    <Text style={styles.primaryButtonText}>Open sign-in page ↗</Text>
                  ) : (
                    <View style={styles.inlineRow}>
                      <ActivityIndicator size="small" color={colors.textSecondary} />
                      <Text style={[styles.muted, { color: colors.textSecondary }]}>
                        Preparing link…
                      </Text>
                    </View>
                  )}
                </Pressable>
              </View>

              {/* Step 3: paste code back (claude only) */}
              {meta.needsCodePaste && (
                <View style={styles.section}>
                  <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                    {prompt.code ? '3' : '2'} · Paste the code from the browser
                  </Text>
                  <TextInput
                    style={[
                      styles.input,
                      {
                        color: colors.text,
                        backgroundColor: colors.inputBackground,
                        borderColor: colors.border,
                      },
                    ]}
                    value={codeInput}
                    onChangeText={setCodeInput}
                    placeholder="Paste code here"
                    placeholderTextColor={colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onSubmitEditing={submitCode}
                    editable={phase === 'awaiting'}
                  />
                  <Pressable
                    style={[
                      styles.primaryButton,
                      {
                        backgroundColor: codeInput.trim() ? colors.tint : colors.backgroundElement,
                        marginTop: Spacing.sm,
                      },
                    ]}
                    disabled={!codeInput.trim() || phase === 'submitting'}
                    onPress={submitCode}
                  >
                    <Text style={styles.primaryButtonText}>Submit code</Text>
                  </Pressable>
                </View>
              )}

              {/* Waiting status */}
              <View style={styles.waitingRow}>
                <ActivityIndicator size="small" color={colors.tint} />
                <Text style={[styles.muted, { color: colors.textSecondary }]}>
                  {phase === 'submitting' ? 'Verifying…' : meta.waitingHint}
                </Text>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  backdrop: { flex: 1 },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.lg,
    paddingBottom: 40,
    maxHeight: '85%',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.lg },
  badge: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
  title: { flex: 1, fontSize: FontSize.xl, fontWeight: '700' },
  close: { fontSize: FontSize.lg, fontWeight: '600' },
  body: { gap: Spacing.lg },
  section: { gap: Spacing.sm },
  stepLabel: { fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.5 },
  codeBox: {
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  codeText: {
    fontSize: FontSize.xxl,
    fontWeight: '700',
    letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  copyHint: { fontSize: FontSize.xs, fontWeight: '600' },
  primaryButton: {
    borderRadius: 10,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  primaryButtonText: { color: '#fff', fontSize: FontSize.md, fontWeight: '600' },
  input: {
    fontSize: FontSize.md,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  methodCard: { borderRadius: 12, borderWidth: 1, padding: Spacing.lg, gap: Spacing.xs },
  methodTitle: { fontSize: FontSize.md, fontWeight: '600' },
  methodBlurb: { fontSize: FontSize.sm, lineHeight: 19 },
  backLink: { fontSize: FontSize.sm, fontWeight: '600' },
  patReview: { borderRadius: 12, borderWidth: 1, padding: Spacing.lg, gap: Spacing.sm },
  repoLine: {
    fontSize: FontSize.sm,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  warnText: { fontSize: FontSize.sm, lineHeight: 19 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingTop: Spacing.xs },
  muted: { fontSize: FontSize.sm, flexShrink: 1 },
  centerBlock: { alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.xxl },
  successCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  successCheck: { color: '#fff', fontSize: 30, fontWeight: '700' },
  successText: { fontSize: FontSize.lg, fontWeight: '600' },
  errorText: { fontSize: FontSize.md, textAlign: 'center', lineHeight: 22 },
});
