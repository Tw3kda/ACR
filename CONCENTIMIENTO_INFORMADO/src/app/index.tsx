import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useAuth } from '@/store/authStore';

export default function Index() {
  const { token, isLoading } = useAuth();

  // Wait for the saved session before deciding: otherwise every launch would
  // flash the login screen.
  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return <Redirect href={token ? '/(app)/consent' : '/(auth)/login'} />;

}
