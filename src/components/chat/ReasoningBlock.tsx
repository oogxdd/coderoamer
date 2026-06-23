import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing, Fonts } from '@/constants/theme';

interface ReasoningBlockProps {
  text: string;
  /** True while this reasoning is still streaming in (shows a live hint). */
  streaming?: boolean;
}

/**
 * Renders Claude's extended-thinking ("reasoning") as a compact, dim inline
 * block with a short preview. Tapping opens the full reasoning in a modal —
 * the "see what's happening inside" view, kept out of the main answer flow.
 */
export function ReasoningBlock({ text, streaming }: ReasoningBlockProps) {
  const colors = useTheme();
  const [modalVisible, setModalVisible] = useState(false);

  const trimmed = text.trim();
  if (!trimmed) return null;

  // Last couple of lines read as the "current thought" while streaming.
  const preview = trimmed.split('\n').filter(Boolean).slice(-2).join('\n');

  return (
    <>
      <Pressable
        style={({ pressed }) => [
          styles.container,
          { borderColor: colors.border, backgroundColor: colors.backgroundElement },
          pressed && { opacity: 0.7 },
        ]}
        onPress={() => setModalVisible(true)}
      >
        <View style={styles.headerRow}>
          <Text style={[styles.label, { color: colors.textSecondary }]}>
            {streaming ? '💭 Thinking…' : '💭 Reasoning'}
          </Text>
          <Text style={[styles.expandHint, { color: colors.tint }]}>view ›</Text>
        </View>
        <Text style={[styles.preview, { color: colors.textSecondary }]} numberOfLines={2}>
          {preview}
        </Text>
      </Pressable>

      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Reasoning</Text>
            <Pressable onPress={() => setModalVisible(false)} hitSlop={12}>
              <Text style={[styles.closeButton, { color: colors.tint }]}>Done</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <Text style={[styles.fullText, { color: colors.text }]} selectable>
              {trimmed}
            </Text>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: Spacing.lg,
    marginVertical: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
    maxWidth: '90%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  label: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  expandHint: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
  preview: {
    fontSize: FontSize.sm,
    fontStyle: 'italic',
    lineHeight: 18,
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: {
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  closeButton: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: Spacing.lg,
  },
  fullText: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    fontFamily: Fonts?.mono ?? 'monospace',
  },
});
