import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  Pressable,
  StyleSheet,
  ScrollView,
  Modal,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/features/auth/AuthContext';
import { useSync } from '@/features/sync/SyncContext';
import { useTheme } from '@/theme/ThemeProvider';
import { NoteCard } from '@/components/notes/NoteCard';
import { Chip } from '@/components/ui/Chip';
import { Banner } from '@/components/ui/Banner';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoteCardSkeleton } from '@/components/ui/Skeleton';
import type { Note } from '@/features/notes/types';

type FilterType = 'all' | 'pinned' | 'favorites' | 'checklists' | 'archived' | 'trash';

export default function NotesScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, switchWorkspace } = useAuth();
  const { notesRepo, outbox, syncStatus, isOnline, runSync } = useSync();

  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [workspaceModalVisible, setWorkspaceModalVisible] = useState(false);

  const activeWorkspaceId = session?.activeWorkspaceId || '';

  // Local-first list: derived synchronously from SQLite (no state cascade).
  // A bump counter re-derives after local mutations (restore, empty trash);
  // sync completions arrive via syncStatus deps.
  const [dataBump, setDataBump] = useState(0);
  const bumpData = () => setDataBump((c) => c + 1);

  const notes: Note[] = useMemo(() => {
    if (!activeWorkspaceId) return [];
    switch (activeFilter) {
      case 'all':
        return notesRepo.listNotes({ workspaceId: activeWorkspaceId }).notes;
      case 'pinned':
        return notesRepo.listNotes({ workspaceId: activeWorkspaceId, isPinned: true }).notes;
      case 'favorites':
        return notesRepo.listNotes({ workspaceId: activeWorkspaceId, isFavorite: true }).notes;
      case 'checklists':
        return notesRepo.listNotes({ workspaceId: activeWorkspaceId, noteType: 'checklist' }).notes;
      case 'archived':
        return notesRepo.listNotes({ workspaceId: activeWorkspaceId, isArchived: true }).notes;
      case 'trash':
        return notesRepo.listNotes({ workspaceId: activeWorkspaceId, deletedOnly: true }).notes;
    }
    // The deps below are deliberate invalidation triggers for the
    // SQLite-derived data (sync completions + local mutations); they are not
    // referenced inside the callback because the repository reads the DB.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesRepo, activeWorkspaceId, activeFilter, syncStatus.lastSyncAt, syncStatus.pendingCount, syncStatus.failedCount, dataBump]);

  // Skeletons only while a first sync is actually running.
  const loading = notes.length === 0 && syncStatus.isSyncing;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await runSync();
    } finally {
      setRefreshing(false);
    }
  };

  const handleRestore = (note: Note) => {
    const restored = notesRepo.restoreNote(note.id);
    outbox.enqueue({
      entity: 'note',
      noteId: restored.id,
      op: 'restore',
      payload: { serverId: restored.serverId },
    });
    void runSync().catch(() => {});
    bumpData();
  };

  const handleEmptyTrash = () => {
    Alert.alert(
      'Empty Trash',
      'All notes in the trash will be erased permanently, on this device and on the server.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Empty Trash',
          style: 'destructive',
          onPress: () => {
            const trashed = notesRepo.listNotes({ workspaceId: activeWorkspaceId, deletedOnly: true }).notes;
            for (const n of trashed) {
              if (n.serverId) {
                outbox.enqueue({
                  entity: 'note',
                  noteId: n.id,
                  op: 'delete',
                  payload: { serverId: n.serverId, permanent: true },
                });
              } else {
                outbox.removeNoteOps(n.id);
              }
            }
            notesRepo.emptyTrash(activeWorkspaceId);
            void runSync().catch(() => {});
            bumpData();
          },
        },
      ],
    );
  };

  const activeWorkspace = session?.workspaces.find((w) => w.id === activeWorkspaceId);

  const pinnedNotes = activeFilter === 'all' ? notes.filter((n) => n.isPinned) : [];
  const unpinnedNotes = activeFilter === 'all' ? notes.filter((n) => !n.isPinned) : notes;

  return (
    <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: theme.colors.bg }]}>
      {/* Workspace Selector Bar */}
      <View
        style={[
          styles.workspaceBar,
          {
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
            paddingHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <Pressable
          onPress={() => setWorkspaceModalVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Switch active workspace"
          style={styles.workspaceButton}
        >
          <Ionicons name="folder-outline" size={18} color={theme.colors.primary} style={{ marginRight: 6 }} />
          <Text
            numberOfLines={1}
            style={[
              styles.workspaceName,
              { color: theme.colors.text, fontSize: theme.font.headline, fontWeight: theme.weight.bold },
            ]}
          >
            {activeWorkspace?.name || 'Workspace'}
          </Text>
          <Ionicons name="chevron-down" size={16} color={theme.colors.textSubtle} style={{ marginLeft: 4 }} />
        </Pressable>

        <Pressable
          onPress={handleRefresh}
          accessibilityLabel="Refresh and synchronize"
          accessibilityRole="button"
          style={styles.syncIconButton}
        >
          <Ionicons
            name={syncStatus.isSyncing ? 'sync' : 'cloud-done-outline'}
            size={20}
            color={syncStatus.isSyncing ? theme.colors.primary : theme.colors.textSubtle}
          />
        </Pressable>
      </View>

      {/* Connectivity & Sync Banners */}
      <View style={{ paddingHorizontal: theme.spacing.lg }}>
        {!isOnline ? (
          <Banner
            variant="warning"
            message="Working offline. All changes are saved locally and will sync when connected."
          />
        ) : syncStatus.failedCount > 0 ? (
          <Banner
            variant="error"
            title="Sync Issue"
            message={`${syncStatus.failedCount} change(s) pending retry.`}
            actionLabel="View in Settings"
            onAction={() => router.push('/(tabs)/settings')}
          />
        ) : null}
      </View>

      {/* Filter Chips Bar */}
      <View style={styles.filterBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: 8, maxWidth: 720, alignSelf: 'center', width: '100%' }}
        >
          <Chip
            label="All Notes"
            selected={activeFilter === 'all'}
            onPress={() => setActiveFilter('all')}
            size="sm"
          />
          <Chip
            label="Pinned"
            icon="pin"
            selected={activeFilter === 'pinned'}
            onPress={() => setActiveFilter('pinned')}
            size="sm"
          />
          <Chip
            label="Favorites"
            icon="heart"
            selected={activeFilter === 'favorites'}
            onPress={() => setActiveFilter('favorites')}
            size="sm"
          />
          <Chip
            label="Checklists"
            icon="checkbox-outline"
            selected={activeFilter === 'checklists'}
            onPress={() => setActiveFilter('checklists')}
            size="sm"
          />
          <Chip
            label="Archive"
            icon="archive-outline"
            selected={activeFilter === 'archived'}
            onPress={() => setActiveFilter('archived')}
            size="sm"
          />
          <Chip
            label="Trash"
            icon="trash-outline"
            selected={activeFilter === 'trash'}
            onPress={() => setActiveFilter('trash')}
            size="sm"
          />
        </ScrollView>
        {activeFilter === 'trash' && notes.length > 0 ? (
          <Pressable
            onPress={handleEmptyTrash}
            accessibilityRole="button"
            accessibilityLabel="Empty trash permanently"
            hitSlop={8}
            style={[styles.emptyTrashBtn, { borderColor: theme.colors.danger, borderRadius: theme.radii.pill, alignSelf: 'center' }]}
          >
            <Ionicons name="trash" size={14} color={theme.colors.danger} style={{ marginRight: 4 }} />
            <Text style={{ color: theme.colors.danger, fontSize: theme.font.caption, fontWeight: theme.weight.semibold }}>
              Empty Trash
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Notes List */}
      {loading ? (
        <View style={{ padding: theme.spacing.lg }}>
          <NoteCardSkeleton />
          <NoteCardSkeleton />
          <NoteCardSkeleton />
        </View>
      ) : notes.length === 0 ? (
        <View style={{ flex: 1, maxWidth: 720, width: '100%', alignSelf: 'center' }}>
          <EmptyState
            icon={
              activeFilter === 'trash'
                ? 'trash-outline'
                : activeFilter === 'archived'
                ? 'archive-outline'
                : 'create-outline'
            }
            title={
              activeFilter === 'trash'
                ? 'Trash is empty'
                : activeFilter === 'archived'
                ? 'No archived notes'
                : 'No notes yet'
            }
            description={
              activeFilter === 'trash'
                ? 'Deleted notes land here first — open a trashed note to restore it.'
                : activeFilter === 'archived'
                ? 'Notes you archive will appear here.'
                : 'Tap the button below to jot down your first note or checklist.'
            }
            actionLabel={activeFilter === 'all' ? 'Create Note' : undefined}
            onAction={() => router.push('/note/new')}
          />
        </View>
      ) : (
        <FlatList
          data={unpinnedNotes}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.listContent, { padding: theme.spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
          ListHeaderComponent={
            activeFilter === 'trash'
              ? (
                  <Banner
                    variant="info"
                    message="Open a trashed note to restore or permanently delete it."
                    style={{ marginBottom: theme.spacing.md }}
                  />
                )
              : pinnedNotes.length > 0
              ? (
                  <View style={{ marginBottom: theme.spacing.md }}>
                    <Text
                  style={[
                    styles.sectionHeader,
                    {
                      color: theme.colors.textSubtle,
                      fontSize: theme.font.caption,
                      fontWeight: theme.weight.bold,
                      marginBottom: theme.spacing.sm,
                    },
                  ]}
                >
                  PINNED
                </Text>
                {pinnedNotes.map((n) => (
                  <NoteCard
                    key={n.id}
                    note={n}
                    onPress={() => router.push(`/note/${n.id}`)}
                  />
                ))}
                <Text
                  style={[
                    styles.sectionHeader,
                    {
                      color: theme.colors.textSubtle,
                      fontSize: theme.font.caption,
                      fontWeight: theme.weight.bold,
                      marginTop: theme.spacing.md,
                      marginBottom: theme.spacing.sm,
                    },
                  ]}
                >
                  OTHERS
                </Text>
                </View>
              ) : undefined
          }
          renderItem={({ item }) => (
            <View>
              <NoteCard
                note={item}
                onPress={() => router.push(`/note/${item.id}`)}
                onLongPress={
                  activeFilter === 'trash'
                    ? () => handleRestore(item)
                    : undefined
                }
              />
              {activeFilter === 'trash' ? (
                <Pressable
                  onPress={() => handleRestore(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Restore ${item.title || 'note'}`}
                  hitSlop={6}
                  style={[styles.restoreRow, { borderTopColor: theme.colors.border }]}
                >
                  <Ionicons name="refresh" size={16} color={theme.colors.primary} style={{ marginRight: 6 }} />
                  <Text style={{ color: theme.colors.primary, fontSize: theme.font.caption, fontWeight: theme.weight.semibold }}>
                    Restore
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}
        />
      )}

      {/* Floating Action Button (FAB) */}
      <View style={styles.fabContainer}>
        <Pressable
          onPress={() => router.push('/note/new?type=checklist')}
          accessibilityRole="button"
          accessibilityLabel="New checklist"
          style={[
            styles.fabSecondary,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              shadowColor: '#000000',
              shadowOpacity: theme.dark ? 0.3 : 0.1,
            },
          ]}
        >
          <Ionicons name="checkbox-outline" size={22} color={theme.colors.text} />
        </Pressable>

        <Pressable
          onPress={() => router.push('/note/new')}
          accessibilityRole="button"
          accessibilityLabel="New note"
          style={[
            styles.fabPrimary,
            {
              backgroundColor: theme.colors.primary,
              shadowColor: theme.colors.primary,
              shadowOpacity: 0.35,
            },
          ]}
        >
          <Ionicons name="add" size={28} color={theme.colors.primaryText} />
        </Pressable>
      </View>

      {/* Workspace Switcher Modal */}
      <Modal
        visible={workspaceModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setWorkspaceModalVisible(false)}
      >
        <Pressable
          style={[styles.modalOverlay, { backgroundColor: theme.colors.scrim }]}
          onPress={() => setWorkspaceModalVisible(false)}
        >
          <View
            style={[
              styles.modalSheet,
              {
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radii.xl,
                padding: theme.spacing.lg,
              },
            ]}
          >
            <Text
              style={[
                styles.modalTitle,
                {
                  color: theme.colors.text,
                  fontSize: theme.font.title3,
                  fontWeight: theme.weight.bold,
                  marginBottom: theme.spacing.md,
                },
              ]}
            >
              Switch Workspace
            </Text>

            {session?.workspaces.map((ws) => {
              const isSelected = ws.id === activeWorkspaceId;
              return (
                <Pressable
                  key={ws.id}
                  onPress={async () => {
                    await switchWorkspace(ws.id);
                    setWorkspaceModalVisible(false);
                    bumpData();
                  }}
                  style={[
                    styles.modalItem,
                    {
                      backgroundColor: isSelected ? theme.colors.primarySoft : 'transparent',
                      borderRadius: theme.radii.md,
                      padding: theme.spacing.md,
                    },
                  ]}
                >
                  <Ionicons
                    name="folder"
                    size={20}
                    color={isSelected ? theme.colors.primary : theme.colors.textSubtle}
                    style={{ marginRight: 12 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        color: isSelected ? theme.colors.primary : theme.colors.text,
                        fontWeight: isSelected ? theme.weight.bold : theme.weight.medium,
                      }}
                    >
                      {ws.name}
                    </Text>
                    {ws.role ? (
                      <Text style={{ color: theme.colors.textSubtle, fontSize: theme.font.caption }}>
                        Role: {ws.role}
                      </Text>
                    ) : null}
                  </View>
                  {isSelected ? (
                    <Ionicons name="checkmark" size={20} color={theme.colors.primary} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  workspaceBar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
  },
  workspaceButton: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  workspaceName: {
    letterSpacing: -0.2,
  },
  syncIconButton: {
    padding: 6,
  },
  filterBar: {
    paddingVertical: 10,
  },
  emptyTrashBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 6,
    alignSelf: 'center',
  },
  restoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 10,
  },
  listContent: {
    paddingBottom: 90,
  },
  sectionHeader: {
    letterSpacing: 0.5,
  },
  fabContainer: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fabSecondary: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  fabPrimary: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 4,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalSheet: {
    width: '100%',
    maxWidth: 380,
  },
  modalTitle: {
    letterSpacing: -0.2,
  },
  modalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
  },
});
