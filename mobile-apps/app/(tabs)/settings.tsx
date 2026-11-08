import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Alert,
  StyleSheet,
  TextInput,
  TouchableOpacity,
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
import {
  listAiProviders,
  previewAiModels,
  createAiProvider,
  testAiProvider,
  deleteAiProvider,
} from '@/services/api/endpoints';
import type { ApiAiProviderConfig } from '@/services/api/contracts';

export default function SettingsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { preference, setPreference } = useThemePreference();
  const { session, activeServer, logout, apiClient } = useAuth();
  const { syncStatus, outbox, runSync } = useSync();

  const [resyncing, setResyncing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // --- Pocket Diary AI providers (keys live encrypted on the server) ---
  const [aiConfigs, setAiConfigs] = useState<ApiAiProviderConfig[]>([]);
  const [aiVaultConfigured, setAiVaultConfigured] = useState(true);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAddOpen, setAiAddOpen] = useState(false);
  const [aiProvider, setAiProvider] = useState('openai');
  const [aiLabel, setAiLabel] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [aiModelsStatus, setAiModelsStatus] = useState('');

  // A debounced, account-scoped lookup with the typed key. Older requests
  // cannot replace a newer provider's model choices after a fast switch.
  React.useEffect(() => {
    let cancelled = false;
    const key = aiKey.trim();
    if (!aiAddOpen || !apiClient || key.length < 8) return;
    const timer = setTimeout(async () => {
      if (!cancelled) setAiModelsStatus('Checking available models…');
      try {
        const res = await previewAiModels(apiClient, aiProvider, key);
        if (cancelled) return;
        const options = [...new Set(res.models.map((model) => model.id).filter(Boolean))];
        setAiModels(options);
        setAiModelsStatus(options.length
          ? `${options.length} models available. Select one below or enter an ID manually.`
          : 'The provider returned no models. Enter the model ID manually.');
      } catch {
        if (cancelled) return;
        setAiModels([]);
        setAiModelsStatus('Could not fetch models. Check the key, then use manual entry if needed.');
      }
    }, 900);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [apiClient, aiAddOpen, aiProvider, aiKey]);

  const refreshAiProviders = React.useCallback(async () => {
    if (!apiClient) return;
    try {
      const res = await listAiProviders(apiClient);
      setAiConfigs(res.configs);
      setAiVaultConfigured(res.vault?.configured ?? true);
    } catch {
      // Offline or server without AI support — show the section with what we know.
    }
  }, [apiClient]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await refreshAiProviders();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAiProviders]);

  const handleAddAiProvider = async () => {
    if (!apiClient || !aiModel.trim() || aiKey.trim().length < 8) {
      setStatusMessage('Enter a model ID and an API key (min 8 characters).');
      return;
    }
    setAiBusy(true);
    try {
      await createAiProvider(apiClient, {
        provider: aiProvider,
        label: aiLabel.trim() || aiProvider,
        modelId: aiModel.trim(),
        apiKey: aiKey.trim(),
      });
      setAiKey('');
      setAiLabel('');
      setAiModel('');
      setAiAddOpen(false);
      setStatusMessage('AI provider added. Key stored encrypted on the server.');
      await refreshAiProviders();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Could not add AI provider');
    } finally {
      setAiBusy(false);
    }
  };

  const handleTestAiProvider = async (config: ApiAiProviderConfig) => {
    if (!apiClient) return;
    setAiBusy(true);
    try {
      const result = await testAiProvider(apiClient, config.id);
      setStatusMessage(`${config.label}: ${result.ok ? '✓' : '✗'} ${result.message}`);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setAiBusy(false);
    }
  };

  const handleDeleteAiProvider = (config: ApiAiProviderConfig) => {
    Alert.alert(
      'Delete provider configuration?',
      `The encrypted key for ${config.label} will be removed from the server. Chats stay.`,
      [
        { text: 'Cancel', style: 'cancel' as const },
        {
          text: 'Delete',
          style: 'destructive' as const,
          onPress: () => {
            void (async () => {
              if (!apiClient) return;
              setAiBusy(true);
              try {
                await deleteAiProvider(apiClient, config.id);
                await refreshAiProviders();
                setStatusMessage('AI provider deleted.');
              } catch (err) {
                setStatusMessage(err instanceof Error ? err.message : 'Delete failed');
              } finally {
                setAiBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const handleRetryFailed = async () => {
    setRetrying(true);
    setStatusMessage(null);
    try {
      outbox.retryFailedOps();
      const res = await runSync();
      setStatusMessage(`Retry complete: ${res.pushed} pushed, ${res.errors} failed.`);
    } catch (err) {
      setStatusMessage(`Sync failed: ${err instanceof Error ? err.message : 'unknown error'}`);
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
    } catch (err) {
      setStatusMessage(`Full sync failed: ${err instanceof Error ? err.message : 'unknown error'}`);
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

        {/* Pocket Diary AI — providers (BYOK, keys encrypted server-side) */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSubtle, fontSize: theme.font.caption }]}>
          AI PROVIDERS
        </Text>
        <Card style={{ marginBottom: theme.spacing.lg, padding: 0 }}>
          {!aiVaultConfigured ? (
            <ListRow
              icon="warning-outline"
              title="AI credentials disabled"
              subtitle="The server has no AI_CREDENTIAL_ENCRYPTION_KEY configured."
              showChevron={false}
            />
          ) : aiConfigs.length === 0 ? (
            <ListRow
              icon="sparkles-outline"
              title="No AI providers yet"
              subtitle="Add an API key to enable the AI assistant."
              showChevron={false}
            />
          ) : (
            aiConfigs.map((config) => (
              <ListRow
                key={config.id}
                icon="sparkles-outline"
                title={`${config.provider} — ${config.label}${config.isDefault ? ' (default)' : ''}`}
                subtitle={`${config.modelId} · key •••• ${config.keyLast4}`}
                onPress={() => void handleTestAiProvider(config)}
                rightElement={
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${config.label}`}
                    onPress={() => handleDeleteAiProvider(config)}
                    hitSlop={8}
                    style={{ paddingHorizontal: 8 }}
                  >
                    <Ionicons name="trash-outline" size={18} color={theme.colors.danger} />
                  </TouchableOpacity>
                }
              />
            ))
          )}
          <View style={{ padding: theme.spacing.md, gap: theme.spacing.sm }}>
            {aiAddOpen ? (
              <>
                <Text style={{ color: theme.colors.text }}>Provider</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {([
                    ['openai', 'OpenAI'], ['gemini', 'Gemini'],
                    ['deepseek', 'DeepSeek'], ['nvidia_nim', 'NVIDIA NIM'],
                  ] as const).map(([id, label]) => (
                    <TouchableOpacity
                      key={id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: aiProvider === id }}
                      onPress={() => {
                        if (aiProvider === id) return;
                        setAiProvider(id);
                        setAiKey('');
                        setAiModel('');
                        setAiModels([]);
                        setAiModelsStatus('Enter your API key to load models automatically.');
                      }}
                      style={{
                        paddingHorizontal: 12, paddingVertical: 9,
                        borderRadius: 10, borderWidth: 1,
                        borderColor: aiProvider === id ? theme.colors.primary : theme.colors.border,
                        backgroundColor: aiProvider === id ? theme.colors.primary + '18' : 'transparent',
                      }}
                    >
                      <Text style={{ color: theme.colors.text }}>{label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  value={aiLabel}
                  onChangeText={setAiLabel}
                  placeholder="Label (e.g. Work key)"
                  placeholderTextColor={theme.colors.textSubtle}
                  style={[aiInputStyle.aiInput, { borderColor: theme.colors.border, color: theme.colors.text }]}
                />
                <TextInput
                  value={aiModel}
                  onChangeText={setAiModel}
                  placeholder="Model ID (e.g. gpt-4o-mini)"
                  placeholderTextColor={theme.colors.textSubtle}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[aiInputStyle.aiInput, { borderColor: theme.colors.border, color: theme.colors.text }]}
                />
                <TextInput
                  value={aiKey}
                  onChangeText={(value) => {
                    setAiKey(value);
                    setAiModels([]);
                    setAiModelsStatus(value.trim().length < 8
                      ? 'Enter your API key to load models automatically.'
                      : 'Will check available models after typing…');
                  }}
                  placeholder="API key (typed once, stored encrypted)"
                  placeholderTextColor={theme.colors.textSubtle}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  style={[aiInputStyle.aiInput, { borderColor: theme.colors.border, color: theme.colors.text }]}
                />
                <Text style={{ color: theme.colors.textSubtle, fontSize: 12 }}>
                  {aiModelsStatus || 'Enter a key to load the available models.'}
                </Text>
                {aiModels.length > 0 && (
                  <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 3 }}>
                      {aiModels.slice(0, 80).map((model) => (
                        <TouchableOpacity
                          key={model}
                          accessibilityRole="button"
                          accessibilityLabel={`Choose AI model ${model}`}
                          accessibilityState={{ selected: aiModel === model }}
                          onPress={() => setAiModel(model)}
                          style={{
                            borderWidth: 1, borderRadius: 9,
                            borderColor: aiModel === model ? theme.colors.primary : theme.colors.border,
                            backgroundColor: aiModel === model ? theme.colors.primary + '18' : 'transparent',
                            paddingVertical: 9, paddingHorizontal: 11,
                          }}
                        >
                          <Text style={{ color: theme.colors.text, fontSize: 12 }}>{model}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                )}
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Button title={aiBusy ? 'Saving…' : 'Save'} variant="primary" size="sm" onPress={() => void handleAddAiProvider()} disabled={aiBusy} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button title="Cancel" variant="ghost" size="sm" onPress={() => setAiAddOpen(false)} />
                  </View>
                </View>
              </>
            ) : (
              <Button
                title="Add AI provider"
                variant="outline"
                size="sm"
                icon={<Ionicons name="add" size={16} color={theme.colors.primary} />}
                onPress={() => setAiAddOpen(true)}
                disabled={!aiVaultConfigured}
              />
            )}
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

const aiInputStyle = StyleSheet.create({
  aiInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
});

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
