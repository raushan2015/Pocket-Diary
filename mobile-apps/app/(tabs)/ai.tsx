/**
 * Pocket Diary AI — native chat tab (offline-aware, server-persisted).
 *
 * Security/privacy (handoff §7):
 *  - Provider API keys NEVER touch the device: configurations are managed
 *    server-side through the same authenticated endpoints as the web app.
 *  - All note access requires explicit, server-validated, short-lived grants
 *    ("Ask AI about this note" — user-initiated per note).
 *  - Offline: AI needs the network. Notes stay available offline; the chat
 *    shows a clear offline message instead of a broken spinner, and failed
 *    prompts are never silently queued for later upload (they could carry
 *    secrets the user typed).
 *  - Cross-user/workspace switching resets the in-memory conversation state.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/features/auth/AuthContext';
import { useSync } from '@/features/sync/SyncContext';
import { useTheme } from '@/theme/ThemeProvider';
import { Button } from '@/components/ui/Button';
import {
  listAiProviders,
  listAiConversations,
  createAiConversation,
  getAiConversation,
  sendAiMessage,
  getAiRequest,
  cancelAiRequest,
  grantCurrentNoteToConversation,
} from '@/services/api/endpoints';
import type { ApiAiProviderConfig, ApiAiMessage, ApiAiConversation } from '@/services/api/contracts';

type PollState = { requestId: string; cancelled: boolean };

export default function AiChatScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, apiClient: authApiClient } = useAuth();
  const { notesRepo } = useSync();
  const apiClient = authApiClient;
  const params = useLocalSearchParams<{ noteId?: string }>();

  const [configs, setConfigs] = useState<ApiAiProviderConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ApiAiConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ApiAiMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const pollRef = useRef<PollState | null>(null);
  const listRef = useRef<FlatList<ApiAiMessage>>(null);

  const activeWorkspaceId = session?.activeWorkspaceId ?? '';
  const pendingNoteId = typeof params.noteId === 'string' ? params.noteId : null;

  const loadAll = useCallback(async () => {
    if (!apiClient || !activeWorkspaceId) return;
    setError(null);
    try {
      const providers = await listAiProviders(apiClient);
      setConfigs(providers.configs);
      setSelectedConfigId((prev) => prev ?? providers.configs.find((c) => c.isDefault)?.id ?? providers.configs[0]?.id ?? null);
      const convs = await listAiConversations(apiClient, activeWorkspaceId);
      setConversations(convs.conversations);
      setOffline(false);
    } catch (err) {
      if (err instanceof Error && /network|connect|timed?\s*out/i.test(err.message)) {
        setOffline(true);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load AI settings');
      }
    }
  }, [apiClient, activeWorkspaceId]);

  // Load on mount and on workspace/account switch. State resets happen after
  // an await boundary (not synchronously in the effect body) so a workspace
  // switch can never cross-contaminate chat state.
  const lastScopeRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      const scopeKey = `${session?.user?.id ?? ''}:${activeWorkspaceId}`;
      if (lastScopeRef.current !== null && lastScopeRef.current !== scopeKey) {
        setConversationId(null);
        setMessages([]);
        setHistoryOpen(false);
        pollRef.current = null;
        setSelectedConfigId(null);
      }
      lastScopeRef.current = scopeKey;
      await loadAll();
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, session?.user?.id, loadAll]);

  const openConversation = useCallback(
    async (id: string | null) => {
      if (!apiClient) return;
      setHistoryOpen(false);
      try {
        if (!id) {
          const created = await createAiConversation(apiClient, activeWorkspaceId);
          id = created.id;
        }
        setConversationId(id);
        const detail = await getAiConversation(apiClient, id);
        setMessages(detail.messages);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to open conversation');
      }
    },
    [apiClient, activeWorkspaceId],
  );

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    if (conversationId) return conversationId;
    if (!apiClient) return null;
    const created = await createAiConversation(apiClient, activeWorkspaceId);
    setConversationId(created.id);
    return created.id;
  }, [apiClient, conversationId, activeWorkspaceId]);

  const refreshMessages = useCallback(
    async (id: string) => {
      if (!apiClient) return;
      const detail = await getAiConversation(apiClient, id);
      setMessages(detail.messages);
    },
    [apiClient],
  );

  const pollToCompletion = useCallback(
    async (requestId: string, convId: string) => {
      const state = { requestId, cancelled: false };
      pollRef.current = state;
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (state.cancelled) return;
        await new Promise((r) => setTimeout(r, 1500));
        if (!apiClient || state.cancelled) return;
        try {
          const request = await getAiRequest(apiClient, requestId);
          if (['complete', 'failed', 'interrupted', 'canceled'].includes(request.status)) {
            await refreshMessages(convId);
            if (request.status === 'failed' || request.status === 'interrupted') {
              setError(request.errorMessage ?? 'Generation failed — send again.');
            }
            setBusy(false);
            return;
          }
        } catch (err) {
          if (err instanceof Error && /network|connect|timed?\s*out/i.test(err.message)) {
            setOffline(true);
            setBusy(false);
            return;
          }
          // transient parse errors: keep polling
        }
      }
      setBusy(false);
      setError('Still generating — reopen to check again.');
    },
    [apiClient, refreshMessages],
  );

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || busy || !apiClient) return;
    setError(null);
    setBusy(true);
    try {
      const convId = await ensureConversation();
      if (!convId) throw new Error('Could not start a conversation');
      const mode = pendingNoteId ? 'note_task' : 'general';
      let currentNoteGrantId: string | null = null;
      if (mode === 'note_task') {
        // Explicit user action per note; the server validates policy and TTL.
        const grant = await grantCurrentNoteToConversation(apiClient, {
          workspaceId: activeWorkspaceId,
          memoId: pendingNoteId!,
          conversationId: convId,
          purpose: 'note_task',
        });
        currentNoteGrantId = grant.grantId;
      }
      const result = await sendAiMessage(apiClient, convId, {
        content,
        clientMessageId: `rn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode,
        currentNoteGrantId,
        providerConfigId: selectedConfigId,
      });
      setDraft('');
      await refreshMessages(convId);
      setBusy(false);
      void pollToCompletion(result.request.id, convId);
    } catch (err) {
      setBusy(false);
      const message = err instanceof Error ? err.message : 'Failed to send';
      if (/network|connect|timed?\s*out/i.test(message)) {
        setOffline(true);
        // Do NOT queue this prompt: the user may have typed something private.
        setError('You are offline. AI needs a connection — your message was not sent or stored.');
      } else {
        setError(message);
      }
    }
  }, [draft, busy, apiClient, ensureConversation, pendingNoteId, activeWorkspaceId, selectedConfigId, refreshMessages, pollToCompletion]);

  const handleCancel = useCallback(async () => {
    const poll = pollRef.current;
    if (!poll || !apiClient) return;
    poll.cancelled = true;
    try {
      await cancelAiRequest(apiClient, poll.requestId);
    } catch { /* best-effort */ }
    setBusy(false);
    if (conversationId) void refreshMessages(conversationId);
  }, [apiClient, conversationId, refreshMessages]);

  const pendingNote = pendingNoteId && activeWorkspaceId
    ? notesRepo.listNotes({ workspaceId: activeWorkspaceId, limit: 400 }).notes.find((n) => n.id === pendingNoteId) ?? null
    : null;

  const styles = makeStyles(theme);
  const bg = theme.colors.bg;
  const surface = theme.colors.surface;
  const ink = theme.colors.text;
  const subtle = theme.colors.textSubtle;
  const border = theme.colors.border;

  return (
    <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: bg }]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: surface, borderBottomColor: border }]}>
          <Text style={[styles.headerTitle, { color: ink }]}>Pocket Diary AI</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Conversation history"
            onPress={() => setHistoryOpen((v) => !v)}
            style={styles.headerBtn}
          >
            <Ionicons name="time-outline" size={22} color={ink} />
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="New chat"
            onPress={() => void openConversation(null)}
            style={styles.headerBtn}
          >
            <Ionicons name="add-circle-outline" size={22} color={ink} />
          </TouchableOpacity>
        </View>

        {/* Scope / privacy indicator */}
        <View style={[styles.scopeRow, { borderBottomColor: border }]}>
          <Ionicons
            name={pendingNote ? 'lock-open-outline' : 'shield-checkmark-outline'}
            size={13}
            color={pendingNote ? theme.colors.primary : subtle}
          />
          <Text style={[styles.scopeText, { color: subtle }]} numberOfLines={1}>
            {pendingNote
              ? `Current note: ${pendingNote?.title || 'Untitled'} — shared only for your explicit request`
              : 'General chat — no notes shared'}
          </Text>
        </View>

        {offline ? (
          <View style={styles.centerWrap}>
            <Ionicons name="cloud-offline-outline" size={40} color={subtle} />
            <Text style={[styles.offlineTitle, { color: ink }]}>You are offline</Text>
            <Text style={[styles.offlineBody, { color: subtle }]}>
              The AI assistant needs a connection. Your notes stay available offline — nothing you typed was queued or sent.
            </Text>
            <Button title="Retry" onPress={() => void loadAll()} />
          </View>
        ) : configs.length === 0 ? (
          <View style={styles.centerWrap}>
            <Ionicons name="sparkles-outline" size={40} color={subtle} />
            <Text style={[styles.offlineTitle, { color: ink }]}>No AI provider configured</Text>
            <Text style={[styles.offlineBody, { color: subtle }]}>
              Add an API key in Settings → AI Providers. Keys are stored encrypted on your server, never on this device.
            </Text>
          </View>
        ) : (
          <>
            {/* History dropdown */}
            {historyOpen ? (
              <View style={[styles.historyPanel, { backgroundColor: surface, borderColor: border }]}>
                <FlatList
                  data={conversations}
                  keyExtractor={(c) => c.id}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      onPress={() => void openConversation(item.id)}
                      style={[styles.historyItem, { borderBottomColor: border }]}
                    >
                      <Text style={{ color: item.id === conversationId ? theme.colors.primary : ink }} numberOfLines={1}>
                        {item.title || 'New chat'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  ListEmptyComponent={<Text style={{ color: subtle, padding: 12 }}>No conversations yet.</Text>}
                />
              </View>
            ) : null}

            {/* Messages */}
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(m) => m.id}
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
              contentContainerStyle={styles.messageList}
              renderItem={({ item }) => (
                <View
                  style={[
                    styles.bubble,
                    item.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
                    { backgroundColor: item.role === 'user' ? theme.colors.primary : surface },
                  ]}
                >
                  <Text style={{ color: item.role === 'user' ? '#fff' : ink, fontSize: 15, lineHeight: 21 }}>
                    {item.content}
                  </Text>
                  {item.status === 'interrupted' || item.status === 'failed' ? (
                    <Text style={[styles.msgStatus, { color: '#f59e0b' }]}>
                      Interrupted — nothing fake shown. Send again to retry.
                    </Text>
                  ) : null}
                </View>
              )}
              ListEmptyComponent={
                <View style={styles.emptyWrap}>
                  <Text style={{ color: subtle, textAlign: 'center' }}>
                    {pendingNote
                      ? 'Ask about the open note — its content is only shared for your explicit request.'
                      : 'Brainstorm, plan, ask anything. No notes are shared in general chat.'}
                  </Text>
                </View>
              }
            />

            {error ? (
              <Text style={[styles.errorText, { color: theme.colors.danger }]}>{error}</Text>
            ) : null}

            {/* Composer */}
            <View style={[styles.composer, { backgroundColor: surface, borderTopColor: border }]}>
              <View style={styles.providerRow}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Switch AI provider"
                  onPress={() => router.push('/(tabs)/settings')}
                  style={styles.providerChip}
                >
                  <Ionicons name="swap-horizontal" size={14} color={subtle} />
                  <Text style={{ color: subtle, fontSize: 12 }} numberOfLines={1}>
                    {configs.find((c) => c.id === selectedConfigId)?.modelId ?? 'Select provider'}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={styles.composerRow}>
                <TextInput
                  style={[styles.input, { backgroundColor: bg, color: ink, borderColor: border }]}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="Ask, brainstorm, plan…"
                  placeholderTextColor={subtle}
                  multiline
                  editable={!busy}
                />
                {busy ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => void handleCancel()} style={styles.sendBtn}>
                    <Ionicons name="stop" size={22} color={theme.colors.danger} />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Send" onPress={() => void handleSend()} style={styles.sendBtn} disabled={!draft.trim()}>
                    <Ionicons name="send" size={20} color={draft.trim() ? theme.colors.primary : subtle} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (theme: ReturnType<typeof useTheme>) =>
  StyleSheet.create({
    safeArea: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
      borderBottomWidth: 1,
      gap: theme.spacing.sm,
    },
    headerTitle: { fontSize: theme.font.headline, fontWeight: theme.weight.semibold, flex: 1 },
    headerBtn: { padding: 4 },
    scopeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 6,
      borderBottomWidth: 1,
    },
    scopeText: { fontSize: 12, flexShrink: 1 },
    historyPanel: {
      marginHorizontal: theme.spacing.lg,
      marginTop: theme.spacing.sm,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      maxHeight: 220,
    },
    historyItem: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
    messageList: { padding: theme.spacing.lg, gap: theme.spacing.sm },
    bubble: { maxWidth: '88%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
    bubbleUser: { alignSelf: 'flex-end', borderBottomRightRadius: 4 },
    bubbleAssistant: { alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
    msgStatus: { fontSize: 11, marginTop: 4 },
    emptyWrap: { padding: theme.spacing.xl },
    errorText: { paddingHorizontal: theme.spacing.lg, paddingBottom: 4, fontSize: 12 },
    composer: { borderTopWidth: 1, padding: theme.spacing.md, gap: 6 },
    providerRow: { flexDirection: 'row' },
    providerChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: theme.radii.pill,
      borderWidth: 1,
      borderColor: theme.colors.border,
      maxWidth: '100%',
    },
    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm },
    input: {
      flex: 1,
      minHeight: 42,
      maxHeight: 120,
      borderRadius: theme.radii.md,
      borderWidth: 1,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 15,
    },
    sendBtn: { padding: 8 },
    centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.md, padding: theme.spacing.xl },
    offlineTitle: { fontSize: theme.font.title3, fontWeight: theme.weight.semibold },
    offlineBody: { textAlign: 'center', fontSize: theme.font.callout },
  });
