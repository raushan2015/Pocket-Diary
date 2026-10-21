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
import { useAuth } from '@/features/auth/AuthContext';
import { useTheme } from '@/theme/ThemeProvider';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Banner } from '@/components/ui/Banner';

export default function RegisterScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { register } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegister = async () => {
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Please enter your name.');
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }

    setLoading(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      await register({
        name: trimmedName,
        email: trimmedEmail,
        password,
        timezone,
      });
      router.replace('/(tabs)/notes');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed.';
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
          Create Account
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
          Set up a new profile on your Pocket Diary instance.
        </Text>

        {error ? (
          <Banner
            variant="error"
            title="Registration Failed"
            message={error}
            style={{ marginBottom: theme.spacing.lg }}
          />
        ) : null}

        <Card style={{ marginBottom: theme.spacing.xl }}>
          <TextField
            label="Full Name"
            placeholder="Alice Chen"
            value={name}
            onChangeText={(t) => {
              setName(t);
              setError(null);
            }}
            autoCapitalize="words"
            leftIcon="person-outline"
          />

          <TextField
            label="Email Address"
            placeholder="alice@example.com"
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
            label="Password (min 8 chars)"
            placeholder="Create a strong password"
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setError(null);
            }}
            isPassword
            leftIcon="lock-closed-outline"
            onSubmitEditing={handleRegister}
            returnKeyType="done"
          />

          <Button
            title="Create Account"
            onPress={handleRegister}
            loading={loading}
            size="lg"
            style={{ marginTop: theme.spacing.sm }}
          />
        </Card>

        <View style={styles.footerRow}>
          <Text style={{ color: theme.colors.textSubtle, fontSize: theme.font.body }}>
            Already have an account?{' '}
          </Text>
          <Pressable onPress={() => router.back()}>
            <Text
              style={{
                color: theme.colors.primary,
                fontSize: theme.font.body,
                fontWeight: theme.weight.semibold,
              }}
            >
              Sign In
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
