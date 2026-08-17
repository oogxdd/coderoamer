import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface BlockingOverlayAction {
  label: string;
  onPress: () => void;
  /** Renders as the filled primary button. */
  primary?: boolean;
}

interface BlockingOverlayProps {
  title: string;
  subtitle?: string;
  /** Hide the spinner (e.g. when the operation failed and awaits a decision). */
  busy?: boolean;
  actions?: BlockingOverlayAction[];
}

/**
 * Full-screen "you can't do anything yet" cover.
 *
 * Used while a Sprite wakes: until it's up, every control on the screen would
 * fail anyway, so the screen says so plainly instead of letting taps queue into
 * errors. `onStartShouldSetResponder` is what makes it actually block — a plain
 * View doesn't claim touches, and they'd fall through to the screen beneath.
 */
export function BlockingOverlay({ title, subtitle, busy = true, actions }: BlockingOverlayProps) {
  const colors = useTheme();

  return (
    <View
      style={[styles.overlay, { backgroundColor: colors.background + 'F2' }]}
      onStartShouldSetResponder={() => true}
      accessibilityViewIsModal
      accessibilityLabel={title}
    >
      <View style={styles.content}>
        {busy ? <ActivityIndicator size="large" color={colors.tint} /> : null}
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
        ) : null}
        {actions && actions.length > 0 ? (
          <View style={styles.actions}>
            {actions.map((action) => (
              <Pressable
                key={action.label}
                style={({ pressed }) => [
                  styles.button,
                  {
                    backgroundColor: action.primary ? colors.tint : colors.backgroundElement,
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}
                onPress={action.onPress}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.buttonText,
                    { color: action.primary ? '#FFFFFF' : colors.text },
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
    zIndex: 10,
  },
  content: {
    alignItems: 'center',
    gap: Spacing.sm,
    maxWidth: 380,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: Spacing.sm,
  },
  subtitle: {
    fontSize: FontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.lg,
  },
  button: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderRadius: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
});
