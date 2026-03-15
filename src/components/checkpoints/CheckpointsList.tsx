import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { Checkpoint } from '@/models/checkpoint';
import * as api from '@/services/api';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { CreateCheckpointSheet } from './CreateCheckpointSheet';

interface CheckpointsListProps {
  spriteName: string;
}

export function CheckpointsList({ spriteName }: CheckpointsListProps) {
  const colors = useTheme();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRestoring, setIsRestoring] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string>();

  const loadCheckpoints = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const result = await api.listCheckpoints(spriteName);
      const filtered = result
        .filter((c) => c.id !== 'Current')
        .sort((a, b) => {
          const ta = a.create_time ? new Date(a.create_time).getTime() : 0;
          const tb = b.create_time ? new Date(b.create_time).getTime() : 0;
          return tb - ta;
        });
      setCheckpoints(filtered);
    } catch (err: any) {
      setError(err.message);
    }
    setIsLoading(false);
  }, [spriteName]);

  useEffect(() => {
    loadCheckpoints();
  }, [loadCheckpoints]);

  const handleRestore = (checkpoint: Checkpoint) => {
    Alert.alert(
      'Restore Checkpoint',
      `Restore to "${checkpoint.comment || checkpoint.id}"? The sprite will restart.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          style: 'destructive',
          onPress: async () => {
            setIsRestoring(checkpoint.id);
            try {
              await api.restoreCheckpoint(spriteName, checkpoint.id);
              Alert.alert('Restored', 'Checkpoint restored successfully.');
            } catch (err: any) {
              Alert.alert('Error', err.message);
            }
            setIsRestoring(null);
          },
        },
      ]
    );
  };

  const handleCreate = async (comment?: string) => {
    await api.createCheckpoint(spriteName, comment);
    await loadCheckpoints();
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return date.toLocaleDateString();
  };

  const renderItem = ({ item }: { item: Checkpoint }) => (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <View style={styles.rowContent}>
        <Text style={[styles.comment, { color: colors.text }]} numberOfLines={2}>
          {item.comment || item.id.slice(0, 12)}
        </Text>
        <View style={styles.meta}>
          <Text style={[styles.date, { color: colors.textSecondary }]}>
            {formatDate(item.create_time)}
          </Text>
          {item.is_auto && (
            <Text style={[styles.badge, { color: colors.textSecondary, backgroundColor: colors.backgroundElement }]}>
              Auto
            </Text>
          )}
        </View>
      </View>
      <Pressable
        style={[styles.restoreButton, { backgroundColor: colors.tint }]}
        onPress={() => handleRestore(item)}
        disabled={isRestoring === item.id}
      >
        {isRestoring === item.id ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.restoreText}>Restore</Text>
        )}
      </Pressable>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.text }]}>Checkpoints</Text>
        <Pressable
          style={[styles.createButton, { backgroundColor: colors.tint }]}
          onPress={() => setShowCreate(true)}
        >
          <Text style={styles.createText}>+ New</Text>
        </Pressable>
      </View>

      {error && (
        <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
      )}

      <FlatList
        data={checkpoints}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={loadCheckpoints} />
        }
        ListEmptyComponent={
          !isLoading ? (
            <Text style={[styles.empty, { color: colors.textSecondary }]}>
              No checkpoints yet
            </Text>
          ) : null
        }
      />

      {showCreate && (
        <CreateCheckpointSheet
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '700',
  },
  createButton: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: 8,
  },
  createText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowContent: {
    flex: 1,
    marginRight: Spacing.md,
  },
  comment: {
    fontSize: FontSize.md,
    fontWeight: '500',
    marginBottom: 2,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  date: {
    fontSize: FontSize.sm,
  },
  badge: {
    fontSize: FontSize.xs,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  restoreButton: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: 8,
    minWidth: 70,
    alignItems: 'center',
  },
  restoreText: {
    color: '#fff',
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  error: {
    padding: Spacing.lg,
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  empty: {
    padding: Spacing.xxl,
    textAlign: 'center',
    fontSize: FontSize.md,
  },
});
