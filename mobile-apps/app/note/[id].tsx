import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Pressable,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/features/auth/AuthContext';
import { useSync } from '@/features/sync/SyncContext';
import { useTheme } from '@/theme/ThemeProvider';
import { ChecklistEditor } from '@/components/notes/ChecklistEditor';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { Banner } from '@/components/ui/Banner';
import type { Note, ChecklistItem } from '@/features/notes/types';
import type { NoteColorId } from '@/theme/tokens';

export default function NoteEditorScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session } = useAuth();
  const { notesRepo, outbox, runSync, resolveConflictKeepMine, resolveConflictUseServer } = useSync();

  const { id, type } = useLocalSearchParams<{ id: string; type?: string }>();
  const isNew = id === 'new';

  const [noteId, setNoteId] = useState<string>(isNew ? '' : id);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [color, setColor] = useState<NoteColorId>('default');
  const [noteType, setNoteType] = useState<'text' | 'checklist'>(type === 'checklist' ? 'checklist' : 'text');
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [isPinned, setIsPinned] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);
  const [isArchived, setIsArchived] = useState(false);
  const [syncState, setSyncState] = useState<'pending' | 'in_flight' | 'synced' | 'conflicted' | 'error'>('synced');
  const [showColorPicker, setShowColorPicker] = useState(false);

  const activeWorkspaceId = session?.activeWorkspaceId || '';

  // Load existing note or initialize new note
  useEffect(() => {
    if (isNew) {
      if (!activeWorkspaceId) return;
      const initialType = type === 'checklist' ? 'checklist' : 'text';
      const created = notesRepo.createNote({
        workspaceId: activeWorkspaceId,
        title: '',
        content: '',
        color: 'default',
        noteType: initialType,
        checklist: initialType === 'checklist' ? [{ id: 'item-1', text: '', checked: false }] : [],
      });
      outbox.enqueue({
        entity: 'note',
        noteId: created.id,
        op: 'create',
        payload: {
          workspaceId: created.workspaceId,
          title: created.title,
          content: created.content,
          color: created.color,
          noteType: created.noteType,
          checklist: created.checklist,
        },
        clientId: created.clientId,
      });

      setNoteId(created.id);
      setTitle(created.title);
      setContent(created.content);
      setColor(created.color as NoteColorId);
      setNoteType(created.noteType);
      setChecklist(created.checklist);
      setIsPinned(created.isPinned);
      setIsFavorite(created.isFavorite);
      setIsArchived(created.isArchived);
      setSyncState(created.syncState);
    } else {
      const existing = notesRepo.getNoteById(id);
      if (existing) {
        setNoteId(existing.id);
        setTitle(existing.title);
        setContent(existing.content);
        setColor((existing.color in theme.note ? existing.color : 'default') as NoteColorId);
        setNoteType(existing.noteType);
        setChecklist(existing.checklist);
        setIsPinned(existing.isPinned);
        setIsFavorite(existing.isFavorite);
        setIsArchived(existing.isArchived);
        setSyncState(existing.syncState);
      }
    }
  }, [id, isNew, type, notesRepo, outbox, activeWorkspaceId, theme.note]);

  // Persist updates to SQLite & durable outbox
  const saveChanges = useCallback(
    (patch: Partial<Note>) => {
      if (!noteId) return;
      const updated = notesRepo.updateNote(noteId, patch);
      if (!updated) return;

      setSyncState('pending');

      outbox.enqueue({
        entity: 'note',
        noteId,
        op: 'update',
        payload: {
          title: updated.title,
          content: updated.content,
          color: updated.color,
          noteType: updated.noteType,
          checklist: updated.checklist,
          isPinned: updated.isPinned,
          isFavorite: updated.isFavorite,
          isArchived: updated.isArchived,
          serverId: updated.serverId,
        },
        baseVersion: updated.serverVersion,
      });

      // Best-effort background sync
      void runSync().catch(() => {});
    },
    [noteId, notesRepo, outbox, runSync],
  );

  const handleTitleChange = (t: string) => {
    setTitle(t);
    saveChanges({ title: t });
  };

  const handleContentChange = (c: string) => {
    setContent(c);
    saveChanges({ content: c });
  };

  const handleColorChange = (newColor: NoteColorId) => {
    setColor(newColor);
    saveChanges({ color: newColor });
  };

  const handleTogglePinned = () => {
    const next = !isPinned;
    setIsPinned(next);
    saveChanges({ isPinned: next });
  };

  const handleToggleFavorite = () => {
    const next = !isFavorite;
    setIsFavorite(next);
    saveChanges({ isFavorite: next });
  };

  const handleToggleArchived = () => {
    const next = !isArchived;
    setIsArchived(next);
    saveChanges({ isArchived: next });
  };

  const handleChecklistChange = (items: ChecklistItem[]) => {
    setChecklist(items);
    saveChanges({ checklist: items });
  };

  const handleToggleNoteType = () => {
    const nextType = noteType === 'text' ? 'checklist' : 'text';
    setNoteType(nextType);
    let nextChecklist = checklist;
    if (nextType === 'checklist' && checklist.length === 0) {
      nextChecklist = content
        ? content.split('\n').filter(Boolean).map((line, idx) => ({ id: `line-${idx}`, text: line, checked: false }))
        : [{ id: 'item-1', text: '', checked: false }];
      setChecklist(nextChecklist);
    }
    saveChanges({ noteType: nextType, checklist: nextChecklist });
  };

  const handleDelete = () => {
    Alert.alert('Move to Trash', 'This note will be moved to the trash.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Trash',
        style: 'destructive',
        onPress: () => {
          if (!noteId) return;
          notesRepo.trashNote(noteId);
          const current = notesRepo.getNoteById(noteId);
          outbox.enqueue({
            entity: 'note',
            noteId,
            op: 'delete',
            payload: { serverId: current?.serverId },
          });
          void runSync().catch(() => {});
          router.back();
        },
      },
    ]);
  };

  const handleKeepMine = async () => {
    if (!noteId) return;
    await resolveConflictKeepMine(noteId);
    const refreshed = notesRepo.getNoteById(noteId);
    if (refreshed) setSyncState(refreshed.syncState);
  };

  const handleUseServer = async () => {
    if (!noteId) return;
    await resolveConflictUseServer(noteId);
    const refreshed = notesRepo.getNoteById(noteId);
    if (refreshed) {
      setTitle(refreshed.title);
      setContent(refreshed.content);
      setColor((refreshed.color in theme.note ? refreshed.color : 'default') as NoteColorId);
      setChecklist(refreshed.checklist);
      setSyncState(refreshed.syncState);
    }
  };

  const bg = theme.note[color] || theme.colors.surface;
  const ink = theme.noteInk[color] || theme.colors.text;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: bg },
          headerTintColor: ink,
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                hitSlop={8}
                onPress={() => setShowColorPicker((prev) => !prev)}
                accessibilityRole="button"
                accessibilityLabel="Choose color"
                style={styles.actionBtn}
              >
                <Ionicons name="color-palette-outline" size={22} color={ink} />
              </Pressable>

              <Pressable
                hitSlop={8}
                onPress={handleToggleNoteType}
                accessibilityRole="button"
                accessibilityLabel={noteType === 'text' ? 'Convert to checklist' : 'Convert to text note'}
                style={styles.actionBtn}
              >
                <Ionicons
                  name={noteType === 'text' ? 'checkbox-outline' : 'document-text-outline'}
                  size={22}
                  color={ink}
                />
              </Pressable>

              <Pressable
                hitSlop={8}
                onPress={handleToggleFavorite}
                accessibilityRole="button"
                accessibilityLabel={isFavorite ? 'Remove favorite' : 'Add favorite'}
                style={styles.actionBtn}
              >
                <Ionicons
                  name={isFavorite ? 'heart' : 'heart-outline'}
                  size={22}
                  color={isFavorite ? theme.colors.danger : ink}
                />
              </Pressable>

              <Pressable
                hitSlop={8}
                onPress={handleTogglePinned}
                accessibilityRole="button"
                accessibilityLabel={isPinned ? 'Unpin note' : 'Pin note'}
                style={styles.actionBtn}
              >
                <Ionicons
                  name={isPinned ? 'pin' : 'pin-outline'}
                  size={22}
                  color={isPinned ? theme.colors.primary : ink}
                />
              </Pressable>

              <Pressable
                hitSlop={8}
                onPress={handleToggleArchived}
                accessibilityRole="button"
                accessibilityLabel={isArchived ? 'Unarchive note' : 'Archive note'}
                style={styles.actionBtn}
              >
                <Ionicons
                  name={isArchived ? 'archive' : 'archive-outline'}
                  size={22}
                  color={isArchived ? theme.colors.primary : ink}
                />
              </Pressable>

              <Pressable
                hitSlop={8}
                onPress={handleDelete}
                accessibilityRole="button"
                accessibilityLabel="Delete note"
                style={styles.actionBtn}
              >
                <Ionicons name="trash-outline" size={22} color={theme.colors.danger} />
              </Pressable>
            </View>
          ),
        }}
      />

      <ScrollView contentContainerStyle={[styles.content, { padding: theme.spacing.lg }]}>
        {/* Conflict Resolution Banner */}
        {syncState === 'conflicted' ? (
          <Banner
            variant="conflict"
            title="Edit Conflict"
            message="This note was modified on another device. Choose which version you want to keep."
            actionLabel="Keep Mine"
            onAction={handleKeepMine}
            secondaryActionLabel="Use Server"
            onSecondaryAction={handleUseServer}
            style={{ marginBottom: theme.spacing.md }}
          />
        ) : null}

        {/* Color Palette Picker Dropdown */}
        {showColorPicker ? (
          <View style={[styles.paletteContainer, { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radii.lg }]}>
            <ColorPicker selectedColor={color} onSelectColor={handleColorChange} />
          </View>
        ) : null}

        {/* Title Input */}
        <TextInput
          value={title}
          onChangeText={handleTitleChange}
          placeholder="Title"
          placeholderTextColor={theme.colors.textSubtle}
          style={[
            styles.titleInput,
            {
              color: ink,
              fontSize: theme.font.title2,
              fontWeight: theme.weight.bold,
              marginBottom: theme.spacing.md,
            },
          ]}
        />

        {/* Body Editor: Text or Checklist */}
        {noteType === 'checklist' ? (
          <ChecklistEditor
            items={checklist}
            onChange={handleChecklistChange}
            inkColor={ink}
          />
        ) : (
          <TextInput
            value={content}
            onChangeText={handleContentChange}
            placeholder="Note details..."
            placeholderTextColor={theme.colors.textSubtle}
            multiline
            textAlignVertical="top"
            style={[
              styles.contentInput,
              {
                color: ink,
                fontSize: theme.font.body,
                lineHeight: 24,
                minHeight: 250,
              },
            ]}
          />
        )}
      </ScrollView>

      {/* Sync Status Footer Bar */}
      <View style={[styles.statusBar, { borderTopColor: 'rgba(0,0,0,0.06)' }]}>
        <Ionicons
          name={
            syncState === 'synced'
              ? 'cloud-done-outline'
              : syncState === 'conflicted'
              ? 'alert-circle'
              : 'time-outline'
          }
          size={14}
          color={syncState === 'conflicted' ? theme.colors.warning : theme.colors.textSubtle}
          style={{ marginRight: 6 }}
        />
        <Text style={[styles.statusText, { color: theme.colors.textSubtle, fontSize: theme.font.caption }]}>
          {syncState === 'synced'
            ? 'Synchronized with server'
            : syncState === 'conflicted'
            ? 'Version conflict'
            : 'Saved offline on device'}
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingBottom: 40,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionBtn: {
    padding: 6,
  },
  paletteContainer: {
    marginBottom: 12,
  },
  titleInput: {
    paddingVertical: 8,
    letterSpacing: -0.3,
  },
  contentInput: {
    paddingVertical: 4,
  },
  statusBar: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderTopWidth: 1,
  },
  statusText: {
    letterSpacing: 0.1,
  },
});
