import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Modal,
} from 'react-native';
import { ToolUseCard, toolResultDisplayContent } from '@/models/chat';
import { jsonPretty } from '@/models/claude-events';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing, Fonts } from '@/constants/theme';

interface ToolDetailSheetProps {
  card: ToolUseCard;
  onClose: () => void;
}

export function ToolDetailSheet({ card, onClose }: ToolDetailSheetProps) {
  const colors = useTheme();

  const inputText = jsonPretty(card.input);
  const resultText = card.result ? toolResultDisplayContent(card.result) : null;
  const outputText = resultText ?? card.liveOutput ?? null;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.text }]}>{card.toolName}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={[styles.closeButton, { color: colors.tint }]}>Done</Text>
          </Pressable>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>INPUT</Text>
          <View style={[styles.codeBlock, { backgroundColor: colors.backgroundElement }]}>
            <Text
              style={[
                styles.codeText,
                { color: colors.text, fontFamily: Fonts?.mono ?? 'monospace' },
              ]}
              selectable
            >
              {inputText}
            </Text>
          </View>

          {outputText && (
            <>
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                {resultText ? 'RESULT' : 'LIVE OUTPUT'}
              </Text>
              <View style={[styles.codeBlock, { backgroundColor: colors.backgroundElement }]}>
                <Text
                  style={[
                    styles.codeText,
                    { color: colors.text, fontFamily: Fonts?.mono ?? 'monospace' },
                  ]}
                  selectable
                >
                  {outputText}
                </Text>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
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
  sectionTitle: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
    marginTop: Spacing.lg,
  },
  codeBlock: {
    borderRadius: 8,
    padding: Spacing.md,
  },
  codeText: {
    fontSize: FontSize.sm,
    lineHeight: 18,
  },
});
