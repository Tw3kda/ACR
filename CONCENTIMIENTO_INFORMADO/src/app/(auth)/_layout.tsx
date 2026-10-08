import { Redirect, Stack } from 'expo-router';

import { useAuth } from '@/store/authStore';

export default function AuthLayout() {
  const { token, isLoading } = useAuth();

  if (isLoading) return null;
  if (token) {
    return <Redirect href="/(app)/consent" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
