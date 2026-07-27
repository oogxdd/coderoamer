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
  getAccountSignatures,
  startLogin,
  LoginStream,
  LoginPrompt,
  stripAnsi,
  GithubAccessSummary,
  inspectGithubPat,
  connectGithubWithPat,
} from '@/services/account-auth';

type Phase = 'starting' | 'awaiting' | 'submitting' | 'success' | 'error';
type Mode = 'method' | 'interactive' | 'pat';

const GITHUB_TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?' +
  new URLSearchParams({
    name: 'CodeRoamer Sprite',
    description: 'Repository access for one CodeRoamer Sprite',
    expires_in: '30',
    contents: 'write',
    pull_requests: 'write',
  }).toString();

interface ConnectAccountSheetProps {
  spriteName: string;
  provider: ProviderId;
  onClose: () => void;
  onConnected: (provider: ProviderId) => void;
}

const POLL_INTERVAL_MS = 2500;

function loginErrorMessage(provider: ProviderId, raw: string, exitCode: number): string {
  const label = providerMeta(provider).label;
  const cleaned = stripAnsi(raw)
    .replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
  const detail = cleaned.split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join('\n');
  return detail || `${label} sign-in exited with code ${exitCode}.`;
}

function codexOutputPreview(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join('\n');
}

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
  const [outputPreview, setOutputPreview] = useState('');
  const [patToken, setPatToken] = useState('');
  const [patSummary, setPatSummary] = useState<GithubAccessSummary>();
  const [patBusy, setPatBusy] = useState<'inspect' | 'connect'>();
  const [patError, setPatError] = useState<string>();

  const streamRef = useRef<LoginStream | null>(null);
  const bufferRef = useRef('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settledRef = useRef(false);
  const continuedGithubRef = useRef(false);
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

  // Drive the login: capture the baseline, open the stream, parse prompts, and
  // poll the credential signature for a fresh login.
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
            if (provider === 'codex') {
              setOutputPreview(codexOutputPreview(bufferRef.current));
            }
            const next = parseLoginPrompt(provider, bufferRef.current);
            setPrompt((prev) => ({
              url: next.url ?? prev.url,
              code: next.code ?? prev.code,
            }));
            if (next.url || next.code) {
              setPhase((p) => (p === 'starting' ? 'awaiting' : p));
            }
            // Recent gh versions wait for Enter before polling the device flow.
            // The phone opens the URL, so suppress the sprite browser and
            // continue the CLI automatically as soon as its code is available.
            if (provider === 'github' && next.code && !continuedGithubRef.current) {
              continuedGithubRef.current = true;
              streamRef.current?.send('\r');
            }
          },
          onExit: (code) => {
            // The CLI finished — confirm against the credential files.
            if (cancelled) return;
            if (code !== 0) {
              stopPolling();
              setError(loginErrorMessage(provider, bufferRef.current, code));
              setPhase('error');
              return;
            }
            poll()
              .catch(() => {})
              .finally(() => {
                setTimeout(() => {
                  if (cancelled || settledRef.current) return;
                  stopPolling();
                  setError(
                    `${meta.label} finished sign-in, but its credentials could not be detected on the sprite.`
                  );
                  setPhase('error');
                }, 1500);
              });
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

  const openGithubTokenPage = useCallback(async () => {
    try {
      await WebBrowser.openBrowserAsync(GITHUB_TOKEN_URL);
    } catch {
      /* The instructions still identify the GitHub settings page. */
    }
  }, []);

  const pasteGithubToken = useCallback(async () => {
    const value = (await Clipboard.getStringAsync()).trim();
    if (!value) return;
    setPatToken(value);
    setPatSummary(undefined);
    setPatError(undefined);
  }, []);

  const inspectPat = useCallback(async () => {
    const token = patToken.trim();
    if (!token) return;
    setPatBusy('inspect');
    setPatError(undefined);
    setPatSummary(undefined);
    try {
      setPatSummary(await inspectGithubPat(spriteName, token));
    } catch (err: any) {
      setPatError(err?.message ?? 'Could not validate this token.');
    } finally {
      setPatBusy(undefined);
    }
  }, [patToken, spriteName]);

  const connectPat = useCallback(async () => {
    const token = patToken.trim();
    if (!token || !patSummary) return;
    setPatBusy('connect');
    setPatError(undefined);
    try {
      await connectGithubWithPat(spriteName, token);
      finishSuccess();
    } catch (err: any) {
      setPatError(err?.message ?? 'Could not install this token on the sprite.');
    } finally {
      setPatBusy(undefined);
    }
  }, [finishSuccess, patSummary, patToken, spriteName]);

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
              {provider === 'codex' && outputPreview && (
                <View
                  style={[
                    styles.outputBox,
                    { backgroundColor: colors.backgroundElement, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.outputLabel, { color: colors.textSecondary }]}>
                    CODEX CLI OUTPUT
                  </Text>
                  <Text style={[styles.outputText, { color: colors.text }]} selectable>
                    {outputPreview}
                  </Text>
                </View>
              )}
            </View>
          )}

          {phase === 'success' && (
            <View style={styles.centerBlock}>
              <View style={[styles.successCircle, { backgroundColor: colors.success }]}>
                <Text style={styles.successCheck}>✓</Text>
              </View>
              <Text style={[styles.successText, { color: colors.text }]}>Connected!</Text>
            </View>
          )}

          {phase !== 'success' && mode === 'method' && (
            <>
              <Text style={[styles.muted, { color: colors.textSecondary }]}>
                Choose how much GitHub access this sprite should receive.
              </Text>
              <Pressable
                style={[styles.methodCard, { borderColor: colors.border }]}
                onPress={() => setMode('interactive')}
              >
                <View style={styles.methodTitleRow}>
                  <Text style={[styles.methodTitle, { color: colors.text }]}>
                    GitHub CLI login
                  </Text>
                  <Text style={[styles.recommended, { color: colors.tint }]}>QUICKEST</Text>
                </View>
                <Text style={[styles.methodBlurb, { color: colors.textSecondary }]}>
                  Open GitHub on this phone, enter a one-time code, and grant the standard gh
                  scopes. Convenient, but broad: private repositories are account-wide.
                </Text>
              </Pressable>
              <Pressable
                style={[styles.methodCard, { borderColor: colors.border }]}
                onPress={() => setMode('pat')}
              >
                <View style={styles.methodTitleRow}>
                  <Text style={[styles.methodTitle, { color: colors.text }]}>
                    Fine-grained token
                  </Text>
                  <Text style={[styles.recommended, { color: colors.success }]}>LEAST ACCESS</Text>
                </View>
                <Text style={[styles.methodBlurb, { color: colors.textSecondary }]}>
                  Create a token on github.com, choose one or a few repositories, then paste it
                  here. CodeRoamer shows exactly which repositories the token can see before
                  installing it.
                </Text>
              </Pressable>
            </>
          )}

          {phase !== 'success' && mode === 'pat' && (
            <>
              <Pressable onPress={() => setMode('method')} hitSlop={8}>
                <Text style={[styles.backLink, { color: colors.tint }]}>‹ Other methods</Text>
              </Pressable>

              <View style={styles.section}>
                <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                  1 · Create on the GitHub website
                </Text>
                <Text style={[styles.muted, { color: colors.textSecondary }]}>
                  Token creation is available on github.com, not in the GitHub mobile app. The
                  button pre-fills a 30-day token and the required permissions.
                </Text>
                <View
                  style={[
                    styles.permissionBox,
                    { backgroundColor: colors.backgroundElement, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.permissionLine, { color: colors.text }]}>
                    Repository access · Only select repositories
                  </Text>
                  <Text style={[styles.permissionLine, { color: colors.text }]}>
                    Contents · Read and write
                  </Text>
                  <Text style={[styles.permissionLine, { color: colors.text }]}>
                    Pull requests · Read and write
                  </Text>
                  <Text style={[styles.permissionHint, { color: colors.textSecondary }]}>
                    Metadata read access is added automatically. Add Workflows only if agents
                    must edit files under .github/workflows.
                  </Text>
                </View>
                <Pressable
                  style={[styles.primaryButton, { backgroundColor: colors.tint }]}
                  onPress={openGithubTokenPage}
                >
                  <Text style={styles.primaryButtonText}>Open GitHub token page ↗</Text>
                </Pressable>
              </View>

              <View style={styles.section}>
                <View style={styles.patLabelRow}>
                  <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                    2 · Paste and review
                  </Text>
                  <Pressable onPress={pasteGithubToken} hitSlop={8}>
                    <Text style={[styles.pasteLink, { color: colors.tint }]}>Paste</Text>
                  </Pressable>
                </View>
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
                  onChangeText={(value) => {
                    setPatToken(value);
                    setPatSummary(undefined);
                    setPatError(undefined);
                  }}
                  placeholder="github_pat_…"
                  placeholderTextColor={colors.textSecondary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  editable={!patBusy}
                  onSubmitEditing={inspectPat}
                />
                <Pressable
                  style={[
                    styles.primaryButton,
                    {
                      backgroundColor: patToken.trim()
                        ? colors.tint
                        : colors.backgroundElement,
                    },
                  ]}
                  disabled={!patToken.trim() || !!patBusy}
                  onPress={inspectPat}
                >
                  {patBusy === 'inspect' ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Review token access</Text>
                  )}
                </Pressable>
              </View>

              {patSummary && (
                <View
                  style={[
                    styles.accessReview,
                    { backgroundColor: colors.backgroundElement, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.methodTitle, { color: colors.text }]}>
                    @{patSummary.login ?? 'unknown'} · {patSummary.tokenType}
                  </Text>
                  {patSummary.allRepos ? (
                    <Text style={[styles.warningText, { color: colors.warning }]}>
                      This is a broad token. It is not limited to selected repositories; create
                      a fine-grained token for least access.
                    </Text>
                  ) : (
                    <>
                      <Text style={[styles.muted, { color: colors.textSecondary }]}>
                        Repositories visible to this token ({patSummary.repoCount}):
                      </Text>
                      {patSummary.repos.slice(0, 20).map((repo) => (
                        <Text key={repo} style={[styles.repoLine, { color: colors.text }]}>
                          {repo}
                        </Text>
                      ))}
                      {patSummary.repoCount > 20 && (
                        <Text style={[styles.muted, { color: colors.textSecondary }]}>
                          …and {patSummary.repoCount - 20} more
                        </Text>
                      )}
                      {patSummary.repoCount === 0 && (
                        <Text style={[styles.warningText, { color: colors.warning }]}>
                          GitHub returned no repositories. Edit the token and select at least one
                          repository before connecting.
                        </Text>
                      )}
                    </>
                  )}
                  <Pressable
                    style={[
                      styles.primaryButton,
                      { backgroundColor: colors.tint, marginTop: Spacing.sm },
                    ]}
                    disabled={!!patBusy || patSummary.repoCount === 0}
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

          {mode === 'interactive' && phase === 'error' && (
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

          {mode === 'interactive' && (phase === 'awaiting' || phase === 'submitting') && (
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

              {provider === 'codex' && !prompt.code && outputPreview && (
                <View
                  style={[
                    styles.outputBox,
                    { backgroundColor: colors.backgroundElement, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.outputLabel, { color: colors.textSecondary }]}>
                    CODEX CLI OUTPUT
                  </Text>
                  <Text style={[styles.outputText, { color: colors.text }]} selectable>
                    {outputPreview}
                  </Text>
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
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingTop: Spacing.xs },
  muted: { fontSize: FontSize.sm, flexShrink: 1 },
  centerBlock: { alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.xxl },
  successCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  successCheck: { color: '#fff', fontSize: 30, fontWeight: '700' },
  successText: { fontSize: FontSize.lg, fontWeight: '600' },
  errorText: { fontSize: FontSize.md, textAlign: 'center', lineHeight: 22 },
  outputBox: {
    alignSelf: 'stretch',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  outputLabel: { fontSize: FontSize.xs, fontWeight: '700', letterSpacing: 0.5 },
  outputText: {
    fontSize: FontSize.sm,
    lineHeight: 19,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  methodCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  methodTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  methodTitle: { fontSize: FontSize.md, fontWeight: '700' },
  methodBlurb: { fontSize: FontSize.sm, lineHeight: 20 },
  recommended: { fontSize: FontSize.xs, fontWeight: '800', letterSpacing: 0.5 },
  backLink: { fontSize: FontSize.sm, fontWeight: '600' },
  permissionBox: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  permissionLine: { fontSize: FontSize.sm, fontWeight: '600', lineHeight: 19 },
  permissionHint: { fontSize: FontSize.xs, lineHeight: 17, marginTop: Spacing.xs },
  patLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pasteLink: { fontSize: FontSize.sm, fontWeight: '700' },
  accessReview: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  warningText: { fontSize: FontSize.sm, lineHeight: 20 },
  repoLine: {
    fontSize: FontSize.xs,
    lineHeight: 18,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
