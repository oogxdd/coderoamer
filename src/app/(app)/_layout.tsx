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
    </Stack>
  );
}
