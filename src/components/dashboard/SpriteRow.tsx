import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Sprite, statusColor, statusDisplayName } from '@/models/sprite';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

interface SpriteRowProps {
  sprite: Sprite;
  onPress: () => void;
  /** Long-press to delete, matching the conversation list. */
  onLongPress?: () => void;
  /** Chats on this sprite with an agent turn currently running. */
  runningCount?: number;
}

export function SpriteRow({ sprite, onPress, onLongPress, runningCount }: SpriteRowProps) {
  const colors = useTheme();
  const dotColor = statusColor(sprite.status);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.container,
        { backgroundColor: pressed ? colors.backgroundSelected : colors.card },
        { borderBottomColor: colors.border },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${sprite.name}, ${statusDisplayName(sprite.status)}`}
      accessibilityHint={onLongPress ? 'Long press to delete' : undefined}
    >
      <View style={styles.row}>
        <View style={styles.left}>
          <View style={styles.nameRow}>
            <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
              {sprite.name}
            </Text>
          </View>
          <Text style={[styles.status, { color: colors.textSecondary }]}>
            {statusDisplayName(sprite.status)}
            {runningCount ? (
              <Text style={{ color: colors.success }}>
                {` · ${runningCount} agent ${runningCount === 1 ? 'run' : 'runs'}`}
              </Text>
            ) : null}
            {sprite.url ? ` · ${sprite.url.replace('https://', '')}` : ''}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: {
    flex: 1,
    marginRight: Spacing.sm,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: Spacing.sm,
  },
  name: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  status: {
    fontSize: FontSize.sm,
    marginLeft: 16,
  },
  chevron: {
    fontSize: 22,
    fontWeight: '300',
  },
});
