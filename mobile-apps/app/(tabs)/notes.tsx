import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  Pressable,
  StyleSheet,
  ScrollView,
  Modal,
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
  const { notesRepo, syncStatus, isOnline, runSync } = useSync();

  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [workspaceModalVisible, setWorkspaceModalVisible] = useState(false);

  const activeWorkspaceId = session?.activeWorkspaceId || '';

  const loadNotes = useCallback(() => {
    if (!activeWorkspaceId) return;

    let res: { notes: Note[]; total: number };
    switch (activeFilter) {
      case 'all':
        res = notesRepo.listNotes({ workspaceId: activeWorkspaceId });
        break;
      case 'pinned':
        res = notesRepo.listNotes({ workspaceId: activeWorkspaceId, isPinned: true });
        break;
      case 'favorites':
        res = notesRepo.listNotes({ workspaceId: activeWorkspaceId, isFavorite: true });
        break;
      case 'checklists':
        res = notesRepo.listNotes({ workspaceId: activeWorkspaceId, noteType: 'checklist' });
        break;
      case 'archived':
        res = notesRepo.listNotes({ workspaceId: activeWorkspaceId, isArchived: true });
        break;
      case 'trash':
        res = notesRepo.listNotes({ workspaceId: activeWorkspaceId, deletedOnly: true });
        break;
    }
    setNotes(res.notes);
    setLoading(false);
  }, [notesRepo, activeWorkspaceId, activeFilter]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes, syncStatus.lastSyncAt, syncStatus.pendingCount]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await runSync();
    } finally {
      setRefreshing(false);
      loadNotes();
    }
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
          contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: 8 }}
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
      </View>

      {/* Notes List */}
      {loading ? (
        <View style={{ padding: theme.spacing.lg }}>
          <NoteCardSkeleton />
          <NoteCardSkeleton />
          <NoteCardSkeleton />
        </View>
      ) : notes.length === 0 ? (
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
            activeFilter === 'trash' || activeFilter === 'archived'
              ? 'Notes you archive or delete will appear here.'
              : 'Tap the button below to jot down your first note or checklist.'
          }
          actionLabel={activeFilter === 'all' ? 'Create Note' : undefined}
          onAction={() => router.push('/note/new')}
        />
      ) : (
        <FlatList
          data={unpinnedNotes}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.listContent, { padding: theme.spacing.lg }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
          ListHeaderComponent={
            pinnedNotes.length > 0 ? (
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
            ) : null
          }
          renderItem={({ item }) => (
            <NoteCard
              note={item}
              onPress={() => router.push(`/note/${item.id}`)}
            />
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
                    loadNotes();
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
