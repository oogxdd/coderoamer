import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { FontSize, Spacing } from '@/constants/theme';
import { shortWorkingDirectory } from '@/constants/session';
import { useTheme } from '@/hooks/use-theme';
import { AgentProvider } from '@/models/chat';
import { Sprite } from '@/models/sprite';
import {
  ActivityScanError,
  GlobalAgentSession,
  SpriteScanInput,
  scanAllSpriteActivity,
  sortActivitySessions,
} from '@/services/activity';
import { activityRepository } from '@/services/activity-repository';
import * as api from '@/services/api';

type ActivityFilter = 'all' | 'running' | 'finished';

interface SpriteScanStatus {
  errors: ActivityScanError[];
}

const FILTERS: { label: string; value: ActivityFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Running', value: 'running' },
  { label: 'Finished', value: 'finished' },
];

function relativeTime(ms: number): string {
  if (!ms) return 'unknown';
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function activityProviderName(provider: AgentProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

function summarizeErrors(statuses: Record<string, SpriteScanStatus>): {
  affectedSprites: number;
  failedProviders: number;
} {
  let affectedSprites = 0;
  let failedProviders = 0;
  for (const status of Object.values(statuses)) {
    if (status.errors.length === 0) continue;
    affectedSprites += 1;
    failedProviders += status.errors.length;
  }
  return { affectedSprites, failedProviders };
}

/**
 * Cross-Sprite agent activity.
 *
 * The list is device-resident (`activity_sessions` in SQLite) and paints the
 * instant the tab opens; the network pass that follows is a *revalidation*, not
 * a rebuild. It only re-reads transcripts modified since each store's cursor,
 * so the usual visit ships a few hundred bytes per Sprite instead of walking
 * every transcript again. Pull-to-refresh forces the full re-read.
 */
export default function ActivityScreen() {
  const colors = useTheme();
  const [sessions, setSessions] = useState<GlobalAgentSession[]>([]);
  const [scanStatuses, setScanStatuses] = useState<Record<string, SpriteScanStatus>>({});
  const [sprites, setSprites] = useState<Sprite[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [isHydrating, setIsHydrating] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [completedScans, setCompletedScans] = useState(0);
  const [totalScans, setTotalScans] = useState(0);
  const [lastScanAt, setLastScanAt] = useState<number | undefined>();
  const [error, setError] = useState<string>();
  const requestRef = useRef(0);
  // Read inside the scan callbacks: the cached rows a delta scan folds into
  // must be the current ones, not the ones captured when the pass started.
  const sessionsRef = useRef<GlobalAgentSession[]>([]);

  const commitSessions = useCallback((next: GlobalAgentSession[]) => {
    const sorted = sortActivitySessions(next);
    sessionsRef.current = sorted;
    setSessions(sorted);
  }, []);

  /** Paint whatever the device already knows before touching the network. */
  const hydrateFromCache = useCallback(async () => {
    try {
      const [cached, scannedAt] = await Promise.all([
        activityRepository.list(),
        activityRepository.lastScanAt(),
      ]);
      commitSessions(cached);
      setLastScanAt(scannedAt);
    } catch {
      // An unreadable cache is not fatal — the scan below refills it.
    } finally {
      setIsHydrating(false);
    }
  }, [commitSessions]);

  const loadActivity = useCallback(
    async ({ full = false, refreshing = false }: { full?: boolean; refreshing?: boolean } = {}) => {
      const request = ++requestRef.current;
      setError(undefined);
      setCompletedScans(0);
      if (refreshing) setIsRefreshing(true);

      let nextSprites: Sprite[];
      try {
        nextSprites = await api.listSprites();
      } catch (loadError) {
        if (request !== requestRef.current) return;
        setError(loadError instanceof Error ? loadError.message : 'Could not load Sprites');
        setIsRefreshing(false);
        return;
      }

      if (request !== requestRef.current) return;
      setSprites(nextSprites);
      setTotalScans(nextSprites.length);

      // A deleted Sprite takes its rows with it, in the cache and on screen.
      const currentSpriteNames = new Set(nextSprites.map((sprite) => sprite.name));
      activityRepository.pruneMissingSprites([...currentSpriteNames]).catch(() => {});
      commitSessions(
        sessionsRef.current.filter((session) => currentSpriteNames.has(session.spriteName))
      );
      setScanStatuses({});

      const cursors = full ? {} : await activityRepository.cursors();
      if (request !== requestRef.current) return;

      const inputs: SpriteScanInput[] = nextSprites.map((sprite) => ({
        sprite,
        cursors: {
          claude: cursors[`${sprite.name}:claude`] ?? 0,
          codex: cursors[`${sprite.name}:codex`] ?? 0,
        },
        cached: sessionsRef.current.filter((session) => session.spriteName === sprite.name),
      }));

      await scanAllSpriteActivity(inputs, {
        onResult: async (result, completed) => {
          if (request !== requestRef.current) return;
          const scannedAt = Date.now();
          let stored = result.sessions;
          try {
            stored = await activityRepository.replaceSprite(
              result.sprite.name,
              result.sessions,
              result.cursors,
              scannedAt
            );
          } catch {
            // Keep showing the fresh scan even if the cache write failed.
          }
          if (request !== requestRef.current) return;
          commitSessions([
            ...sessionsRef.current.filter((session) => session.spriteName !== result.sprite.name),
            ...stored,
          ]);
          setScanStatuses((current) => ({
            ...current,
            [result.sprite.name]: { errors: result.errors },
          }));
          setCompletedScans(completed);
          if (result.errors.length < 2) setLastScanAt(scannedAt);
        },
      });

      if (request !== requestRef.current) return;
      setIsRefreshing(false);
    },
    [commitSessions]
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        await hydrateFromCache();
        if (active) await loadActivity();
      })();
      return () => {
        active = false;
        requestRef.current += 1;
      };
    }, [hydrateFromCache, loadActivity])
  );

  const openSession = useCallback((session: GlobalAgentSession) => {
    // Straight into the conversation, not just the Sprite: the row *is* a
    // coding session, so a tap should land on its transcript.
    router.push({
      pathname: '/(app)/sprite/[name]',
      params: {
        name: session.spriteName,
        session: session.id,
        provider: session.provider,
        cwd: session.cwd ?? '',
      },
    });
  }, []);

  const visibleSessions = useMemo(() => {
    if (filter === 'running') return sessions.filter((session) => session.live);
    if (filter === 'finished') return sessions.filter((session) => !session.live);
    return sessions;
  }, [filter, sessions]);

  const runningCount = sessions.filter((session) => session.live).length;
  const finishedCount = sessions.length - runningCount;
  const scanInProgress = totalScans > 0 && completedScans < totalScans;
  const scanErrors = summarizeErrors(scanStatuses);

  const renderSession = useCallback(
    ({ item }: { item: GlobalAgentSession }) => (
      <Pressable
        style={({ pressed }) => [
          styles.sessionRow,
          {
            backgroundColor: pressed ? colors.backgroundSelected : colors.card,
            borderBottomColor: colors.border,
          },
        ]}
        onPress={() => openSession(item)}
        accessibilityRole="button"
        accessibilityLabel={`${item.live ? 'Running' : 'Finished'} ${activityProviderName(item.provider)} session on ${item.spriteName}`}
        accessibilityHint="Opens this coding session's conversation"
      >
        <View style={styles.sessionContent}>
          <View style={styles.sessionTopLine}>
            <View
              style={[
                styles.statusPill,
                { backgroundColor: (item.live ? colors.success : colors.backgroundElement) + '22' },
              ]}
            >
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: item.live ? colors.success : colors.textSecondary },
                ]}
              />
              <Text
                style={[
                  styles.statusText,
                  { color: item.live ? colors.success : colors.textSecondary },
                ]}
              >
                {item.live ? 'RUNNING' : 'FINISHED'}
              </Text>
            </View>
            <Text style={[styles.spriteName, { color: colors.text }]} numberOfLines={1}>
              {item.spriteName}
            </Text>
            <Text style={[styles.updatedAt, { color: colors.textSecondary }]}>
              {relativeTime(item.modified)}
            </Text>
          </View>

          <Text style={[styles.preview, { color: colors.text }]} numberOfLines={2}>
            {item.preview || '(no prompt recorded)'}
          </Text>

          <View style={styles.sessionMetaRow}>
            <Text style={[styles.providerPill, { color: colors.tint, borderColor: colors.border }]}>
              {activityProviderName(item.provider)}
            </Text>
            <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.cwd ? shortWorkingDirectory(item.cwd) : 'unknown dir'} · {item.messageCount}{' '}
              events
            </Text>
          </View>
        </View>
        <Text style={[styles.chevron, { color: colors.textSecondary }]}>›</Text>
      </Pressable>
    ),
    [colors, openSession]
  );

  const header = (
    <View>
      <View style={styles.summaryRow}>
        <View style={[styles.summaryCard, { backgroundColor: colors.card }]}>
          <Text style={[styles.summaryValue, { color: colors.success }]}>{runningCount}</Text>
          <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Running</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: colors.card }]}>
          <Text style={[styles.summaryValue, { color: colors.text }]}>{finishedCount}</Text>
          <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Finished</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: colors.card }]}>
          <Text style={[styles.summaryValue, { color: colors.text }]}>{sprites.length}</Text>
          <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Sprites</Text>
        </View>
      </View>

      <View style={[styles.filterBar, { backgroundColor: colors.backgroundElement }]}>
        {FILTERS.map((option) => {
          const selected = option.value === filter;
          return (
            <Pressable
              key={option.value}
              style={[
                styles.filterButton,
                selected && { backgroundColor: colors.card },
              ]}
              onPress={() => setFilter(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  styles.filterText,
                  { color: selected ? colors.text : colors.textSecondary },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {scanInProgress ? (
        <View style={styles.scanRow}>
          <ActivityIndicator size="small" color={colors.tint} />
          <Text style={[styles.scanText, { color: colors.textSecondary }]}>
            Checking {completedScans} of {totalScans} Sprites for changes…
          </Text>
        </View>
      ) : lastScanAt ? (
        <View style={styles.scanRow}>
          <Text style={[styles.scanText, { color: colors.textSecondary }]}>
            Updated {relativeTime(lastScanAt)} · pull to re-read every transcript
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={[styles.errorBanner, { backgroundColor: colors.destructive + '15' }]}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
          <Pressable
            onPress={() => loadActivity({ refreshing: true })}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={[styles.retryText, { color: colors.destructive }]}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {scanErrors.affectedSprites > 0 ? (
        <View style={[styles.warningBanner, { backgroundColor: colors.warning + '15' }]}>
          <Text style={[styles.warningText, { color: colors.warning }]}>
            Partial results: {scanErrors.failedProviders} agent{' '}
            {scanErrors.failedProviders === 1 ? 'store' : 'stores'} could not be read on{' '}
            {scanErrors.affectedSprites} {scanErrors.affectedSprites === 1 ? 'Sprite' : 'Sprites'}.
            Showing what this device already had.
          </Text>
        </View>
      ) : null}
    </View>
  );

  if (isHydrating && sessions.length === 0 && !error) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.backgroundSecondary }]}>
        <ActivityIndicator size="large" color={colors.tint} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
          Finding agent sessions across your Sprites…
        </Text>
        {totalScans > 0 ? (
          <Text style={[styles.progressText, { color: colors.textSecondary }]}>
            {completedScans} of {totalScans}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}>
      <FlatList
        data={visibleSessions}
        keyExtractor={(item) => `${item.spriteName}:${item.provider}:${item.id}`}
        renderItem={renderSession}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => loadActivity({ full: true, refreshing: true })}
            tintColor={colors.tint}
          />
        }
        contentContainerStyle={[
          styles.listContent,
          visibleSessions.length === 0 && !scanInProgress ? styles.emptyListContent : undefined,
        ]}
        ListEmptyComponent={
          !scanInProgress ? (
            <View style={styles.emptyView}>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>No sessions found</Text>
              <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
                {filter === 'running'
                  ? 'No Claude or Codex sessions are running right now.'
                  : filter === 'finished'
                    ? 'No finished Claude or Codex sessions were found.'
                    : sprites.length === 0
                      ? 'Create a Sprite and start a Claude or Codex session first.'
                      : 'Start Claude or Codex in any Sprite. Its native transcript will appear here.'}
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.sm,
  },
  loadingText: {
    fontSize: FontSize.md,
    lineHeight: 22,
    textAlign: 'center',
  },
  progressText: { fontSize: FontSize.sm },
  listContent: { paddingBottom: Spacing.xxl },
  emptyListContent: { flexGrow: 1 },
  summaryRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
  },
  summaryCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderRadius: 12,
  },
  summaryValue: { fontSize: FontSize.xl, fontWeight: '700' },
  summaryLabel: { fontSize: FontSize.xs, marginTop: 2 },
  filterBar: {
    flexDirection: 'row',
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.lg,
    padding: 2,
    borderRadius: 9,
  },
  filterButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderRadius: 7,
  },
  filterText: { fontSize: FontSize.sm, fontWeight: '600' },
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
  },
  scanText: { fontSize: FontSize.sm },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: 10,
  },
  errorText: { flex: 1, fontSize: FontSize.sm },
  retryText: { fontSize: FontSize.sm, fontWeight: '700' },
  warningBanner: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: 10,
  },
  warningText: { fontSize: FontSize.sm, lineHeight: 19 },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sessionContent: { flex: 1, marginRight: Spacing.sm },
  sessionTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: 6,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  spriteName: { flex: 1, fontSize: FontSize.sm, fontWeight: '700' },
  updatedAt: { fontSize: FontSize.xs },
  preview: { fontSize: FontSize.md, lineHeight: 21, fontWeight: '500' },
  sessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  providerPill: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  metaText: { flex: 1, fontSize: FontSize.xs },
  chevron: { fontSize: FontSize.xl, fontWeight: '300' },
  emptyView: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    paddingVertical: 80,
  },
  emptyTitle: { fontSize: FontSize.xl, fontWeight: '700', marginBottom: Spacing.sm },
  emptyBody: { fontSize: FontSize.md, lineHeight: 22, textAlign: 'center' },
});
