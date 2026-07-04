import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import React from 'react';
import { useColorScheme } from 'react-native';
import { AuthProvider } from '@/contexts/AuthContext';
import { ConnectionsProvider } from '@/contexts/ConnectionsContext';

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <ConnectionsProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="auth" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="(app)" />
          </Stack>
        </ConnectionsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
