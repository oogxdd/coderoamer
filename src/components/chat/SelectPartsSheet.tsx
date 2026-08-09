import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { Fonts, FontSize, Spacing } from '@/constants/theme';
import { joinParts } from '@/services/message-text';

interface SelectPartsSheetProps {
  title: string;
  /** Paragraphs and whole code blocks, in rendered order. */
  parts: string[];
  onCopy: (text: string) => void;
  onQuote: (text: string) => void;
  onClose: () => void;
}

/** A fenced block arrives already re-fenced by `quotableParts`. */
function isCode(part: string): boolean {
  return part.startsWith('```');
}

function stripFence(part: string): string {
  return part.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
}

/**
 * Picks a subset of one message to copy or quote. Selection is by rendered part
 * (paragraph, or a whole code block) rather than by character range: it survives
 * on every platform, and it matches the pieces the bubble actually drew.
 *
 * Part text is also `selectable`, so a native character-level selection inside a
 * single paragraph still works for anyone who wants it.
 */
export function SelectPartsSheet({
  title,
  parts,
  onCopy,
  onQuote,
  onClose,
}: SelectPartsSheetProps) {
  const colors = useTheme();
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const toggle = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectedText = useMemo(
    () => joinParts([...selected].sort((a, b) => a - b).map((i) => parts[i])),
    [parts, selected]
  );
  const hasSelection = selected.size > 0;
  const allSelected = selected.size === parts.length && parts.length > 0;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={[styles.headerButton, { color: colors.tint }]}>Close</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {title}
          </Text>
          <Pressable
            onPress={() =>
              setSelected(allSelected ? new Set() : new Set(parts.map((_, i) => i)))
            }
            hitSlop={12}
            accessibilityRole="button"
          >
            <Text style={[styles.headerButton, { color: colors.tint }]}>
              {allSelected ? 'None' : 'All'}
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {hasSelection
            ? `${selected.size} of ${parts.length} selected`
            : 'Tap the parts you want to copy or quote.'}
        </Text>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {parts.map((part, index) => {
            const on = selected.has(index);
            const code = isCode(part);
            return (
              <Pressable
                key={index}
                style={[
                  styles.part,
                  {
                    borderColor: on ? colors.tint : colors.border,
                    backgroundColor: on ? colors.backgroundSelected : colors.card,
                  },
                ]}
                onPress={() => toggle(index)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
              >
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: on ? colors.tint : colors.border,
                      backgroundColor: on ? colors.tint : 'transparent',
                    },
                  ]}
                >
                  {on && <Text style={styles.checkmark}>✓</Text>}
                </View>
                <Text
                  selectable
                  style={[
                    code ? styles.partCode : styles.partText,
                    { color: code ? colors.textSecondary : colors.text },
                  ]}
                >
                  {code ? stripFence(part) : part}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Pressable
            style={[
              styles.footerButton,
              { borderColor: colors.border, opacity: hasSelection ? 1 : 0.4 },
            ]}
            disabled={!hasSelection}
            onPress={() => onCopy(selectedText)}
            accessibilityRole="button"
          >
            <Text style={[styles.footerButtonText, { color: colors.text }]}>Copy</Text>
          </Pressable>
          <Pressable
            style={[
              styles.footerButton,
              { backgroundColor: colors.tint, borderColor: colors.tint, opacity: hasSelection ? 1 : 0.4 },
            ]}
            disabled={!hasSelection}
            onPress={() => onQuote(selectedText)}
            accessibilityRole="button"
          >
            <Text style={[styles.footerButtonText, styles.footerButtonPrimaryText]}>Quote</Text>
          </Pressable>
        </View>
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
    gap: Spacing.md,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    flexShrink: 1,
  },
  headerButton: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  hint: {
    fontSize: FontSize.xs,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  part: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    borderWidth: 1,
    borderRadius: 10,
    padding: Spacing.md,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkmark: {
    color: '#FFFFFF',
    fontSize: FontSize.xs,
    fontWeight: '900',
  },
  partText: {
    flex: 1,
    fontSize: FontSize.md,
    lineHeight: 21,
  },
  partCode: {
    flex: 1,
    fontFamily: Fonts?.mono ?? 'monospace',
    fontSize: FontSize.sm,
    lineHeight: 19,
  },
  footer: {
    flexDirection: 'row',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xxl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderRadius: 12,
    borderWidth: 1,
  },
  footerButtonText: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  footerButtonPrimaryText: {
    color: '#FFFFFF',
  },
});
