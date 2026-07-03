import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import {
  PROVIDERS,
  ProviderId,
  AccountStatus,
  checkAccounts,
} from '@/services/account-auth';
import { ConnectAccountSheet } from './ConnectAccountSheet';

interface SpriteAccountsTabProps {
  spriteName: string;
  isActive: boolean;
}

export function SpriteAccountsTab({ spriteName, isActive }: SpriteAccountsTabProps) {
  const colors = useTheme();
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState<ProviderId | null>(null);

  const refresh = useCallback(async () => {
    setError(undefined);
    try {
      const result = await checkAccounts(spriteName);
      setStatus(result);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to check accounts');
    }
    setLoading(false);
  }, [spriteName]);

  // Load once when the tab first becomes active.
  useEffect(() => {
    if (isActive && status === null) {
      refresh();
    }
  }, [isActive, status, refresh]);

  const handleConnected = useCallback(
    (provider: ProviderId) => {
      setConnecting(null);
      setStatus((prev) => (prev ? { ...prev, [provider]: true } : prev));
      refresh();
    },
    [refresh]
  );

  const connectedCount = status
    ? PROVIDERS.filter((p) => status[p.id]).length
    : 0;

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
            ACCOUNTS
          </Text>
          <Pressable onPress={refresh} hitSlop={8} disabled={loading}>
            <Text style={[styles.refresh, { color: colors.tint }]}>
              {loading ? 'Checking…' : 'Refresh'}
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.intro, { color: colors.textSecondary }]}>
          Connect these accounts on <Text style={{ fontWeight: '600' }}>{spriteName}</Text> so
          the agents and git can work here.{' '}
          {status && `${connectedCount}/${PROVIDERS.length} connected.`}
        </Text>

        {error && (
          <View style={[styles.errorCard, { backgroundColor: colors.destructive + '15' }]}>
            <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
          </View>
        )}

        {loading && status === null ? (
          <ActivityIndicator color={colors.tint} style={{ marginTop: Spacing.xl }} />
        ) : (
          PROVIDERS.map((p) => {
            const connected = !!status?.[p.id];
            return (
              <View
                key={p.id}
                style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.cardTop}>
                  <View style={[styles.badge, { backgroundColor: p.accent }]}>
                    <Text style={styles.badgeText}>{p.monogram}</Text>
                  </View>
                  <View style={styles.cardText}>
                    <Text style={[styles.cardTitle, { color: colors.text }]}>{p.label}</Text>
                    <View style={styles.statusRow}>
                      <View
                        style={[
                          styles.dot,
                          { backgroundColor: connected ? colors.success : colors.warning },
                        ]}
                      />
                      <Text style={[styles.statusText, { color: colors.textSecondary }]}>
                        {connected ? 'Connected' : 'Not connected'}
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    style={({ pressed }) => [
                      styles.connectButton,
                      connected
                        ? { borderColor: colors.border, borderWidth: 1 }
                        : { backgroundColor: colors.tint },
                      pressed && { opacity: 0.7 },
                    ]}
                    onPress={() => setConnecting(p.id)}
                  >
                    <Text
                      style={[
                        styles.connectButtonText,
                        { color: connected ? colors.tint : '#fff' },
                      ]}
                    >
                      {connected ? 'Reconnect' : 'Connect'}
                    </Text>
                  </Pressable>
                </View>
                <Text style={[styles.blurb, { color: colors.textSecondary }]}>{p.blurb}</Text>
              </View>
            );
          })
        )}
      </ScrollView>

      {connecting && (
        <ConnectAccountSheet
          spriteName={spriteName}
          provider={connecting}
          onClose={() => setConnecting(null)}
          onConnected={handleConnected}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.lg, paddingBottom: Spacing.xxl },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  sectionHeader: { fontSize: FontSize.xs, fontWeight: '600', letterSpacing: 0.5 },
  refresh: { fontSize: FontSize.sm, fontWeight: '600' },
  intro: { fontSize: FontSize.sm, lineHeight: 20, marginBottom: Spacing.lg },
  errorCard: { padding: Spacing.md, borderRadius: 10, marginBottom: Spacing.md },
  errorText: { fontSize: FontSize.sm, textAlign: 'center' },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    gap: Spacing.sm,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  badge: { width: 36, height: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: FontSize.lg, fontWeight: '700' },
  cardText: { flex: 1, gap: 3 },
  cardTitle: { fontSize: FontSize.md, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  statusText: { fontSize: FontSize.xs },
  connectButton: {
    borderRadius: 8,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectButtonText: { fontSize: FontSize.sm, fontWeight: '600' },
  blurb: { fontSize: FontSize.xs, lineHeight: 17 },
});
