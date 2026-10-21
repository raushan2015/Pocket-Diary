import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/features/auth/AuthContext';
import { useTheme } from '@/theme/ThemeProvider';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Banner } from '@/components/ui/Banner';

export default function LoginScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { activeServer, login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setError(null);

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }

    if (!password) {
      setError('Please enter your password.');
      return;
    }

    setLoading(true);
    try {
      await login({ email: trimmedEmail, password });
      router.replace('/(tabs)/notes');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to sign in.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { padding: theme.spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Server indicator bar */}
        <Pressable
          onPress={() => router.push('/server-setup')}
          accessibilityRole="button"
          accessibilityLabel="Change configured server"
          style={[
            styles.serverBadge,
            {
              backgroundColor: theme.colors.surfaceAlt,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.pill,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: 6,
              marginBottom: theme.spacing.xl,
            },
          ]}
        >
          <Ionicons name="server-outline" size={14} color={theme.colors.primary} style={{ marginRight: 6 }} />
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.textSubtle,
              fontSize: theme.font.caption,
              fontWeight: theme.weight.medium,
              flexShrink: 1,
            }}
          >
            {activeServer?.url || 'No server connected'}
          </Text>
          <Text
            style={{
              color: theme.colors.primary,
              fontSize: theme.font.caption,
              fontWeight: theme.weight.semibold,
              marginLeft: 6,
            }}
          >
            Change
          </Text>
        </Pressable>

        {/* Title */}
        <Text
          style={[
            styles.title,
            {
              color: theme.colors.text,
              fontSize: theme.font.title1,
              fontWeight: theme.weight.bold,
              marginBottom: theme.spacing.xs,
            },
          ]}
        >
          Welcome Back
        </Text>
        <Text
          style={[
            styles.subtitle,
            {
              color: theme.colors.textSubtle,
              fontSize: theme.font.body,
              marginBottom: theme.spacing.xl,
            },
          ]}
        >
          Sign in to access your synchronized notes.
        </Text>

        {error ? (
          <Banner
            variant="error"
            title="Sign In Failed"
            message={error}
            style={{ marginBottom: theme.spacing.lg }}
          />
        ) : null}

        {/* Form */}
        <Card style={{ marginBottom: theme.spacing.xl }}>
          <TextField
            label="Email Address"
            placeholder="name@example.com"
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              setError(null);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            leftIcon="mail-outline"
            clearable
          />

          <TextField
            label="Password"
            placeholder="Enter your password"
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setError(null);
            }}
            isPassword
            leftIcon="lock-closed-outline"
            onSubmitEditing={handleLogin}
            returnKeyType="done"
          />

          <Button
            title="Sign In"
            onPress={handleLogin}
            loading={loading}
            size="lg"
            style={{ marginTop: theme.spacing.sm }}
          />
        </Card>

        {/* Register footer link */}
        <View style={styles.footerRow}>
          <Text style={{ color: theme.colors.textSubtle, fontSize: theme.font.body }}>
            {"Don't have an account? "}
          </Text>
          <Pressable onPress={() => router.push('/auth/register')}>
            <Text
              style={{
                color: theme.colors.primary,
                fontSize: theme.font.body,
                fontWeight: theme.weight.semibold,
              }}
            >
              Create Account
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  serverBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    borderWidth: 1,
  },
  title: {
    letterSpacing: -0.5,
  },
  subtitle: {
    letterSpacing: 0.1,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
