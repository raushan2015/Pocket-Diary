/**
 * Attachment strip for the note editor.
 *
 * Shows:
 *  - synced attachments (images render from the offline disk cache; documents
 *    offer Open), each deletable;
 *  - queued uploads from the durable outbox with honest status ("uploading",
 *    "waiting for the note to sync first", "will upload when online",
 *    "failed" + retry);
 *  - + Photo / + File pick buttons.
 *
 * Unsupported picks are the PARENT's job to refuse (see
 * features/attachments/rules.ts) — this strip only hands over raw picks.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Image,
  Pressable,
  Modal,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useTheme } from '@/theme/ThemeProvider';
import { formatBytes } from '@/utils/time';
import { isImageMime, type PickedAttachment } from '@/features/attachments/rules';
import type { NoteAttachment } from '@/features/notes/types';
import type { AttachmentCache } from '@/services/attachments/cache';
import type { ApiClient } from '@/services/api/client';

export interface PendingAttachmentView {
  opId: string;
  fileName: string;
  status: 'pending' | 'in_flight' | 'failed';
  lastError: string | null;
  /** True while the parent note has not reached the server yet. */
  waitingForNote: boolean;
  isOnline: boolean;
}

export interface AttachmentStripProps {
  attachments: NoteAttachment[];
  pending: PendingAttachmentView[];
  disabled?: boolean;
  cache: AttachmentCache;
  apiClient: ApiClient | null;
  onPicked(pick: PickedAttachment): void;
  onDeleteAttachment(att: NoteAttachment): void;
  onRetryUpload(opId: string): void;
}

export function AttachmentStrip({
  attachments,
  pending,
  disabled,
  cache,
  apiClient,
  onPicked,
  onDeleteAttachment,
  onRetryUpload,
}: AttachmentStripProps) {
  const theme = useTheme();
  const [viewing, setViewing] = useState<NoteAttachment | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);

  const pickImage = async () => {
    setPickerBusy(true);
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.9,
        allowsMultipleSelection: false,
      });
      if (!res.canceled && res.assets[0]) {
        const a = res.assets[0];
        onPicked({
          uri: a.uri,
          fileName: a.fileName ?? `photo-${Date.now()}.jpg`,
          mimeType: a.mimeType ?? 'image/jpeg',
          fileSize: a.fileSize ?? 0,
        });
      }
    } catch {
      Alert.alert('Photo picker', 'Could not open the photo picker on this device.');
    } finally {
      setPickerBusy(false);
    }
  };

  const pickDocument = async () => {
    setPickerBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: [
          'image/jpeg',
          'image/png',
          'image/webp',
          'image/gif',
          'application/pdf',
          'text/plain',
          'text/markdown',
          // Some providers report generic types; we re-resolve by extension.
          'application/octet-stream',
        ],
      });
      if (!res.canceled && res.assets?.[0]) {
        const a = res.assets[0];
        onPicked({
          uri: a.uri,
          fileName: a.name,
          mimeType: a.mimeType ?? '',
          fileSize: a.size ?? 0,
        });
      }
    } catch {
      Alert.alert('File picker', 'Could not open the file picker on this device.');
    } finally {
      setPickerBusy(false);
    }
  };

  const confirmDelete = (att: NoteAttachment) => {
    Alert.alert('Remove attachment', `"${att.fileName}" will be removed from this note.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => onDeleteAttachment(att) },
    ]);
  };

  const openDocument = async (att: NoteAttachment) => {
    if (!apiClient) return;
    const local = await cache.ensureCached(apiClient, att);
    if (!local) {
      Alert.alert('Offline', 'This file has not been downloaded yet and the server is unreachable. Try again when you are back online.');
      return;
    }
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(local, {
          mimeType: att.mimeType,
          dialogTitle: att.fileName,
        });
      } else {
        Alert.alert(att.fileName, `Saved offline (${formatBytes(att.fileSize)}).`);
      }
    } catch {
      Alert.alert('Could not open the file', 'The OS refused to open this file type.');
    }
  };

  return (
    <View style={{ marginBottom: theme.spacing.md }}>
      {attachments.length > 0 || pending.length > 0 ? (
        <Text style={[styles.sectionLabel, { color: theme.colors.textSubtle, fontSize: theme.font.caption }]}>
          ATTACHMENTS
        </Text>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 6 }}>
        {attachments.map((att) => (
          <AttachmentThumb
            key={att.id}
            att={att}
            cache={cache}
            apiClient={apiClient}
            onDelete={() => confirmDelete(att)}
            onOpenImage={() => setViewing(att)}
            onOpenDocument={() => void openDocument(att)}
          />
        ))}

        {pending.map((p) => (
          <View
            key={p.opId}
            style={[
              styles.pendingTile,
              {
                backgroundColor: theme.colors.surfaceAlt,
                borderColor:
                  p.status === 'failed' ? theme.colors.danger : theme.colors.border,
              },
            ]}
          >
            <View style={styles.pendingHead}>
              <Ionicons name="cloud-upload-outline" size={18} color={theme.colors.primary} />
              {p.status === 'failed' ? (
                <Pressable hitSlop={10} onPress={() => onRetryUpload(p.opId)} accessibilityRole="button" accessibilityLabel={`Retry uploading ${p.fileName}`}>
                  <Ionicons name="refresh" size={18} color={theme.colors.primary} />
                </Pressable>
              ) : (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              )}
            </View>
            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: theme.font.caption, maxWidth: 110 }}>
              {p.fileName}
            </Text>
            <Text style={{ color: p.status === 'failed' ? theme.colors.danger : theme.colors.textSubtle, fontSize: 10, maxWidth: 110 }}>
              {p.status === 'failed'
                ? (p.lastError ?? 'Upload failed')
                : p.waitingForNote
                ? 'Waiting for the note to sync first…'
                : p.isOnline
                ? 'Uploading…'
                : 'Will upload when online'}
            </Text>
          </View>
        ))}

        {!disabled ? (
          <>
            <Pressable
              onPress={pickImage}
              disabled={pickerBusy}
              accessibilityRole="button"
              accessibilityLabel="Attach a photo"
              style={[styles.addTile, { borderColor: theme.colors.border, borderRadius: theme.radii.md }]}
            >
              <Ionicons name="image-outline" size={20} color={theme.colors.primary} />
              <Text style={{ color: theme.colors.primary, fontSize: theme.font.caption, marginTop: 4 }}>Photo</Text>
            </Pressable>
            <Pressable
              onPress={pickDocument}
              disabled={pickerBusy}
              accessibilityRole="button"
              accessibilityLabel="Attach a document"
              style={[styles.addTile, { borderColor: theme.colors.border, borderRadius: theme.radii.md }]}
            >
              <Ionicons name="document-attach-outline" size={20} color={theme.colors.primary} />
              <Text style={{ color: theme.colors.primary, fontSize: theme.font.caption, marginTop: 4 }}>File</Text>
            </Pressable>
          </>
        ) : null}
      </ScrollView>

      {/* Full-screen image viewer */}
      <Modal visible={viewing != null} transparent onRequestClose={() => setViewing(null)} animationType="fade">
        <View style={[styles.viewer, { backgroundColor: theme.colors.scrim }]}>
          <Pressable style={styles.viewerClose} onPress={() => setViewing(null)} accessibilityRole="button" accessibilityLabel="Close image viewer">
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </Pressable>
          {viewing ? (
            <ViewedImage att={viewing} cache={cache} apiClient={apiClient} />
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

function ViewedImage({
  att,
  cache,
  apiClient,
}: {
  att: NoteAttachment;
  cache: AttachmentCache;
  apiClient: ApiClient | null;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const cacheRef = useMemo(
    () => ({ id: att.id, fileName: att.fileName, mimeType: att.mimeType }),
    [att.id, att.fileName, att.mimeType],
  );
  useEffect(() => {
    let alive = true;
    if (apiClient) {
      void cache.ensureCached(apiClient, cacheRef).then((u) => {
        if (alive) setUri(u);
      });
    }
    return () => {
      alive = false;
    };
  }, [cacheRef, cache, apiClient]);
  if (!uri) {
    return (
      <View style={styles.viewerCenter}>
        <ActivityIndicator size="large" color="#FFFFFF" />
      </View>
    );
  }
  return <Image source={{ uri }} style={styles.viewerImage} resizeMode="contain" />;
}

function AttachmentThumb({
  att,
  cache,
  apiClient,
  onDelete,
  onOpenImage,
  onOpenDocument,
}: {
  att: NoteAttachment;
  cache: AttachmentCache;
  apiClient: ApiClient | null;
  onDelete(): void;
  onOpenImage(): void;
  onOpenDocument(): void;
}) {
  const theme = useTheme();
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>(
    apiClient ? 'loading' : 'unavailable',
  );

  // Stable identity: the full attachment object is recreated on each parent
  // render, but cache lookups depend only on these three primitives.
  const cacheRef = useMemo(
    () => ({ id: att.id, fileName: att.fileName, mimeType: att.mimeType }),
    [att.id, att.fileName, att.mimeType],
  );

  useEffect(() => {
    let alive = true;
    // NOTE: no synchronous state reset here — the tile remounts (key =
    // attachment id) when the identity changes, so the initial state is
    // correct; only async outcomes update state.
    if (!apiClient) {
      return () => {
        alive = false;
      };
    }
    void cache
      .ensureCached(apiClient, cacheRef)
      .then((uri) => {
        if (!alive) return;
        if (uri) {
          setLocalUri(uri);
          setState('ready');
        } else {
          setState('unavailable');
        }
      })
      .catch(() => {
        if (alive) setState('unavailable');
      });
    return () => {
      alive = false;
    };
  }, [cacheRef, cache, apiClient]);

  const isImage = isImageMime(att.mimeType);

  return (
    <View style={[styles.tile, { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radii.md }]}>
      <Pressable
        onPress={isImage ? onOpenImage : onOpenDocument}
        accessibilityRole="image"
        accessibilityLabel={`Attachment ${att.fileName}`}
        style={styles.tileBody}
      >
        {state === 'loading' ? (
          <View style={styles.tilePreview}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
          </View>
        ) : isImage && localUri && state === 'ready' ? (
          <Image source={{ uri: localUri }} style={styles.tilePreview} resizeMode="cover" />
        ) : (
          <View style={styles.tilePreview}>
            <Ionicons
              name={state === 'unavailable' ? 'cloud-offline-outline' : 'document-outline'}
              size={22}
              color={state === 'unavailable' ? theme.colors.warning : theme.colors.primary}
            />
          </View>
        )}
        <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: theme.font.caption, maxWidth: 100 }}>
          {att.fileName}
        </Text>
        {state === 'unavailable' ? (
          <Text style={{ color: theme.colors.warning, fontSize: 9, maxWidth: 100 }}>
            Download needed — go online
          </Text>
        ) : (
          <Text style={{ color: theme.colors.textSubtle, fontSize: 10 }}>{formatBytes(att.fileSize)}</Text>
        )}
      </Pressable>
      <Pressable hitSlop={6} onPress={onDelete} accessibilityRole="button" accessibilityLabel={`Remove attachment ${att.fileName}`} style={styles.tileX}>
        <Ionicons name="close-circle" size={18} color={theme.colors.danger} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    letterSpacing: 0.5,
    fontWeight: '700',
    marginBottom: 2,
  },
  addTile: {
    width: 84,
    height: 100,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tile: {
    position: 'relative',
  },
  tileBody: {
    width: 100,
    padding: 6,
    alignItems: 'center',
  },
  tilePreview: {
    width: 84,
    height: 64,
    borderRadius: 8,
    backgroundColor: 'rgba(128,128,128,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
    overflow: 'hidden',
  },
  tileX: {
    position: 'absolute',
    top: 2,
    right: 2,
  },
  pendingTile: {
    width: 110,
    borderWidth: 1,
    padding: 8,
    alignItems: 'center',
  },
  pendingHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 4,
  },
  viewer: {
    flex: 1,
  },
  viewerClose: {
    position: 'absolute',
    top: 48,
    right: 24,
    zIndex: 1,
    padding: 8,
  },
  viewerCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: {
    flex: 1,
    width: '100%',
  },
});
