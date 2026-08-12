import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { router, Tabs } from 'expo-router';
import { FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface TabIconProps {
  color: string;
  symbol: string;
}

function TabIcon({ color, symbol }: TabIconProps) {
  return <Text style={[styles.tabIcon, { color }]}>{symbol}</Text>;
}

export default function MainTabsLayout() {
  const colors = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.backgroundSecondary },
        tabBarActiveTintColor: colors.tint,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
        },
        tabBarLabelStyle: styles.tabLabel,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Sprites',
          tabBarIcon: ({ color }) => <TabIcon color={color} symbol="▦" />,
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/(app)/guide')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Open guides"
            >
              <Text style={[styles.headerAction, { color: colors.tint }]}>Guides</Text>
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: ({ color }) => <TabIcon color={color} symbol="◉" />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <TabIcon color={color} symbol="⚙" />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabIcon: {
    fontSize: 20,
    lineHeight: 22,
  },
  tabLabel: {
    fontSize: FontSize.xs,
    fontWeight: '600',
  },
  headerAction: {
    fontSize: FontSize.md,
    fontWeight: '600',
    marginRight: Spacing.lg,
  },
});
