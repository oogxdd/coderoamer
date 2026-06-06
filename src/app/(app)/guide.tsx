import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

/** A monospace code line / block. */
function Code({ children }: { children: string }) {
  const colors = useTheme();
  return (
    <Text
      selectable
      style={[
        styles.code,
        { backgroundColor: colors.backgroundElement, color: colors.text, borderColor: colors.border },
      ]}
    >
      {children}
    </Text>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>{title}</Text>
      {children}
    </View>
  );
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

export default function GuideScreen() {
  const colors = useTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={[styles.back, { color: colors.tint }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Guides</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>
          Run Claude Code inside a Fly.io Sprite (a cloud VM) and drive it from your phone. Set
          things up once on your computer, then code from anywhere.
        </Text>

        <Section title="Recommended workflow">
          <Step n={1}>
            <P>
              Create a sprite — tap <Text style={styles.b}>+</Text> on the dashboard, or use the
              Sprites CLI on your computer.
            </P>
          </Step>
          <Step n={2}>
            <P>Open a terminal in the sprite and generate an SSH key:</P>
            <Code>ssh-keygen -t ed25519 -C &quot;you@example.com&quot;</Code>
            <P>Print the public key and add it to GitHub → Settings → SSH and GPG keys:</P>
            <Code>cat ~/.ssh/id_ed25519.pub</Code>
          </Step>
          <Step n={3}>
            <P>Clone your repo into the sprite:</P>
            <Code>git clone git@github.com:you/your-repo.git ~/your-repo</Code>
          </Step>
          <Step n={4}>
            <P>
              In the app, open the sprite, set the session{' '}
              <Text style={styles.b}>working directory</Text> to that folder (e.g.{' '}
              <Text style={styles.mono}>/home/sprite/your-repo</Text>), then send a prompt. Claude
              starts working — no approvals needed.
            </P>
          </Step>
          <Step n={5}>
            <P>
              Close the app whenever. Reopen it and you land back in the same session — send another
              message to continue the conversation.
            </P>
          </Step>
        </Section>

        <Section title="Tokens you'll need">
          <P>
            <Text style={styles.b}>Sprites API token</Text> — from your sprites.dev account or the
            Sprites CLI. Lets the app manage your sprites.
          </P>
          <P>
            <Text style={styles.b}>Claude Code token</Text> — run this on your computer (needs a
            Claude subscription) and paste the <Text style={styles.mono}>sk-ant-oat01-…</Text> value:
          </P>
          <Code>claude setup-token</Code>
          <P>
            The app injects it as <Text style={styles.mono}>CLAUDE_CODE_OAUTH_TOKEN</Text> when it
            launches Claude in the sprite, so you don&apos;t have to log in there.
          </P>
          <P>
            <Text style={styles.b}>GitHub</Text> (optional) — connect via device flow to auto-fill
            your git commit name/email.
          </P>
        </Section>

        <Section title="Three ways to connect">
          <P>
            <Text style={styles.b}>Chat</Text> (default) — a native chat UI. The app runs Claude
            non-interactively and streams the result, rendering tool use, plans, and results as
            cards. Best for day-to-day prompting and reading results on a phone.
          </P>
          <P>
            <Text style={styles.b}>Interactive Terminal</Text> — a real terminal (TTY) over a
            WebSocket. Auto-runs <Text style={styles.mono}>cd &lt;repo&gt; &amp;&amp; claude</Text>.
            Best when you want to answer Claude&apos;s interactive prompts or watch the live TUI.
          </P>
          <P>
            <Text style={styles.b}>Web Terminal (ttyd)</Text> — embeds a{' '}
            <Text style={styles.mono}>ttyd</Text> web terminal running inside the sprite.
            &quot;Start ttyd in this sprite&quot; opens the sprite URL (auth: public), runs ttyd on
            port 8080 (the public URL proxies to it), and connects. Experimental, and requires{' '}
            <Text style={styles.mono}>ttyd</Text> to be installed in the sprite.
          </P>
          <P>Open the last two from a sprite&apos;s Overview tab → &quot;More ways to connect&quot;.</P>
        </Section>

        <Section title="Resuming a session">
          <P>
            Each chat stores Claude&apos;s session id and the directory it ran in. New messages use{' '}
            <Text style={styles.mono}>--resume</Text> from the same directory, so context carries
            over across app restarts. Because resume is tied to the directory, the working directory
            is locked once a conversation begins — start a new session to use a different folder.
          </P>
        </Section>

        <Section title="No approvals — and safety">
          <P>
            Chat launches Claude with{' '}
            <Text style={styles.mono}>--dangerously-skip-permissions</Text>, so it never pauses to
            ask. That means it can run any command in the sprite. The sprite is an isolated VM, but
            still: use <Text style={styles.b}>Checkpoints</Text> (in the sprite&apos;s tabs) to
            snapshot before risky work and restore if something goes wrong.
          </P>
        </Section>

        <View style={{ height: Spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { fontSize: FontSize.lg, width: 50 },
  headerTitle: { fontSize: FontSize.lg, fontWeight: '600' },
  content: { padding: Spacing.lg },
  intro: { fontSize: FontSize.md, lineHeight: 22, marginBottom: Spacing.lg },
  section: { marginBottom: Spacing.xl },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '700', marginBottom: Spacing.md },
  paragraph: { fontSize: FontSize.sm, lineHeight: 21, marginBottom: Spacing.sm },
  b: { fontWeight: '700' },
  mono: { fontFamily: MONO },
  code: {
    fontFamily: MONO,
    fontSize: FontSize.sm,
    padding: Spacing.md,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginVertical: Spacing.xs,
    overflow: 'hidden',
  },
  step: { flexDirection: 'row', marginBottom: Spacing.md },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Spacing.md,
    marginTop: 1,
  },
  stepNumText: { color: '#fff', fontWeight: '700', fontSize: FontSize.xs },
  stepBody: { flex: 1 },
});
