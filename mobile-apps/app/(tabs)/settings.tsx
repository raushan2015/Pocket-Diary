import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Alert,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/features/auth/AuthContext';
import { useSync } from '@/features/sync/SyncContext';
import { useTheme, useThemePreference } from '@/theme/ThemeProvider';
import { ListRow } from '@/components/ui/ListRow';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Banner } from '@/components/ui/Banner';
import { relativeTime } from '@/utils/time';

export default function SettingsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { preference, setPreference } = useThemePreference();
  const { session, activeServer, logout } = useAuth();
  const { syncStatus, outbox, runSync } = useSync();

  const [resyncing, setResyncing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const handleRetryFailed = async () => {
    setRetrying(true);
    setStatusMessage(null);
    try {
      outbox.retryFailedOps();
      const res = await runSync();
      setStatusMessage(`Retry complete: ${res.pushed} pushed, ${res.errors} failed.`);
    } finally {
      setRetrying(false);
    }
  };

  const handleForceFullSync = async () => {
    setResyncing(true);
    setStatusMessage(null);
    try {
      const res = await runSync({ fullReconciliation: true });
      setStatusMessage(`Full sync complete: ${res.pulled} pulled from server.`);
    } finally {
      setResyncing(false);
    }
  };

  const handleSignOut = () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out? Unsynchronized local changes will remain stored safely on your device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/auth/login');
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: theme.colors.bg }]}>
      <View
        style={[
          styles.headerBar,
          {
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
            paddingHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <Text
          style={[
            styles.headerTitle,
            { color: theme.colors.text, fontSize: theme.font.title2, fontWeight: theme.weight.bold },
          ]}
        >
          Settings
        </Text>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { padding: theme.spacing.lg }]}>
        {statusMessage ? (
          <Banner
            variant="info"
            message={statusMessage}
            onDismiss={() => setStatusMessage(null)}
            style={{ marginBottom: theme.spacing.md }}
          />
        ) : null}

        {/* Server Section */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSubtle, fontSize: theme.font.caption }]}>
          POCKET DIARY SERVER
        </Text>
        <Card style={{ marginBottom: theme.spacing.lg, padding: 0 }}>
          <ListRow
            icon="server-outline"
            title="Instance URL"
            value={activeServer?.url || 'None'}
            onPress={() => router.push('/server-setup')}
          />
          <ListRow
            icon="shield-checkmark-outline"
            title="Protocol"
            value={activeServer?.url.startsWith('https://') ? 'HTTPS (Encrypted)' : 'HTTP (Plain)'}
            showChevron={false}
          />
          <ListRow
            icon="git-branch-outline"
            title="Capabilities"
            value={activeServer?.capabilities?.memoClientId ? 'Idempotent Sync (Modern)' : 'Standard'}
            showChevron={false}
          />
          <View style={{ padding: theme.spacing.md }}>
            <Button
              title="Change Server"
              variant="outline"
              size="sm"
              onPress={() => router.push('/server-setup')}
            />
          </View>
        </Card>

        {/* Account Profile */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSubtle, fontSize: theme.font.caption }]}>
          USER ACCOUNT
        </Text>
        <Card style={{ marginBottom: theme.spacing.lg, padding: 0 }}>
          <ListRow
            icon="person-outline"
            title="Signed in as"
            subtitle={session?.user.email}
            value={session?.user.name}
            showChevron={false}
          />
          <ListRow
            icon="folder-outline"
            title="Active Workspace"
            value={session?.workspaces.find((w) => w.id === session.activeWorkspaceId)?.name || 'Default'}
            showChevron={false}
          />
        </Card>

        {/* Synchronization & Offline Outbox */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSubtle, fontSize: theme.font.caption }]}>
          SYNCHRONIZATION & STORAGE
        </Text>
        <Card style={{ marginBottom: theme.spacing.lg, padding: 0 }}>
          <ListRow
            icon="time-outline"
            title="Pending Outbox Operations"
            value={String(syncStatus.pendingCount)}
            showChevron={false}
          />
          <ListRow
            icon="alert-circle-outline"
            title="Failed Operations"
            value={String(syncStatus.failedCount)}
            destructive={syncStatus.failedCount > 0}
            showChevron={false}
          />
          <ListRow
            icon="sync-outline"
            title="Last Synchronized"
            value={syncStatus.lastSyncAt ? relativeTime(syncStatus.lastSyncAt) : 'Never'}
            showChevron={false}
          />
          <View style={{ padding: theme.spacing.md, gap: 8 }}>
            {syncStatus.failedCount > 0 ? (
              <Button
                title="Retry Failed Mutations"
                variant="secondary"
                size="sm"
                loading={retrying}
                onPress={handleRetryFailed}
              />
            ) : null}
            <Button
              title="Force Full Resync"
              variant="outline"
              size="sm"
              loading={resyncing}
              onPress={handleForceFullSync}
            />
          </View>
        </Card>

        {/* Theme Appearance */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSubtle, fontSize: theme.font.caption }]}>
          APPEARANCE
        </Text>
        <Card style={{ marginBottom: theme.spacing.lg, padding: 0 }}>
          <ListRow
            icon="phone-portrait-outline"
            title="System Default"
            rightElement={
              preference === 'system' ? (
                <Ionicons name="checkmark" size={20} color={theme.colors.primary} />
              ) : null
            }
            onPress={() => setPreference('system')}
          />
          <ListRow
            icon="sunny-outline"
            title="Light Theme"
            rightElement={
              preference === 'light' ? (
                <Ionicons name="checkmark" size={20} color={theme.colors.primary} />
              ) : null
            }
            onPress={() => setPreference('light')}
          />
          <ListRow
            icon="moon-outline"
            title="Dark Theme"
            rightElement={
              preference === 'dark' ? (
                <Ionicons name="checkmark" size={20} color={theme.colors.primary} />
              ) : null
            }
            onPress={() => setPreference('dark')}
          />
        </Card>

        {/* Sign Out Button */}
        <View style={{ marginTop: theme.spacing.md, marginBottom: 40 }}>
          <Button
            title="Sign Out"
            variant="destructive"
            size="lg"
            onPress={handleSignOut}
            icon={<Ionicons name="log-out-outline" size={20} color="#FFFFFF" />}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  headerBar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
  },
  headerTitle: {
    letterSpacing: -0.5,
  },
  content: {
    paddingBottom: 40,
  },
  sectionTitle: {
    letterSpacing: 0.5,
    fontWeight: '700',
    marginBottom: 8,
    marginLeft: 4,
  },
});
