import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  RefreshControl,
  Alert,
  Modal,
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { Sprite } from '@/models/sprite';
import { Connection, normalizeBaseUrl } from '@/models/connection';
import * as api from '@/services/api';
import { ensureProvisionedOnce } from '@/services/provision';
import { loadAwsCreds, terminateInstance } from '@/services/aws';
import { useConnections } from '@/contexts/ConnectionsContext';
import { useTheme } from '@/hooks/use-theme';
import { SpriteRow } from '@/components/dashboard/SpriteRow';
import { MachineRow } from '@/components/dashboard/MachineRow';
import { AddConnectionSheet } from '@/components/dashboard/AddConnectionSheet';
import { FontSize, Spacing } from '@/constants/theme';

type VmEntry =
  | { key: string; kind: 'sprite'; connection: Connection; sprite: Sprite }
  | { key: string; kind: 'machine'; connection: Connection };

/** URL-safe route name for a machine (the daemon ignores :name; this keeps the
 * built URLs well-formed and stable). */
function machineRouteName(conn: Connection): string {
  const slug = conn.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || conn.id;
}

export default function DashboardScreen() {
  const colors = useTheme();
  const { connections, refresh, setActive, updateConnection, removeConnection } = useConnections();
  const [vms, setVms] = useState<VmEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showAdd, setShowAdd] = useState(false);
  const [waking, setWaking] = useState<Set<string>>(new Set());

  // Ensure a freshly-added Sprites token has been migrated into a connection.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const loadVms = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    const entries: VmEntry[] = [];
    const errors: string[] = [];
    await Promise.all(
      connections.map(async (conn) => {
        if (conn.backing === 'sprite') {
          try {
            const sprites = await api.listSprites(conn);
            for (const s of sprites) {
              entries.push({ key: `${conn.id}:${s.id}`, kind: 'sprite', connection: conn, sprite: s });
            }
          } catch (e: any) {
            errors.push(`${conn.name}: ${e.message ?? 'failed to load'}`);
          }
        } else {
          entries.push({ key: conn.id, kind: 'machine', connection: conn });
        }
      })
    );
    setVms(entries);
    setError(errors.length ? errors.join('\n') : undefined);
    setIsLoading(false);
  }, [connections]);

  useEffect(() => {
    loadVms();
  }, [loadVms]);

  const setWakingKey = (key: string, on: boolean) =>
    setWaking((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const handleCreateSprite = async (name: string) => {
    const spriteConn = connections.find((c) => c.backing === 'sprite');
    if (!spriteConn) throw new Error('No Sprites account connected. Add one in Settings first.');
    await setActive(spriteConn);
    await api.createSprite(name, spriteConn);
    // Best-effort: write credentials onto the new sprite once.
    ensureProvisionedOnce(name).catch(() => {});
    await loadVms();
  };

  const handleSpritePress = async (entry: Extract<VmEntry, { kind: 'sprite' }>) => {
    await setActive(entry.connection);
    if (entry.sprite.status === 'cold') {
      setWakingKey(entry.key, true);
      try {
        await api.runExec(entry.sprite.name, 'true', 60, entry.connection);
        await loadVms();
      } catch {}
      setWakingKey(entry.key, false);
    }
    router.push({
      pathname: '/(app)/sprite/[name]',
      params: { name: entry.sprite.name, connectionId: entry.connection.id },
    });
  };

  const handleSpriteLongPress = (entry: Extract<VmEntry, { kind: 'sprite' }>) => {
    Alert.alert(entry.sprite.name, 'Delete this sprite? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteSprite(entry.sprite.name, entry.connection);
          } finally {
            await loadVms();
          }
        },
      },
    ]);
  };

  const handleMachinePress = async (conn: Connection) => {
    if (!conn.baseUrl) {
      // Pending AWS instance — let the user paste the tunnel URL once reachable.
      if (Platform.OS === 'ios' && (Alert as any).prompt) {
        (Alert as any).prompt(
          'Tunnel URL',
          'Paste the https URL the instance printed once it is reachable.',
          async (val: string) => {
            const url = normalizeBaseUrl(val || '');
            if (url) {
              await updateConnection(conn.id, { baseUrl: url });
              await loadVms();
            }
          }
        );
      } else {
        Alert.alert(
          'Provisioning',
          'This instance is still booting. Reopen once you have its tunnel URL; long-press to manage.'
        );
      }
      return;
    }
    await setActive(conn);
    router.push({
      pathname: '/(app)/sprite/[name]',
      params: { name: machineRouteName(conn), connectionId: conn.id },
    });
  };

  const handleMachineLongPress = (conn: Connection) => {
    const buttons: any[] = [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove from app',
        style: 'destructive',
        onPress: async () => {
          await removeConnection(conn.id);
          await loadVms();
        },
      },
    ];
    if (conn.backing === 'aws-ec2' && conn.aws) {
      buttons.splice(1, 0, {
        text: 'Terminate instance',
        style: 'destructive',
        onPress: async () => {
          try {
            const creds = await loadAwsCreds();
            if (creds && conn.aws) {
              await terminateInstance({ creds, region: conn.aws.region }, conn.aws.instanceId);
            }
          } catch (e: any) {
            Alert.alert('Terminate failed', e.message ?? 'Could not terminate the instance');
            return;
          }
          await removeConnection(conn.id);
          await loadVms();
        },
      });
    }
    Alert.alert(conn.name, 'Manage this connection', buttons);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}>
      {error && (
        <View style={[styles.errorBanner, { backgroundColor: colors.destructive + '15' }]}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        </View>
      )}

      <FlatList
        data={vms}
        renderItem={({ item }) =>
          item.kind === 'sprite' ? (
            <SpriteRow
              sprite={item.sprite}
              onPress={() => handleSpritePress(item)}
              onLongPress={() => handleSpriteLongPress(item)}
              isWaking={waking.has(item.key)}
            />
          ) : (
            <MachineRow
              connection={item.connection}
              onPress={() => handleMachinePress(item.connection)}
              onLongPress={() => handleMachineLongPress(item.connection)}
              isWaking={waking.has(item.key)}
            />
          )
        }
        keyExtractor={(item) => item.key}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={loadVms} />}
        contentContainerStyle={vms.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.emptyView}>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No VMs</Text>
              <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
                Add a Sprite or a custom VPS to get started.
              </Text>
            </View>
          ) : null
        }
        ItemSeparatorComponent={() => null}
      />

      <Pressable style={[styles.fab, { backgroundColor: colors.tint }]} onPress={() => setShowAdd(true)}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>

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

      <Modal visible={showAdd} animationType="slide" transparent>
        <AddConnectionSheet onClose={() => setShowAdd(false)} onCreateSprite={handleCreateSprite} />
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  errorBanner: { padding: Spacing.md, marginHorizontal: Spacing.lg, marginTop: Spacing.sm, borderRadius: 8 },
  errorText: { fontSize: FontSize.sm, textAlign: 'center' },
  emptyContainer: { flex: 1 },
  emptyView: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: Spacing.xxl },
  emptyTitle: { fontSize: FontSize.xl, fontWeight: '600', marginBottom: Spacing.sm },
  emptySubtitle: { fontSize: FontSize.md, textAlign: 'center' },
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
  fabText: { color: '#fff', fontSize: 28, fontWeight: '400', marginTop: -2 },
  bottomBar: { flexDirection: 'row', gap: Spacing.md, marginHorizontal: Spacing.xl, marginBottom: Spacing.xxl },
  bottomButton: { flex: 1, alignItems: 'center', paddingVertical: Spacing.md, borderRadius: 10 },
  settingsButtonText: { fontSize: FontSize.md, fontWeight: '500' },
});
