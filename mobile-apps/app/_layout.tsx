import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View, StyleSheet, Text } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { getPlatformServices, type PlatformServices } from '@/services/platform';
import { ThemeProvider, useTheme } from '@/theme/ThemeProvider';
import { AuthProvider } from '@/features/auth/AuthContext';
import { SyncProvider } from '@/features/sync/SyncContext';

function RootNavigation() {
  const theme = useTheme();

  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: theme.colors.surface,
          },
          headerTintColor: theme.colors.text,
          headerTitleStyle: {
            fontWeight: theme.weight.bold,
            fontSize: theme.font.headline,
          },
          headerShadowVisible: false,
          contentStyle: {
            backgroundColor: theme.colors.bg,
          },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="server-setup"
          options={{
            title: 'Server Setup',
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="auth/login"
          options={{
            title: 'Sign In',
            headerBackVisible: false,
          }}
        />
        <Stack.Screen
          name="auth/register"
          options={{
            title: 'Create Account',
          }}
        />
        <Stack.Screen
          name="(tabs)"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="note/[id]"
          options={{
            title: '',
            headerBackTitle: 'Notes',
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [services, setServices] = useState<PlatformServices | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPlatformServices()
      .then((s) => {
        if (!cancelled) setServices(s);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Failed to initialize app storage</Text>
        <Text style={styles.errorMessage}>{error}</Text>
      </View>
    );
  }

  if (!services) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#4F46E5" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider prefs={services.prefs}>
        <AuthProvider services={services}>
          <SyncProvider services={services}>
            <RootNavigation />
          </SyncProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0B0B0E',
    padding: 24,
  },
  errorTitle: {
    color: '#F87171',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  errorMessage: {
    color: '#A1A1AA',
    fontSize: 14,
    textAlign: 'center',
  },
});
