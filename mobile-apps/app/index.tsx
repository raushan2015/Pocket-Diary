import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/features/auth/AuthContext';
import { useTheme } from '@/theme/ThemeProvider';

export default function IndexScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { isReady, activeServer, session } = useAuth();

  useEffect(() => {
    if (!isReady) return;

    if (!activeServer) {
      router.replace('/server-setup');
    } else if (!session) {
      router.replace('/auth/login');
    } else {
      router.replace('/(tabs)/notes');
    }
  }, [isReady, activeServer, session, router]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.bg }]}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
