import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Alert,
  Modal,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Sprite } from '@/models/sprite';
import * as api from '@/services/api';
import { chatRepository } from '@/services/chat-repository';
import { ensureProvisionedOnce } from '@/services/provision';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/hooks/use-theme';
import { SpriteRow } from '@/components/dashboard/SpriteRow';
import { CreateSpriteSheet } from '@/components/dashboard/CreateSpriteSheet';
import { FontSize, Spacing } from '@/constants/theme';

export default function DashboardScreen() {
  const colors = useTheme();
  const auth = useAuth();
  const [sprites, setSprites] = useState<Sprite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showCreate, setShowCreate] = useState(false);
  const [wakingSprites, setWakingSprites] = useState<Set<string>>(new Set());
  // Persisted "chat has an agent turn running" flags per sprite. Best-effort:
  // reconciled against live exec sessions when a sprite screen opens.
  const [runningBySprite, setRunningBySprite] = useState<Record<string, number>>({});

  const loadSprites = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const result = await api.listSprites();
      setSprites(result);
    } catch (err: any) {
      setError(err.message);
    }
    try {
      const runningChats = await chatRepository.listWithActiveRuns();
      const counts: Record<string, number> = {};
      for (const chat of runningChats) {
        counts[chat.spriteName] = (counts[chat.spriteName] ?? 0) + 1;
      }
      setRunningBySprite(counts);
    } catch {
      // Non-fatal — badges just don't show.
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    loadSprites();
  }, [loadSprites]);

  const handleCreate = async (name: string) => {
    await api.createSprite(name);
    await loadSprites();
    // Best-effort: write credentials onto the new sprite once. If it isn't ready
    // yet, the first chat turn re-attempts via ensureProvisionedOnce.
    ensureProvisionedOnce(name).catch(() => {});
    router.push({ pathname: '/(app)/sprite/[name]', params: { name, tab: 'integrations' } });
  };

  const handleDelete = (sprite: Sprite) => {
    Alert.alert(
      'Delete Sprite',
      `Delete "${sprite.name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const prev = [...sprites];
            setSprites((s) => s.filter((sp) => sp.id !== sprite.id));
            try {
              await api.deleteSprite(sprite.name);
            } catch {
              setSprites(prev);
              await loadSprites();
            }
          },
        },
      ]
    );
  };

  const handlePress = async (sprite: Sprite) => {
    if (sprite.status === 'cold') {
      // Wake the sprite first
      setWakingSprites((prev) => new Set(prev).add(sprite.name));
      try {
        await api.runExec(sprite.name, 'true', 60);
        await loadSprites();
      } catch {}
      setWakingSprites((prev) => {
        const next = new Set(prev);
        next.delete(sprite.name);
        return next;
      });
    }
    router.push(`/(app)/sprite/${sprite.name}`);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}>
      {error && (
        <View style={[styles.errorBanner, { backgroundColor: colors.destructive + '15' }]}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        </View>
      )}

      <FlatList
        data={sprites}
        renderItem={({ item }) => (
          <SpriteRow
            sprite={item}
            onPress={() => handlePress(item)}
            isWaking={wakingSprites.has(item.name)}
            runningCount={runningBySprite[item.name] ?? 0}
          />
        )}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={loadSprites} />
        }
        contentContainerStyle={sprites.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.emptyView}>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No Sprites</Text>
              <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
                Create a sprite to get started with Claude Code.
              </Text>
            </View>
          ) : null
        }
        ItemSeparatorComponent={() => null}
      />

      {/* Floating create button */}
      <Pressable
        style={[styles.fab, { backgroundColor: colors.tint }]}
        onPress={() => setShowCreate(true)}
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      {/* Bottom bar: Guides + Settings */}
      <View style={styles.bottomBar}>
        <Pressable
          style={[styles.bottomButton, { backgroundColor: colors.card }]}
          onPress={() => router.push('/(app)/guide')}
        >
          <Text style={[styles.settingsButtonText, { color: colors.text }]}>Guides</Text>
        </Pressable>
        <Pressable
          style={[styles.bottomButton, { backgroundColor: colors.card }]}
          onPress={() => router.push('/(app)/settings')}
        >
          <Text style={[styles.settingsButtonText, { color: colors.text }]}>Settings</Text>
        </Pressable>
      </View>

      <Modal visible={showCreate} animationType="slide" transparent>
        <CreateSpriteSheet
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  errorBanner: {
    padding: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
    borderRadius: 8,
  },
  errorText: {
    fontSize: FontSize.sm,
    textAlign: 'center',
  },
  emptyContainer: {
    flex: 1,
  },
  emptyView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xxl,
  },
  emptyTitle: {
    fontSize: FontSize.xl,
    fontWeight: '600',
    marginBottom: Spacing.sm,
  },
  emptySubtitle: {
    fontSize: FontSize.md,
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    right: Spacing.xl,
    bottom: 100,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  fabText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '400',
    marginTop: -2,
  },
  bottomBar: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.xxl,
  },
  bottomButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderRadius: 10,
  },
  settingsButtonText: {
    fontSize: FontSize.md,
    fontWeight: '500',
  },
});
