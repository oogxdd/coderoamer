import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export default function ActivityScreen() {
  const colors = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundSecondary }]}>
      <Text style={[styles.title, { color: colors.text }]}>Agent activity</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        Claude and Codex sessions across all of your Sprites will appear here.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xxl,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '700',
    marginBottom: Spacing.sm,
  },
  body: {
    fontSize: FontSize.md,
    lineHeight: 22,
    textAlign: 'center',
  },
});
