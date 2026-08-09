import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

interface UserBubbleProps {
  text: string;
  /** Long-press to open the message actions sheet (copy, quote, resend). */
  onLongPress?: () => void;
}

export function UserBubble({ text, onLongPress }: UserBubbleProps) {
  const colors = useTheme();

  return (
    <View style={styles.container}>
      <Pressable
        style={[styles.bubble, { backgroundColor: colors.userBubble }]}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityRole={onLongPress ? 'button' : undefined}
        accessibilityHint={onLongPress ? 'Long press for copy and quote actions' : undefined}
      >
        <Text style={[styles.text, { color: colors.userBubbleText }]}>{text}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-end',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xs,
  },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: 18,
    borderBottomRightRadius: 4,
  },
  text: {
    fontSize: FontSize.md,
    lineHeight: 20,
  },
});
