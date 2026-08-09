import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

export interface MessageAction {
  key: string;
  label: string;
  /** Second line explaining what the action produces. */
  detail?: string;
  destructive?: boolean;
  onPress: () => void;
}

interface MessageActionsSheetProps {
  title: string;
  /** Up to a few lines of the message, so it's clear which one is being acted on. */
  preview?: string;
  actions: MessageAction[];
  onClose: () => void;
}

/** Matches the fade-out of the backdrop; see the note on the action press. */
const DISMISS_MS = 220;

/**
 * Bottom sheet of actions for one chat message (copy, quote, share a part).
 * Opened by long-pressing a bubble. Dismisses on backdrop tap, and every action
 * closes it — these are all one-shot commands.
 */
export function MessageActionsSheet({
  title,
  preview,
  actions,
  onClose,
}: MessageActionsSheetProps) {
  const colors = useTheme();

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Dismiss">
        {/* Stop taps inside the card from closing the sheet. */}
        <Pressable
          style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => {}}
        >
          <View style={[styles.grabber, { backgroundColor: colors.border }]} />
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          {preview ? (
            <Text style={[styles.preview, { color: colors.textSecondary }]} numberOfLines={3}>
              {preview}
            </Text>
          ) : null}

          <ScrollView style={styles.actions} bounces={false}>
            {actions.map((action) => (
              <Pressable
                key={action.key}
                style={({ pressed }) => [
                  styles.actionRow,
                  {
                    borderColor: colors.border,
                    backgroundColor: pressed ? colors.backgroundSelected : 'transparent',
                  },
                ]}
                onPress={() => {
                  onClose();
                  // Let this modal finish dismissing before the action runs.
                  // Actions that present another modal ("Select part…") race the
                  // dismissal on iOS and can end up presenting nothing at all;
                  // it also keeps the copy toast from appearing behind the sheet.
                  setTimeout(action.onPress, DISMISS_MS);
                }}
                accessibilityRole="button"
                accessibilityLabel={action.label}
              >
                <View style={styles.actionText}>
                  <Text
                    style={[
                      styles.actionLabel,
                      { color: action.destructive ? colors.destructive : colors.text },
                    ]}
                  >
                    {action.label}
                  </Text>
                  {action.detail ? (
                    <Text style={[styles.actionDetail, { color: colors.textSecondary }]}>
                      {action.detail}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable
            style={[styles.cancel, { backgroundColor: colors.backgroundElement }]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={[styles.cancelText, { color: colors.tint }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  card: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xxl,
    maxHeight: '70%',
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: Spacing.md,
  },
  title: {
    fontSize: FontSize.md,
    fontWeight: '700',
  },
  preview: {
    fontSize: FontSize.sm,
    lineHeight: 18,
    marginTop: Spacing.xs,
  },
  actions: {
    marginTop: Spacing.md,
  },
  actionRow: {
    paddingVertical: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionText: {
    flex: 1,
  },
  actionLabel: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  actionDetail: {
    fontSize: FontSize.xs,
    marginTop: 2,
  },
  cancel: {
    marginTop: Spacing.md,
    paddingVertical: Spacing.md,
    borderRadius: 12,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
});
