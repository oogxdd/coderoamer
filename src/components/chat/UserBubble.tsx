import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

interface UserBubbleProps {
  text: string;
}

export function UserBubble({ text }: UserBubbleProps) {
  const colors = useTheme();

  return (
    <View style={styles.container}>
      <View style={[styles.bubble, { backgroundColor: colors.userBubble }]}>
        <Text style={[styles.text, { color: colors.userBubbleText }]}>{text}</Text>
      </View>
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
