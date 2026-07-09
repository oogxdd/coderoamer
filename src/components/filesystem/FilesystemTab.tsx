import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Modal,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as api from '@/services/api';
import { SpriteFileEntry } from '@/services/api';
import {
  MAX_PREVIEW_BYTES,
  decodeUtf8,
  formatBytes,
  looksLikeText,
  parentPath,
  uploadFileToSpriteDir,
} from '@/services/sprite-filesystem';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Fonts, Spacing } from '@/constants/theme';

interface PreviewState {
  entry: SpriteFileEntry;
  loading: boolean;
  error?: string;
  text?: string;
  isBinary?: boolean;
  tooLarge?: boolean;
}

function entryIcon(entry: SpriteFileEntry): string {
  if (entry.isDir) return '📁';
  if (entry.isSymlink) return '🔗';
  return '📄';
}

export function FilesystemTab({
  spriteName,
  workingDirectory,
}: {
  spriteName: string;
  workingDirectory: string;
}) {
  const colors = useTheme();
  const initialPath = workingDirectory || '/';
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [listing, setListing] = useState<api.SpriteDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const result = await api.listSpriteDirectory(spriteName, path);
        setListing(result);
        setCurrentPath(result.path || path);
      } catch (err) {
        setError((err as Error).message || 'Failed to list directory');
        setListing(null);
        setCurrentPath(path);
      } finally {
        setLoading(false);
      }
    },
    [spriteName]
  );

  useEffect(() => {
    load(initialPath);
    // Load the starting directory once when the tab mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPreview = useCallback(
    async (entry: SpriteFileEntry) => {
      if (entry.size > MAX_PREVIEW_BYTES) {
        setPreview({ entry, loading: false, tooLarge: true });
        return;
      }
      setPreview({ entry, loading: true });
      try {
        const content = await api.readSpriteFile(spriteName, entry.path);
        if (looksLikeText(content.bytes)) {
          setPreview({ entry, loading: false, text: decodeUtf8(content.bytes) });
        } else {
          setPreview({ entry, loading: false, isBinary: true });
        }
      } catch (err) {
        setPreview({ entry, loading: false, error: (err as Error).message || 'Failed to read file' });
      }
    },
    [spriteName]
  );

  const handleEntryPress = useCallback(
    (entry: SpriteFileEntry) => {
      if (entry.isDir) {
        load(entry.path);
      } else {
        openPreview(entry);
      }
    },
    [load, openPreview]
  );

  const handleUpload = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      setUploading(true);
      setError(undefined);
      await uploadFileToSpriteDir(spriteName, currentPath, {
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        file: asset.file,
      });
      await load(currentPath);
    } catch (err) {
      Alert.alert('Upload failed', (err as Error).message || 'Could not upload the file.');
    } finally {
      setUploading(false);
    }
  }, [spriteName, currentPath, load]);

  const atRoot = currentPath === '/' || currentPath === '';

  return (
    <View style={styles.flex}>
      {/* Toolbar: up + current path + upload */}
      <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.backgroundSecondary }]}>
        <Pressable
          onPress={() => load(parentPath(currentPath))}
          disabled={atRoot || loading}
          hitSlop={8}
          style={styles.upButton}
        >
          <Text style={[styles.upButtonText, { color: atRoot ? colors.textSecondary : colors.tint }]}>↑ Up</Text>
        </Pressable>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pathScroll}
          style={styles.pathScrollContainer}
        >
          <Text style={[styles.pathText, { color: colors.text }]} numberOfLines={1}>
            {currentPath}
          </Text>
        </ScrollView>
        <Pressable
          onPress={handleUpload}
          disabled={uploading}
          hitSlop={8}
          style={[styles.uploadButton, { borderColor: colors.tint }]}
        >
          {uploading ? (
            <ActivityIndicator size="small" color={colors.tint} />
          ) : (
            <Text style={[styles.uploadButtonText, { color: colors.tint }]}>⤒ Upload</Text>
          )}
        </Pressable>
      </View>

      {error && (
        <View style={[styles.errorBar, { backgroundColor: colors.destructive + '15' }]}>
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        </View>
      )}

      {loading && !listing ? (
        <View style={styles.centerView}>
          <ActivityIndicator size="large" color={colors.tint} />
        </View>
      ) : (
        <FlatList
          data={listing?.entries ?? []}
          keyExtractor={(item) => item.path}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => load(currentPath)} tintColor={colors.tint} />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            !loading ? (
              <View style={styles.emptyView}>
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                  {error ? 'Could not load this directory.' : 'This directory is empty.'}
                </Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.row,
                { borderBottomColor: colors.border, backgroundColor: pressed ? colors.backgroundSelected : 'transparent' },
              ]}
              onPress={() => handleEntryPress(item)}
            >
              <Text style={styles.rowIcon}>{entryIcon(item)}</Text>
              <View style={styles.rowText}>
                <Text style={[styles.rowName, { color: colors.text }]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={[styles.rowMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                  {item.isDir ? 'Directory' : formatBytes(item.size)}
                  {item.mode ? ` · ${item.mode}` : ''}
                </Text>
              </View>
              <Text style={[styles.rowChevron, { color: colors.textSecondary }]}>
                {item.isDir ? '›' : ''}
              </Text>
            </Pressable>
          )}
        />
      )}

      {preview && (
        <FilePreviewModal
          state={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </View>
  );
}

function FilePreviewModal({ state, onClose }: { state: PreviewState; onClose: () => void }) {
  const colors = useTheme();
  const { entry } = state;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent={false}>
      <SafeAreaView style={[styles.modalRoot, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.modalClose}>
            <Text style={[styles.modalCloseText, { color: colors.tint }]}>Done</Text>
          </Pressable>
          <View style={styles.modalTitleWrap}>
            <Text style={[styles.modalTitle, { color: colors.text }]} numberOfLines={1}>
              {entry.name}
            </Text>
            <Text style={[styles.modalSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
              {formatBytes(entry.size)}
              {entry.mode ? ` · ${entry.mode}` : ''}
            </Text>
          </View>
          <View style={styles.modalClose} />
        </View>

        {state.loading ? (
          <View style={styles.centerView}>
            <ActivityIndicator size="large" color={colors.tint} />
          </View>
        ) : state.error ? (
          <View style={styles.centerView}>
            <Text style={[styles.previewNote, { color: colors.destructive }]}>{state.error}</Text>
          </View>
        ) : state.tooLarge ? (
          <View style={styles.centerView}>
            <Text style={[styles.previewNote, { color: colors.textSecondary }]}>
              File is {formatBytes(entry.size)} — too large to preview here.
            </Text>
          </View>
        ) : state.isBinary ? (
          <View style={styles.centerView}>
            <Text style={[styles.previewNote, { color: colors.textSecondary }]}>
              Binary file ({formatBytes(entry.size)}). Preview is only available for text files.
            </Text>
          </View>
        ) : (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.previewContent}
            horizontal={false}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <Text style={[styles.previewText, { color: colors.text }]} selectable>
                {state.text}
              </Text>
            </ScrollView>
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  upButton: {
    paddingVertical: Spacing.xs,
    paddingRight: Spacing.xs,
  },
  upButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  pathScrollContainer: {
    flex: 1,
  },
  pathScroll: {
    alignItems: 'center',
    minWidth: '100%',
  },
  pathText: {
    fontSize: FontSize.sm,
    fontFamily: Fonts?.mono,
  },
  uploadButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    minWidth: 74,
    minHeight: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadButtonText: {
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
  errorBar: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  errorText: {
    fontSize: FontSize.sm,
  },
  centerView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  listContent: {
    flexGrow: 1,
    paddingBottom: Spacing.xxl,
  },
  emptyView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: FontSize.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.md,
  },
  rowIcon: {
    fontSize: FontSize.lg,
    width: 26,
    textAlign: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowName: {
    fontSize: FontSize.md,
    fontWeight: '500',
  },
  rowMeta: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  rowChevron: {
    fontSize: FontSize.lg,
    fontWeight: '400',
  },
  modalRoot: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalClose: {
    width: 60,
  },
  modalCloseText: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  modalTitleWrap: {
    flex: 1,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: FontSize.md,
    fontWeight: '700',
  },
  modalSubtitle: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  previewContent: {
    padding: Spacing.lg,
  },
  previewText: {
    fontSize: FontSize.sm,
    fontFamily: Fonts?.mono,
    lineHeight: 18,
  },
  previewNote: {
    fontSize: FontSize.md,
    textAlign: 'center',
    lineHeight: 22,
  },
});
