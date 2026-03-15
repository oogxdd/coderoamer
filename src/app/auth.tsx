import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Linking,
} from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '@/contexts/AuthContext';
import * as api from '@/services/api';
import * as github from '@/services/github';
import { setSetting } from '@/services/storage';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

type AuthStep = 'sprites' | 'claude' | 'github';

export default function AuthScreen() {
  const colors = useTheme();
  const auth = useAuth();
  const [step, setStep] = useState<AuthStep>('sprites');
  const [spritesToken, setSpritesToken] = useState('');
  const [claudeToken, setClaudeToken] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string>();

  // GitHub device flow state
  const [githubUserCode, setGithubUserCode] = useState('');
  const [githubVerificationUrl, setGithubVerificationUrl] = useState('');
  const [isPollingGitHub, setIsPollingGitHub] = useState(false);
  const [githubError, setGithubError] = useState<string>();
  const pollingAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      pollingAbortRef.current?.abort();
    };
  }, []);

  const handleSpritesToken = async () => {
    const trimmed = spritesToken.trim();
    if (!trimmed) {
      setError('Please enter a Sprites API token.');
      return;
    }
    setIsValidating(true);
    setError(undefined);
    try {
      await auth.saveSpritesToken(trimmed);
      await api.validateToken();
      setStep('claude');
    } catch {
      setError('Invalid Sprites token. Please check and try again.');
    }
    setIsValidating(false);
  };

  const handleClaudeToken = async () => {
    const trimmed = claudeToken.trim();
    if (!trimmed) {
      setError('Please enter a Claude Code OAuth token.');
      return;
    }
    setError(undefined);
    try {
      await auth.saveClaudeToken(trimmed);
      setStep('github');
    } catch {
      setError('Failed to save Claude token.');
    }
  };

  const skipClaude = () => {
    setStep('github');
  };

  const startGitHubFlow = async () => {
    setGithubError(undefined);
    setGithubUserCode('');
    try {
      const response = await github.requestDeviceCode();
      setGithubUserCode(response.user_code);
      setGithubVerificationUrl(response.verification_uri);
      setIsPollingGitHub(true);

      const abortController = new AbortController();
      pollingAbortRef.current = abortController;

      const token = await github.pollForToken(
        response.device_code,
        response.expires_in,
        response.interval,
        abortController.signal
      );

      await auth.saveGitHubToken(token);
      setIsPollingGitHub(false);

      // Auto-populate git identity
      const profile = await github.fetchUserProfile();
      if (profile) {
        const name = profile.name ?? profile.login;
        await setSetting('gitName', name);
        let email = profile.email;
        if (!email) {
          email = (await github.fetchPrimaryEmail()) ?? undefined;
        }
        if (email) {
          await setSetting('gitEmail', email);
        }
      }

      await auth.refreshAuth();
      router.replace('/(app)');
    } catch (err: any) {
      setIsPollingGitHub(false);
      if (err.message !== 'Cancelled') {
        setGithubError(err.message ?? 'GitHub authentication failed');
      }
    }
  };

  const copyCodeAndOpen = async () => {
    await Clipboard.setStringAsync(githubUserCode);
    if (githubVerificationUrl) {
      Linking.openURL(githubVerificationUrl);
    }
  };

  const skipGitHub = () => {
    pollingAbortRef.current?.abort();
    pollingAbortRef.current = null;
    setIsPollingGitHub(false);
    auth.refreshAuth();
    router.replace('/(app)');
  };

  const stepNumber = step === 'sprites' ? 1 : step === 'claude' ? 2 : 3;

  const steps = [
    { num: 1, label: 'Sprites' },
    { num: 2, label: 'Claude' },
    { num: 3, label: 'GitHub' },
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.content}>
            <Text style={[styles.title, { color: colors.text }]}>Sign In</Text>

            {/* Step Indicator */}
            <View style={styles.stepRow}>
              {steps.map((s) => (
                <View key={s.num} style={styles.stepItem}>
                  <View
                    style={[
                      styles.stepDot,
                      {
                        backgroundColor:
                          s.num < stepNumber
                            ? colors.success
                            : s.num === stepNumber
                              ? colors.tint
                              : colors.backgroundElement,
                      },
                    ]}
                  >
                    <Text style={styles.stepDotText}>
                      {s.num < stepNumber ? '✓' : s.num}
                    </Text>
                  </View>
                  <Text style={[styles.stepLabel, { color: colors.textSecondary }]}>
                    {s.label}
                  </Text>
                </View>
              ))}
            </View>

            {/* Step Content */}
            <View style={[styles.card, { backgroundColor: colors.card }]}>
              {step === 'sprites' && (
                <>
                  <Text style={[styles.sectionTitle, { color: colors.text }]}>
                    Sprites API Token
                  </Text>
                  <Text style={[styles.description, { color: colors.textSecondary }]}>
                    Get your token from sprites.dev/account or the Sprites CLI.
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
                    placeholder="Paste your Sprites API token"
                    placeholderTextColor={colors.textSecondary}
                    value={spritesToken}
                    onChangeText={setSpritesToken}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                    editable={!isValidating}
                  />
                  <Pressable
                    style={[
                      styles.primaryButton,
                      { backgroundColor: colors.tint, opacity: isValidating ? 0.7 : 1 },
                    ]}
                    onPress={handleSpritesToken}
                    disabled={isValidating}
                  >
                    {isValidating ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Continue</Text>
                    )}
                  </Pressable>
                </>
              )}

              {step === 'claude' && (
                <>
                  <Text style={[styles.sectionTitle, { color: colors.text }]}>
                    Claude Code OAuth Token
                  </Text>
                  <Text style={[styles.description, { color: colors.textSecondary }]}>
                    Run `claude setup-token` in your terminal to get an OAuth token
                    (starts with sk-ant-oat01-).
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
                    placeholder="sk-ant-oat01-..."
                    placeholderTextColor={colors.textSecondary}
                    value={claudeToken}
                    onChangeText={setClaudeToken}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry
                  />
                  <Pressable
                    style={[styles.primaryButton, { backgroundColor: colors.tint }]}
                    onPress={handleClaudeToken}
                  >
                    <Text style={styles.primaryButtonText}>Continue</Text>
                  </Pressable>
                  <Pressable style={styles.skipButton} onPress={skipClaude}>
                    <Text style={[styles.skipText, { color: colors.tint }]}>
                      Skip for now
                    </Text>
                  </Pressable>
                </>
              )}

              {step === 'github' && (
                <>
                  <Text style={[styles.sectionTitle, { color: colors.text }]}>
                    GitHub (Optional)
                  </Text>
                  <Text style={[styles.description, { color: colors.textSecondary }]}>
                    Connect GitHub to clone repos and set up git identity.
                  </Text>

                  {!githubUserCode && !isPollingGitHub && (
                    <Pressable
                      style={[styles.primaryButton, { backgroundColor: '#24292e' }]}
                      onPress={startGitHubFlow}
                    >
                      <Text style={styles.primaryButtonText}>Connect GitHub</Text>
                    </Pressable>
                  )}

                  {githubUserCode && (
                    <View style={styles.deviceCodeSection}>
                      <Text style={[styles.codeLabel, { color: colors.textSecondary }]}>
                        Enter this code on GitHub:
                      </Text>
                      <Text style={[styles.deviceCode, { color: colors.text }]}>
                        {githubUserCode}
                      </Text>
                      <Pressable
                        style={[styles.primaryButton, { backgroundColor: '#24292e' }]}
                        onPress={copyCodeAndOpen}
                      >
                        <Text style={styles.primaryButtonText}>
                          Copy Code & Open GitHub
                        </Text>
                      </Pressable>
                      {isPollingGitHub && (
                        <View style={styles.pollingRow}>
                          <ActivityIndicator size="small" color={colors.tint} />
                          <Text style={[styles.pollingText, { color: colors.textSecondary }]}>
                            Waiting for authorization...
                          </Text>
                        </View>
                      )}
                    </View>
                  )}

                  {githubError && (
                    <Text style={[styles.githubError, { color: colors.destructive }]}>
                      {githubError}
                    </Text>
                  )}

                  <Pressable
                    style={[styles.skipButton, { marginTop: Spacing.lg }]}
                    onPress={skipGitHub}
                  >
                    <Text style={[styles.skipText, { color: colors.tint }]}>
                      Skip for now
                    </Text>
                  </Pressable>
                </>
              )}
            </View>

            {error && (
              <View style={[styles.errorCard, { backgroundColor: colors.destructive + '15' }]}>
                <Text style={[styles.errorText, { color: colors.destructive }]}>
                  {error}
                </Text>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: Spacing.xl,
    maxWidth: 500,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: FontSize.title,
    fontWeight: '700',
    marginBottom: Spacing.xl,
    textAlign: 'center',
  },
  stepRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.xxl,
    marginBottom: Spacing.xl,
  },
  stepItem: {
    alignItems: 'center',
    gap: Spacing.xs,
  },
  stepDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: FontSize.sm,
  },
  stepLabel: {
    fontSize: FontSize.xs,
  },
  card: {
    borderRadius: 12,
    padding: Spacing.xl,
  },
  sectionTitle: {
    fontSize: FontSize.lg,
    fontWeight: '600',
    marginBottom: Spacing.sm,
  },
  description: {
    fontSize: FontSize.sm,
    marginBottom: Spacing.lg,
    lineHeight: 20,
  },
  input: {
    fontSize: FontSize.md,
    padding: Spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: Spacing.lg,
  },
  primaryButton: {
    paddingVertical: Spacing.md,
    borderRadius: 10,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  skipButton: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
    marginTop: Spacing.sm,
  },
  skipText: {
    fontSize: FontSize.md,
    fontWeight: '500',
  },
  errorCard: {
    marginTop: Spacing.lg,
    padding: Spacing.md,
    borderRadius: 10,
  },
  errorText: {
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  deviceCodeSection: {
    alignItems: 'center',
    gap: Spacing.md,
  },
  codeLabel: {
    fontSize: FontSize.sm,
  },
  deviceCode: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 4,
    paddingVertical: Spacing.sm,
  },
  pollingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  pollingText: {
    fontSize: FontSize.sm,
  },
  githubError: {
    fontSize: FontSize.sm,
    marginTop: Spacing.sm,
    textAlign: 'center',
  },
});
