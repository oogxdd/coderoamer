import { Stack } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { Redirect } from 'expo-router';

export default function AppLayout() {
  const { isAuthenticated, isLoading } = useAuth();

  if (!isLoading && !isAuthenticated) {
    return <Redirect href="/auth" />;
  }

  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{ title: 'Sprites', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="sprite/[name]"
        // The screen toggles gestureEnabled off while a conversation or a
        // settings sub-view is open, so the edge swipe steps back one level
        // instead of popping straight out to the sprite list.
        options={{ headerShown: false, gestureEnabled: true }}
      />
      <Stack.Screen
        name="settings"
        options={{ title: 'Settings' }}
      />
      <Stack.Screen
        name="guide"
        options={{ title: 'Guides', headerShown: false }}
      />
      <Stack.Screen
        name="exec-poc"
        options={{ title: 'Terminal', headerShown: false }}
      />
      <Stack.Screen
        name="ttyd-terminal"
        options={{ title: 'Web Terminal (ttyd)' }}
      />
      <Stack.Screen
        name="claude-login"
        options={{ title: 'Claude Login' }}
      />
    </Stack>
  );
}
