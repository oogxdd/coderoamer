import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

export const SPRITES_ACCOUNT_URL = 'https://sprites.dev/account';

interface SpritesTokenHelpSheetProps {
  onClose: () => void;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  const colors = useTheme();
  return (
    <View style={styles.step}>
      <View style={[styles.stepNum, { backgroundColor: colors.tint }]}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <View style={styles.stepBody}>{children}</View>
    </View>
  );
}

function P({ children }: { children: React.ReactNode }) {
  const colors = useTheme();
  return <Text style={[styles.paragraph, { color: colors.textSecondary }]}>{children}</Text>;
}

function Code({ children }: { children: string }) {
  const colors = useTheme();
  return (
    <Text
      selectable
      style={[
        styles.code,
        {
          backgroundColor: colors.backgroundElement,
          color: colors.text,
          borderColor: colors.border,
        },
      ]}
    >
      {children}
    </Text>
  );
}

/**
 * Instructions for obtaining a Sprites API token.
 *
 * Sprites authenticates with a Fly.io account, and the only credential a
 * third-party app can use is a bearer token — there is no public OAuth or
 * device-code flow to delegate sign-in to, so the token has to be pasted.
 * This sheet makes that path short instead of leaving the user guessing.
 */
export function SpritesTokenHelpSheet({ onClose }: SpritesTokenHelpSheetProps) {
  const colors = useTheme();
  const [copied, setCopied] = useState(false);

  const openAccount = async () => {
    try {
      await WebBrowser.openBrowserAsync(SPRITES_ACCOUNT_URL);
    } catch {
      /* ignore — the URL is also shown for manual opening */
    }
  };

  const copyLink = async () => {
    await Clipboard.setStringAsync(SPRITES_ACCOUNT_URL);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <View style={styles.overlay}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.card }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>Get a Sprites API token</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={[styles.close, { color: colors.tint }]}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <P>
            Sprites signs in with your <Text style={styles.b}>Fly.io</Text> account. There is no
            OAuth or device-code sign-in for third-party apps yet, so a pasted API token is the
            only way to connect. It takes about a minute.
          </P>

          <Step n={1}>
            <P>
              Open <Text style={styles.mono}>sprites.dev/account</Text> and sign in with Fly.io.
            </P>
            <View style={styles.linkRow}>
              <Pressable
                style={[styles.linkButton, { backgroundColor: colors.tint }]}
                onPress={openAccount}
              >
                <Text style={styles.linkButtonText}>Open sprites.dev/account</Text>
              </Pressable>
              <Pressable
                style={[styles.copyButton, { borderColor: colors.border }]}
                onPress={copyLink}
              >
                <Text style={[styles.copyButtonText, { color: colors.textSecondary }]}>
                  {copied ? 'Copied' : 'Copy link'}
                </Text>
              </Pressable>
            </View>
          </Step>

          <Step n={2}>
            <P>
              Pick the organization the sprites should live in — the token page is per-org
              (<Text style={styles.mono}>sprites.dev/account/&lt;your-org&gt;</Text>).
            </P>
          </Step>

          <Step n={3}>
            <P>Create a token there and copy the value it shows you.</P>
          </Step>

          <Step n={4}>
            <P>
              Paste it on the previous screen and tap <Text style={styles.b}>Continue</Text>. The
              app verifies it against the Sprites API right away.
            </P>
          </Step>

          <Text style={[styles.sectionTitle, { color: colors.text }]}>Prefer the CLI?</Text>
          <P>Install the Sprites CLI on your computer, then authenticate through the browser:</P>
          <Code>sprite login</Code>
          <P>Show the orgs and tokens the CLI has configured:</P>
          <Code>sprite org list</Code>
          <P>
            The CLI keeps the token in your keyring. To read the value out of it, disable keyring
            storage and open the config file:
          </P>
          <Code>{'sprite org keyring disable\ncat ~/.sprites/sprites.json'}</Code>

          <Text style={[styles.sectionTitle, { color: colors.text }]}>Where the token goes</Text>
          <P>
            It is stored on this device only (
            {Platform.OS === 'web' ? 'browser storage' : 'the device keychain'}) and sent as an{' '}
            <Text style={styles.mono}>Authorization: Bearer</Text> header to{' '}
            <Text style={styles.mono}>api.sprites.dev</Text>. Revoke it any time from the same
            account page.
          </P>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  backdrop: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: Spacing.lg,
    paddingHorizontal: Spacing.xl,
    paddingBottom: 40,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.md,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '700',
    flexShrink: 1,
  },
  close: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  content: {
    paddingBottom: Spacing.lg,
  },
  paragraph: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    marginBottom: Spacing.sm,
  },
  sectionTitle: {
    fontSize: FontSize.md,
    fontWeight: '700',
    marginTop: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  step: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNumText: {
    color: '#fff',
    fontSize: FontSize.xs,
    fontWeight: '700',
  },
  stepBody: {
    flex: 1,
  },
  linkRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  linkButton: {
    flex: 1,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  linkButtonText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  copyButton: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  copyButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  code: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: FontSize.xs,
    lineHeight: 18,
    padding: Spacing.md,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: Spacing.sm,
  },
  b: {
    fontWeight: '700',
  },
  mono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});
