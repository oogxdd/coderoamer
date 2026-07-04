import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Connection } from '@/models/connection';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

interface MachineRowProps {
  connection: Connection;
  onPress: () => void;
  onLongPress?: () => void;
  isWaking?: boolean;
}

function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** A dashboard row for a custom-VPS or AWS-backed connection (one machine). */
export function MachineRow({ connection, onPress, onLongPress, isWaking }: MachineRowProps) {
  const colors = useTheme();
  const host = hostOf(connection.baseUrl);
  const pending = connection.backing === 'aws-ec2' && !connection.baseUrl;

  const badge =
    connection.backing === 'aws-ec2'
      ? `AWS · ${connection.aws?.region ?? '?'}`
      : 'Custom VPS';

  const subtitle = isWaking
    ? 'Waking…'
    : pending
      ? 'Provisioning — tap to add tunnel URL'
      : host ?? 'LAN';

  const dotColor = pending ? colors.warning : host ? colors.success : colors.textSecondary;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.container,
        { backgroundColor: pressed ? colors.backgroundSelected : colors.card, borderBottomColor: colors.border },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View style={styles.row}>
        <View style={styles.left}>
          <View style={styles.nameRow}>
            <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
              {connection.name}
            </Text>
            <View style={[styles.badge, { backgroundColor: colors.backgroundElement }]}>
              <Text style={[styles.badgeText, { color: colors.textSecondary }]}>{badge}</Text>
            </View>
          </View>
          <Text style={[styles.status, { color: colors.textSecondary }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Text style={[styles.chevron, { color: colors.textSecondary }]}>›</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  left: { flex: 1, marginRight: Spacing.sm },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: Spacing.sm },
  name: { fontSize: FontSize.lg, fontWeight: '600', flexShrink: 1 },
  badge: { marginLeft: Spacing.sm, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  badgeText: { fontSize: FontSize.xs, fontWeight: '600' },
  status: { fontSize: FontSize.sm, marginLeft: 16 },
  chevron: { fontSize: 22, fontWeight: '300' },
});
