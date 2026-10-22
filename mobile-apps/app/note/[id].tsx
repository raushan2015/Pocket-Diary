/**
 * Note & checklist editor.
 *
 * Offline-first guarantees:
 *  - Notes are created LAZILY: opening "new note" writes nothing until the
 *    first actual edit, so backing out of an empty editor leaves no draft
 *    (and never syncs an empty note to the server).
 *  - Every edit is committed to SQLite + the durable outbox immediately
 *    (single transaction) — safe to kill the app at any point.
 *  - Leaving an editor whose note is still completely empty removes the
 *    draft locally and queues a server-side delete if it already synced.
 *  - Reminders, tags, pins, colors, type conversions and attachments all go
 *    through the same outbox path — no feature is "online-only".
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/features/auth/AuthContext';
import { useSync } from '@/features/sync/SyncContext';
import { useTheme } from '@/theme/ThemeProvider';
import { ChecklistEditor } from '@/components/notes/ChecklistEditor';
import { ColorPicker } from '@/components/ui/ColorPicker';
import { Banner } from '@/components/ui/Banner';
import { ReminderRow } from '@/components/notes/ReminderRow';
import { TagEditor } from '@/components/notes/TagEditor';
import { AttachmentStrip, type PendingAttachmentView } from '@/components/notes/AttachmentStrip';
import { validateAttachment, type PickedAttachment } from '@/features/attachments/rules';
import type { Note, ChecklistItem, NotePatch } from '@/features/notes/types';
import type { NoteColorId } from '@/theme/tokens';

/** Outbox payload for an update — a complete snapshot of the editable fields. */
function updatePayloadFor(n: Note): Record<string, unknown> {
  return {
    workspaceId: n.workspaceId,
    title: n.title,
    content: n.content,
    color: n.color,
    noteType: n.noteType,
    checklist: n.checklist,
    isPinned: n.isPinned,
    isFavorite: n.isFavorite,
    isArchived: n.isArchived,
    dueDate: n.dueDate,
    reminderTime: n.reminderTime,
    reminderLocation: n.reminderLocation,
    tags: n.tags,
    serverId: n.serverId,
  };
}

export default function NoteEditorScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session, apiClient } = useAuth();
  const {
    notesRepo,
    outbox,
    runSync,
    resolveConflictKeepMine,
    resolveConflictUseServer,
    syncStatus,
    isOnline,
    attachmentCache,
  } = useSync();

  const { id, type } = useLocalSearchParams<{ id: string; type?: string }>();
  const isNew = id === 'new';
  const insets = useSafeAreaInsets();

  const [noteId, setNoteId] = useState<string>(isNew ? '' : (id as string));
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [color, setColor] = useState<NoteColorId>('default');
  const [noteType, setNoteType] = useState<'text' | 'checklist'>(type === 'checklist' ? 'checklist' : 'text');
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [reminderTime, setReminderTime] = useState<number | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);
  const [isArchived, setIsArchived] = useState(false);
  const [syncState, setSyncState] = useState<'pending' | 'in_flight' | 'synced' | 'conflicted' | 'error'>('synced');
  const [isTrashed, setIsTrashed] = useState(false);
  const [hasServerId, setHasServerId] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [, bumpOutbox] = useState(0);

  const activeWorkspaceId = session?.activeWorkspaceId || '';
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  // ---- Load existing note -------------------------------------------------
  useEffect(() => {
    if (isNew) return; // nothing exists yet — created lazily on first edit
    const existing = notesRepo.getNoteById(id as string);
    if (!existing) return;
    applyNote(existing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew, notesRepo]);

  function applyNote(n: Note) {
    setNoteId(n.id);
    setTitle(n.title);
    setContent(n.content);
    setColor((n.color in theme.note ? n.color : 'default') as NoteColorId);
    setNoteType(n.noteType);
    setChecklist(n.checklist);
    setTags(n.tags);
    setReminderTime(n.reminderTime);
    setIsPinned(n.isPinned);
    setIsFavorite(n.isFavorite);
    setIsArchived(n.isArchived);
    setSyncState(n.syncState);
    setIsTrashed(n.deletedAt != null);
    setHasServerId(n.serverId != null);
  }

  // ---- Refresh editor state after background syncs -----------------------
  useEffect(() => {
    const currentId = noteIdRef.current;
    if (!currentId) return;
    const n = notesRepo.getNoteById(currentId);
    if (!n) return;
    setSyncState(n.syncState);
    setIsTrashed(n.deletedAt != null);
    setHasServerId(n.serverId != null);
    // A background sync can resolve a server-side restore or a "use server"
    // outcome — reflect content changes only when there are no pending edits.
    if (n.syncState === 'synced' && n.deletedAt == null) {
      setTitle(n.title);
      setContent(n.content);
      setChecklist(n.checklist);
      setTags(n.tags);
      setReminderTime(n.reminderTime);
      setColor((n.color in theme.note ? n.color : 'default') as NoteColorId);
    }
  }, [notesRepo, theme.note, syncStatus.lastSyncAt, syncStatus.pendingCount, syncStatus.failedCount, syncStatus.isSyncing]);

  // ---- Empty-draft cleanup on unmount ------------------------------------
  useEffect(() => {
    return () => {
      const currentId = noteIdRef.current;
      if (!currentId) return; // never edited — nothing was ever created
      const n = notesRepo.getNoteById(currentId);
      if (!n || n.deletedAt != null) return;
      const empty =
        !n.title.trim() &&
        !n.content.trim() &&
        !n.checklist.some((i) => i.text.trim()) &&
        n.attachments.length === 0 &&
        n.tags.length === 0 &&
        n.reminderTime == null;
      if (!empty) return;
      if (n.serverId) {
        // The empty draft already reached the server — clean it up there too.
        outbox.enqueue({
          entity: 'note',
          noteId: currentId,
          op: 'delete',
          payload: { serverId: n.serverId, permanent: true },
        });
      } else {
        outbox.removeNoteOps(currentId);
      }
      notesRepo.purgeNote(currentId);
    };
  }, [notesRepo, outbox]);

  // ---- Lazy note creation + durable save ----------------------------------
  const ensureNote = useCallback((): Note | null => {
    if (noteIdRef.current) {
      return notesRepo.getNoteById(noteIdRef.current);
    }
    if (!activeWorkspaceId) return null;
    const initialType = type === 'checklist' ? 'checklist' : 'text';
    const created = notesRepo.createNote({
      workspaceId: activeWorkspaceId,
      title: '',
      content: '',
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
        noteType: created.noteType,
        checklist: created.checklist,
      },
      clientId: created.clientId,
    });
    noteIdRef.current = created.id;
    setNoteId(created.id);
    setHasServerId(false);
    return created;
  }, [notesRepo, outbox, activeWorkspaceId, type]);

  // Debounced sync trigger — typing must not fire a sync per keystroke.
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      void runSync().catch(() => {});
    }, 400);
  }, [runSync]);

  const saveChanges = useCallback(
    (patch: NotePatch) => {
      const note = ensureNote();
      if (!note || note.deletedAt != null) return; // trashed notes are read-only
      const updated = notesRepo.updateNote(note.id, patch);
      setSyncState('pending');
      outbox.enqueue({
        entity: 'note',
        noteId: updated.id,
        op: 'update',
        payload: updatePayloadFor(updated),
        baseVersion: updated.serverVersion,
      });
      bumpOutbox((c) => c + 1);
      scheduleSync();
    },
    [ensureNote, notesRepo, outbox, scheduleSync],
  );

  // ---- Field handlers ------------------------------------------------------
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

  const handleTagsChange = (next: string[]) => {
    setTags(next);
    saveChanges({ tags: next });
  };

  const handleReminderChange = (time: number | null) => {
    setReminderTime(time);
    saveChanges({ reminderTime: time });
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

  // ---- Attachments ---------------------------------------------------------
  const handleAttachmentPicked = (pick: PickedAttachment) => {
    const validation = validateAttachment(pick);
    if (!validation.ok) {
      Alert.alert('Attachment not added', validation.reason ?? 'This file is not supported.');
      return;
    }
    const note = ensureNote();
    if (!note || note.deletedAt != null) return;
    const attachmentId = `local-att-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'attachment_upload',
      payload: {
        attachmentId,
        noteId: note.id,
        workspaceId: note.workspaceId,
        uri: pick.uri,
        fileName: pick.fileName,
        mimeType: validation.mimeType,
        fileSize: pick.fileSize,
      },
    });
    bumpOutbox((c) => c + 1);
    if (note.serverId) scheduleSync();
  };

  const handleDeleteAttachment = (attId: string) => {
    const note = notesRepo.getNoteById(noteIdRef.current);
    if (!note) return;
    outbox.enqueue({
      entity: 'note',
      noteId: note.id,
      op: 'attachment_delete',
      payload: { attachmentId: attId, serverAttachmentId: attId },
    });
    bumpOutbox((c) => c + 1);
    scheduleSync();
  };

  // ---- Trash lifecycle -----------------------------------------------------
  const handleTrash = () => {
    const note = ensureNote();
    if (!note) return;
    Alert.alert('Move to Trash', 'This note will be moved to the trash. You can restore it from the Trash view.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Trash',
        style: 'destructive',
        onPress: () => {
          notesRepo.trashNote(note.id);
          const current = notesRepo.getNoteById(note.id);
          outbox.enqueue({
            entity: 'note',
            noteId: note.id,
            op: 'delete',
            payload: { serverId: current?.serverId },
          });
          void runSync().catch(() => {});
          router.back();
        },
      },
    ]);
  };

  const handleRestore = () => {
    if (!noteIdRef.current) return;
    const restored = notesRepo.restoreNote(noteIdRef.current);
    outbox.enqueue({
      entity: 'note',
      noteId: restored.id,
      op: 'restore',
      payload: { serverId: restored.serverId },
    });
    applyNote({ ...restored, syncState: 'pending' });
    void runSync().catch(() => {});
  };

  const handleDeleteForever = () => {
    const currentId = noteIdRef.current;
    if (!currentId) return;
    Alert.alert('Delete permanently', 'This note will be erased. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete Forever',
        style: 'destructive',
        onPress: () => {
          const n = notesRepo.getNoteById(currentId);
          if (n?.serverId) {
            outbox.enqueue({
              entity: 'note',
              noteId: currentId,
              op: 'delete',
              payload: { serverId: n.serverId, permanent: true },
            });
          } else {
            outbox.removeNoteOps(currentId);
          }
          notesRepo.purgeNote(currentId);
          router.back();
        },
      },
    ]);
  };

  // ---- Conflicts -----------------------------------------------------------
  const handleKeepMine = async () => {
    const currentId = noteIdRef.current;
    if (!currentId) return;
    await resolveConflictKeepMine(currentId);
    const refreshed = notesRepo.getNoteById(currentId);
    if (refreshed) applyNote(refreshed);
  };

  const handleUseServer = async () => {
    const currentId = noteIdRef.current;
    if (!currentId) return;
    await resolveConflictUseServer(currentId);
    const refreshed = notesRepo.getNoteById(currentId);
    if (refreshed) applyNote(refreshed);
  };

  // ---- Derived -------------------------------------------------------------
  const pendingAttachments: PendingAttachmentView[] = useMemo(() => {
    const currentId = noteIdRef.current;
    if (!currentId) return [];
    return outbox
      .listAllEntries()
      .filter((e) => e.noteId === currentId && e.op === 'attachment_upload')
      .map((e) => ({
        opId: e.id,
        fileName: String(e.payload.fileName ?? 'attachment'),
        status: e.status === 'failed' ? 'failed' : e.status === 'in_flight' ? 'in_flight' : 'pending',
        lastError: e.lastError,
        waitingForNote: !hasServerId,
        isOnline,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbox, syncStatus, hasServerId, isOnline, noteId]);

  const attachments = useMemo(() => {
    const n = notesRepo.getNoteById(noteIdRef.current);
    return n?.attachments ?? [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, syncStatus]);

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
              {!isTrashed ? (
                <>
                  <Pressable
                    hitSlop={10}
                    onPress={() => setShowColorPicker((prev) => !prev)}
                    accessibilityRole="button"
                    accessibilityLabel="Choose color"
                    style={styles.actionBtn}
                  >
                    <Ionicons name="color-palette-outline" size={22} color={ink} />
                  </Pressable>
                  <Pressable
                    hitSlop={10}
                    onPress={handleToggleNoteType}
                    accessibilityRole="button"
                    accessibilityLabel={noteType === 'text' ? 'Convert to checklist' : 'Convert to text note'}
                    style={styles.actionBtn}
                  >
                    <Ionicons name={noteType === 'text' ? 'checkbox-outline' : 'document-text-outline'} size={22} color={ink} />
                  </Pressable>
                  <Pressable
                    hitSlop={10}
                    onPress={handleToggleFavorite}
                    accessibilityRole="button"
                    accessibilityLabel={isFavorite ? 'Remove favorite' : 'Add favorite'}
                    style={styles.actionBtn}
                  >
                    <Ionicons name={isFavorite ? 'heart' : 'heart-outline'} size={22} color={isFavorite ? theme.colors.danger : ink} />
                  </Pressable>
                  <Pressable
                    hitSlop={10}
                    onPress={handleTogglePinned}
                    accessibilityRole="button"
                    accessibilityLabel={isPinned ? 'Unpin note' : 'Pin note'}
                    style={styles.actionBtn}
                  >
                    <Ionicons name={isPinned ? 'pin' : 'pin-outline'} size={22} color={isPinned ? theme.colors.primary : ink} />
                  </Pressable>
                  <Pressable
                    hitSlop={10}
                    onPress={handleToggleArchived}
                    accessibilityRole="button"
                    accessibilityLabel={isArchived ? 'Unarchive note' : 'Archive note'}
                    style={styles.actionBtn}
                  >
                    <Ionicons name={isArchived ? 'archive' : 'archive-outline'} size={22} color={isArchived ? theme.colors.primary : ink} />
                  </Pressable>
                </>
              ) : null}
              <Pressable
                hitSlop={10}
                onPress={isTrashed ? handleDeleteForever : handleTrash}
                accessibilityRole="button"
                accessibilityLabel={isTrashed ? 'Delete permanently' : 'Move note to trash'}
                style={styles.actionBtn}
              >
                <Ionicons name={isTrashed ? 'trash' : 'trash-outline'} size={22} color={theme.colors.danger} />
              </Pressable>
            </View>
          ),
        }}
      />

      <ScrollView contentContainerStyle={[styles.content, { padding: theme.spacing.lg }]}>
        {/* Trashed-note banner: read-only until restored */}
        {isTrashed ? (
          <Banner
            variant="warning"
            title="This note is in the trash"
            message="Restore it to edit again, or delete it permanently."
            actionLabel="Restore"
            onAction={handleRestore}
            secondaryActionLabel="Delete Forever"
            onSecondaryAction={handleDeleteForever}
            style={{ marginBottom: theme.spacing.md }}
          />
        ) : null}

        {/* Conflict Resolution Banner */}
        {syncState === 'conflicted' ? (
          <Banner
            variant="conflict"
            title="Edit Conflict"
            message="This note was modified on another device. Choose which version you want to keep — nothing is overwritten until you decide."
            actionLabel="Keep Mine"
            onAction={handleKeepMine}
            secondaryActionLabel="Use Server"
            onSecondaryAction={handleUseServer}
            style={{ marginBottom: theme.spacing.md }}
          />
        ) : null}

        {/* Offline hint for brand-new notes */}
        {!isTrashed && isNew && !hasServerId && !isOnline ? (
          <Banner
            variant="info"
            message="You're offline — this note is being written to your device and will sync when you reconnect."
            style={{ marginBottom: theme.spacing.md }}
          />
        ) : null}

        {/* Color Palette Picker Dropdown */}
        {showColorPicker && !isTrashed ? (
          <View style={[styles.paletteContainer, { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radii.lg }]}>
            <ColorPicker selectedColor={color} onSelectColor={handleColorChange} />
          </View>
        ) : null}

        {/* Title Input */}
        <TextInput
          value={title}
          onChangeText={handleTitleChange}
          editable={!isTrashed}
          placeholder="Title"
          placeholderTextColor={theme.colors.textSubtle}
          accessibilityLabel="Note title"
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
            editable={!isTrashed}
          />
        ) : (
          <TextInput
            value={content}
            onChangeText={handleContentChange}
            editable={!isTrashed}
            placeholder="Note details..."
            placeholderTextColor={theme.colors.textSubtle}
            multiline
            textAlignVertical="top"
            accessibilityLabel="Note content"
            style={[
              styles.contentInput,
              {
                color: ink,
                fontSize: theme.font.body,
                lineHeight: 24,
                minHeight: 200,
              },
            ]}
          />
        )}

        {/* Attachments */}
        {!isTrashed || attachments.length > 0 || pendingAttachments.length > 0 ? (
          <View style={{ marginTop: theme.spacing.md }}>
            <AttachmentStrip
              attachments={attachments}
              pending={pendingAttachments}
              disabled={isTrashed}
              cache={attachmentCache}
              apiClient={apiClient}
              onPicked={handleAttachmentPicked}
              onDeleteAttachment={(att) => handleDeleteAttachment(att.id)}
              onRetryUpload={(opId) => {
                outbox.retryOp(opId);
                scheduleSync();
              }}
            />
          </View>
        ) : null}

        {/* Metadata rows: reminder + tags */}
        {!isTrashed ? (
          <View style={{ marginTop: theme.spacing.sm }}>
            <ReminderRow reminderTime={reminderTime} onChange={handleReminderChange} />
            <TagEditor tags={tags} onChange={handleTagsChange} />
          </View>
        ) : null}
      </ScrollView>

      {/* Sync Status Footer Bar (respects the edge-to-edge gesture area) */}
      <View style={[styles.statusBar, { borderTopColor: 'rgba(0,0,0,0.06)', paddingBottom: insets.bottom, height: 36 + insets.bottom }]}>
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
            ? 'Version conflict — choose which version to keep'
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
    gap: 6,
  },
  actionBtn: {
    padding: 8,
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
