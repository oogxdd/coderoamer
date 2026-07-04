import { Stack } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { useConnections } from '@/contexts/ConnectionsContext';
import { Redirect } from 'expo-router';

export default function AppLayout() {
  const { isAuthenticated, isLoading } = useAuth();
  const { hasAnyConnection, isLoading: connectionsLoading } = useConnections();

  // Reachable if the user has a Sprites token (legacy gate) OR any connection
  // at all — a custom-VPS-only user (no Sprites account) is still authenticated.
  if (!isLoading && !connectionsLoading && !isAuthenticated && !hasAnyConnection) {
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
        options={{ headerShown: false }}
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
