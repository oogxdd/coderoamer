import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  Modal,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';
import { AgentProvider, ChatMessage, providerDisplayName } from '@/models/chat';
import { shortWorkingDirectory } from '@/constants/session';
import {
  ClaudeSessionSummary,
  listClaudeSessions,
  readClaudeSessionMessages,
} from '@/services/claude-sessions';
import {
  CodexSessionSummary,
  listCodexSessions,
  readCodexSessionMessages,
} from '@/services/codex-sessions';
import { ExecSession, listExecSessions } from '@/services/api';
import { ChatMessageView } from './ChatMessageView';

type BrowserTab = 'history' | 'live';
export type AgentSessionSummary =
  (ClaudeSessionSummary | CodexSessionSummary) & { provider: AgentProvider };

interface SessionBrowserSheetProps {
  spriteName: string;
  /** Resume the chosen session: seeds a chat with its transcript + provider-specific resume id. */
  onResume: (session: AgentSessionSummary, messages: ChatMessage[]) => void;
  onClose: () => void;
}

function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function SessionBrowserSheet({ spriteName, onResume, onClose }: SessionBrowserSheetProps) {
  const colors = useTheme();
  const [activeTab, setActiveTab] = useState<BrowserTab>('history');

  // History tab state
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [lastLoadedAt, setLastLoadedAt] = useState<number | undefined>();

  // Detail (history) view state
  const [selected, setSelected] = useState<AgentSessionSummary | null>(null);
  const [detailMessages, setDetailMessages] = useState<ChatMessage[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | undefined>();
  const detailRequestRef = useRef(0);

  // Live tab state
  const [liveSessions, setLiveSessions] = useState<ExecSession[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveRefreshing, setLiveRefreshing] = useState(false);
  const [liveError, setLiveError] = useState<string | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [claudeList, codexList] = await Promise.all([
        listClaudeSessions(spriteName),
        listCodexSessions(spriteName),
      ]);
      setSessions(
        [
          ...claudeList.map((session) => ({ ...session, provider: 'claude' as const })),
          ...codexList.map((session) => ({ ...session, provider: 'codex' as const })),
        ].sort((a, b) => b.modified - a.modified)
      );
      setLastLoadedAt(Date.now());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load sessions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [spriteName]);

  const loadLive = useCallback(async () => {
    setLiveError(undefined);
    try {
      const list = await listExecSessions(spriteName);
      setLiveSessions(list);
    } catch (e: any) {
      setLiveError(e?.message ?? 'Failed to load live sessions');
    } finally {
      setLiveLoading(false);
      setLiveRefreshing(false);
    }
  }, [spriteName]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (activeTab === 'live' && !liveLoading && liveSessions.length === 0 && !liveError) {
      setLiveLoading(true);
      loadLive();
    }
  }, [activeTab, liveLoading, liveSessions.length, liveError, loadLive]);

  const openDetail = useCallback(
    async (session: AgentSessionSummary) => {
      const request = ++detailRequestRef.current;
      setSelected(session);
      setDetailMessages([]);
      setDetailError(undefined);
      setDetailLoading(true);
      try {
        const msgs =
          session.provider === 'codex'
            ? await readCodexSessionMessages(spriteName, session.id)
            : await readClaudeSessionMessages(spriteName, session.id);
        if (request !== detailRequestRef.current) return;
        setDetailMessages(msgs);
      } catch (e: any) {
        if (request !== detailRequestRef.current) return;
        setDetailError(e?.message ?? 'Failed to load transcript');
      } finally {
        if (request !== detailRequestRef.current) return;
        setDetailLoading(false);
      }
    },
    [spriteName]
  );

  const renderList = () => (
    <FlatList
      data={sessions}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
          tintColor={colors.tint}
        />
      }
      renderItem={({ item }) => (
        <Pressable
          style={[styles.row, { borderBottomColor: colors.border }]}
          onPress={() => openDetail(item)}
        >
          <View style={styles.rowContent}>
            <View style={styles.rowTopLine}>
              <Text style={[styles.providerPill, { color: colors.tint, borderColor: colors.border }]}>
                {providerDisplayName(item.provider)}
              </Text>
              <Text style={[styles.rowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                {item.cwd ? shortWorkingDirectory(item.cwd) : 'unknown dir'}
              </Text>
            </View>
            <Text style={[styles.rowPreview, { color: colors.text }]} numberOfLines={2}>
              {item.preview || '(no prompt recorded)'}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.messageCount} events · updated {relativeTime(item.modified)}
            </Text>
          </View>
          <Text style={[styles.chevron, { color: colors.tint }]}>›</Text>
        </Pressable>
      )}
      ListHeaderComponent={
        <View style={[styles.sourceHeader, { borderBottomColor: colors.border }]}>
          <Text style={[styles.sourceTitle, { color: colors.text }]}>Sprite Chat History</Text>
          <Text style={[styles.sourceMeta, { color: colors.textSecondary }]} numberOfLines={2}>
            Pulled from Claude and Codex transcript files on {spriteName}
            {lastLoadedAt ? ` · refreshed ${relativeTime(lastLoadedAt)}` : ''}
          </Text>
        </View>
      }
      ListEmptyComponent={
        loading ? (
          <View style={styles.centerView}>
            <ActivityIndicator size="small" color={colors.tint} />
            <Text style={[styles.dimText, { color: colors.textSecondary }]}>
              Scanning chat transcripts on {spriteName}…
            </Text>
          </View>
        ) : (
          <View style={styles.centerView}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {error
                ? error
                : 'No Claude or Codex sessions found on this sprite yet.'}
            </Text>
          </View>
        )
      }
    />
  );

  const renderLiveList = () => (
    <FlatList
      data={liveSessions}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      refreshControl={
        <RefreshControl
          refreshing={liveRefreshing}
          onRefresh={() => {
            setLiveRefreshing(true);
            loadLive();
          }}
          tintColor={colors.tint}
        />
      }
      renderItem={({ item }) => (
        <Pressable
          style={[styles.row, { borderBottomColor: colors.border }]}
          onPress={() => {
            onClose();
            router.push({
              pathname: '/(app)/exec-poc',
              params: { name: spriteName, attachSessionId: item.id },
            });
          }}
        >
          <View style={styles.rowContent}>
            <View style={styles.liveRowTop}>
              <View style={[styles.liveDot, { backgroundColor: '#3fb950' }]} />
              <Text style={[styles.rowPreview, { color: colors.text }]} numberOfLines={1}>
                {item.cmd ?? 'session'}
              </Text>
            </View>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.id}
              {item.last_activity ? ` · ${relativeTime(new Date(item.last_activity).getTime())}` : ''}
            </Text>
          </View>
          <Text style={[styles.chevron, { color: colors.tint }]}>›</Text>
        </Pressable>
      )}
      ListEmptyComponent={
        liveLoading ? (
          <View style={styles.centerView}>
            <ActivityIndicator size="small" color={colors.tint} />
            <Text style={[styles.dimText, { color: colors.textSecondary }]}>
              Fetching live sessions…
            </Text>
          </View>
        ) : (
          <View style={styles.centerView}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {liveError
                ? liveError
                : 'No running exec sessions. Start one from the stream terminal, or run a command via the sprite CLI.'}
            </Text>
          </View>
        )
      }
    />
  );

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          {selected ? (
            <Pressable onPress={() => setSelected(null)} hitSlop={12}>
              <Text style={[styles.headerButton, { color: colors.tint }]}>‹ Back</Text>
            </Pressable>
          ) : (
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={[styles.headerButton, { color: colors.tint }]}>Close</Text>
            </Pressable>
          )}
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {selected ? 'History' : 'Sessions'}
          </Text>
          <View style={styles.headerButtonRight}>
            {selected && !detailLoading && (
              <Pressable onPress={() => onResume(selected, detailMessages)} hitSlop={12}>
                <Text style={[styles.headerButton, { color: colors.tint }]}>Continue</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Tab bar — only shown on the list (not in the detail view) */}
        {!selected && (
          <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
            {(['history', 'live'] as BrowserTab[]).map((tab) => (
              <Pressable
                key={tab}
                style={[
                  styles.tab,
                  activeTab === tab && { borderBottomColor: colors.tint, borderBottomWidth: 2 },
                ]}
                onPress={() => setActiveTab(tab)}
              >
                <Text
                  style={[
                    styles.tabText,
                    { color: activeTab === tab ? colors.tint : colors.textSecondary },
                  ]}
                  >
                  {tab === 'history' ? 'History' : 'Live Terminal'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {!selected && activeTab === 'history' && renderList()}
        {!selected && activeTab === 'live' && renderLiveList()}

        {selected && (
          <View style={styles.flex}>
            {detailLoading ? (
              <View style={styles.centerView}>
                <ActivityIndicator size="small" color={colors.tint} />
                <Text style={[styles.dimText, { color: colors.textSecondary }]}>
                  Loading transcript…
                </Text>
              </View>
            ) : detailError ? (
              <View style={styles.centerView}>
                <Text style={[styles.emptyText, { color: colors.destructive }]}>{detailError}</Text>
              </View>
            ) : (
              <>
                <FlatList
                  data={detailMessages}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={styles.detailContent}
                  renderItem={({ item }) => (
                    <ChatMessageView message={item} workingDirectory={selected.cwd} />
                  )}
                  ListHeaderComponent={
                    <View style={styles.detailHeader}>
                      <Text style={[styles.detailProvider, { color: colors.tint }]}>
                        {providerDisplayName(selected.provider)}
                      </Text>
                      <Text style={[styles.detailMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                        {selected.cwd ?? 'unknown dir'}
                      </Text>
                      <Text style={[styles.detailId, { color: colors.textSecondary }]} numberOfLines={1}>
                        {selected.id}
                      </Text>
                    </View>
                  }
                  ListEmptyComponent={
                    <View style={styles.centerView}>
                      <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                        Transcript is empty or could not be rendered.
                      </Text>
                    </View>
                  }
                />
                <Pressable
                  style={[styles.continueBar, { backgroundColor: colors.tint }]}
                  onPress={() => onResume(selected, detailMessages)}
                >
                  <Text style={styles.continueText}>Continue this session</Text>
                </Pressable>
              </>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: FontSize.lg, fontWeight: '700', flex: 1, textAlign: 'center' },
  headerButton: { fontSize: FontSize.md, fontWeight: '600' },
  headerButtonRight: { minWidth: 70, alignItems: 'flex-end' },
  listContent: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowContent: { flex: 1, marginRight: Spacing.sm },
  rowTopLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: 6,
  },
  providerPill: {
    fontSize: FontSize.xs,
    fontWeight: '700',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  rowPreview: { fontSize: FontSize.md, fontWeight: '500', lineHeight: 20 },
  rowMeta: { fontSize: FontSize.xs, marginTop: 4 },
  chevron: { fontSize: FontSize.xl, fontWeight: '400' },
  centerView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    paddingHorizontal: Spacing.xxl,
    gap: Spacing.sm,
  },
  dimText: { fontSize: FontSize.sm, textAlign: 'center' },
  emptyText: { fontSize: FontSize.md, textAlign: 'center', lineHeight: 22 },
  detailContent: { paddingVertical: Spacing.sm, paddingBottom: 80 },
  detailHeader: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  detailProvider: { fontSize: FontSize.xs, fontWeight: '700', marginBottom: 4 },
  detailMeta: { fontSize: FontSize.xs },
  detailId: { fontSize: FontSize.xs, marginTop: 2 },
  sourceHeader: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sourceTitle: { fontSize: FontSize.md, fontWeight: '700' },
  sourceMeta: { fontSize: FontSize.xs, marginTop: 4, lineHeight: 16 },
  continueBar: {
    position: 'absolute',
    bottom: Spacing.lg,
    left: Spacing.lg,
    right: Spacing.lg,
    borderRadius: 12,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  continueText: { color: '#fff', fontSize: FontSize.md, fontWeight: '700' },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  tabText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  liveRowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
});
