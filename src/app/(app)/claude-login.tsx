import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { Sprite } from '@/models/sprite';
import * as api from '@/services/api';
import { captureClaudeCreds } from '@/services/provision';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

const STEPS = [
  'Pick a running sprite below.',
  'Open its terminal and run `claude`, then choose to log in.',
  'Open the printed URL, sign in with your Claude subscription, and paste the code back into the terminal.',
  'Come back here and tap “Capture credentials”.',
];

export default function ClaudeLoginScreen() {
  const colors = useTheme();
  const auth = useAuth();

  const [sprites, setSprites] = useState<Sprite[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api.listSprites();
      setSprites(all);
      if (!selected && all.length) {
        const running = all.find((s) => s.status === 'running' || s.status === 'warm');
        setSelected((running ?? all[0]).name);
      }
    } catch (err: any) {
      setError(err.message ?? 'Failed to load sprites');
    }
    setLoading(false);
  }, [selected]);

  useEffect(() => {
    load();
  }, [load]);

  const openTerminal = () => {
    if (!selected) return;
    router.push({ pathname: '/(app)/ttyd-terminal', params: { name: selected } });
  };

  const capture = async () => {
    if (!selected) return;
    setCapturing(true);
    setError(undefined);
    try {
      const creds = await captureClaudeCreds(selected);
      await auth.saveClaudeCreds(creds);
      Alert.alert(
        'Captured',
        'Claude login saved. It will be applied to every new sprite automatically.',
        [{ text: 'Done', onPress: () => router.back() }]
      );
    } catch (err: any) {
      setError(err.message ?? 'Capture failed');
    }
    setCapturing(false);
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.intro, { color: colors.textSecondary }]}>
        Log in to Claude once on a sprite, then the app captures the credentials and replays them
        onto every future sprite — no token pasting, and it self-refreshes.
      </Text>

      {auth.hasClaudeCreds && (
        <View style={[styles.banner, { backgroundColor: colors.success + '22' }]}>
          <Text style={[styles.bannerText, { color: colors.success }]}>
            A captured login is already stored. Capturing again replaces it.
          </Text>
        </View>
      )}

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        {STEPS.map((step, i) => (
          <View key={i} style={styles.stepRow}>
            <View style={[styles.stepNum, { backgroundColor: colors.tint }]}>
              <Text style={styles.stepNumText}>{i + 1}</Text>
            </View>
            <Text style={[styles.stepText, { color: colors.text }]}>{step}</Text>
          </View>
        ))}
      </View>

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>SPRITE</Text>
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        {loading ? (
          <ActivityIndicator color={colors.tint} style={{ paddingVertical: Spacing.lg }} />
        ) : sprites.length === 0 ? (
          <Text style={[styles.stepText, { color: colors.textSecondary }]}>No sprites yet.</Text>
        ) : (
          sprites.map((s) => {
            const active = s.name === selected;
            return (
              <Pressable
                key={s.id}
                style={({ pressed }) => [styles.spriteRow, { opacity: pressed ? 0.6 : 1 }]}
                onPress={() => setSelected(s.name)}
              >
                <View
                  style={[
                    styles.radio,
                    { borderColor: active ? colors.tint : colors.border },
                    active && { backgroundColor: colors.tint },
                  ]}
                />
                <Text style={[styles.spriteName, { color: colors.text }]}>{s.name}</Text>
                <Text style={[styles.spriteStatus, { color: colors.textSecondary }]}>
                  {s.status}
                </Text>
              </Pressable>
            );
          })
        )}
      </View>

      <Pressable
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: colors.card, opacity: pressed || !selected ? 0.6 : 1 },
        ]}
        onPress={openTerminal}
        disabled={!selected}
      >
        <Text style={[styles.buttonText, { color: colors.tint }]}>Open Terminal</Text>
      </Pressable>

      <Pressable
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: colors.tint, opacity: pressed || !selected || capturing ? 0.7 : 1 },
        ]}
        onPress={capture}
        disabled={!selected || capturing}
      >
        {capturing ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={[styles.buttonText, { color: '#fff' }]}>Capture credentials</Text>
        )}
      </Pressable>

      {error && (
        <View style={[styles.errorCard, { backgroundColor: colors.destructive + '15' }]}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: Spacing.lg, gap: Spacing.md },
  intro: { fontSize: FontSize.sm, lineHeight: 20 },
  banner: { padding: Spacing.md, borderRadius: 10 },
  bannerText: { fontSize: FontSize.sm },
  card: { borderRadius: 12, padding: Spacing.md, gap: Spacing.md },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
  stepNum: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { color: '#fff', fontWeight: '700', fontSize: FontSize.xs },
  stepText: { flex: 1, fontSize: FontSize.sm, lineHeight: 20 },
  sectionHeader: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    marginTop: Spacing.sm,
    marginLeft: Spacing.xs,
  },
  spriteRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2 },
  spriteName: { flex: 1, fontSize: FontSize.md, fontWeight: '500' },
  spriteStatus: { fontSize: FontSize.xs },
  button: {
    paddingVertical: Spacing.md,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonText: { fontSize: FontSize.md, fontWeight: '600' },
  errorCard: { padding: Spacing.md, borderRadius: 10 },
  errorText: { fontSize: FontSize.sm, textAlign: 'center' },
});
