import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/ThemeProvider';
import type { Note } from '@/features/notes/types';
import type { NoteColorId } from '@/theme/tokens';
import { relativeTime } from '@/utils/time';

export interface NoteCardProps {
  note: Note;
  onPress: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function NoteCard({ note, onPress, onLongPress, style }: NoteCardProps) {
  const theme = useTheme();

  const colorKey = (note.color in theme.note ? note.color : 'default') as NoteColorId;
  const bg = theme.note[colorKey];
  const ink = theme.noteInk[colorKey];

  const isChecklist = note.noteType === 'checklist' && note.checklist.length > 0;
  const previewChecklist = isChecklist ? note.checklist.slice(0, 3) : [];
  const remainingChecklistCount = isChecklist ? Math.max(0, note.checklist.length - 3) : 0;

  const renderSyncBadge = () => {
    switch (note.syncState) {
      case 'pending':
        return (
          <View style={styles.syncBadge} accessibilityLabel="Pending sync">
            <Ionicons name="time-outline" size={13} color={ink} style={{ opacity: 0.6 }} />
          </View>
        );
      case 'conflicted':
        return (
          <View style={styles.syncBadge} accessibilityLabel="Sync conflict">
            <Ionicons name="alert-circle" size={15} color={theme.colors.warning} />
          </View>
        );
      case 'error':
        return (
          <View style={styles.syncBadge} accessibilityLabel="Sync error">
            <Ionicons name="alert-circle" size={15} color={theme.colors.danger} />
          </View>
        );
      default:
        return null;
    }
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${note.title || 'Untitled Note'}, ${note.isPinned ? 'Pinned' : ''}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: bg,
          borderColor: note.syncState === 'conflicted' ? theme.colors.warning : theme.colors.border,
          borderWidth: note.syncState === 'conflicted' ? 2 : 1,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.md,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {/* Top Header: Title + Pin/Sync Status */}
      <View style={styles.header}>
        {note.title ? (
          <Text
            numberOfLines={2}
            style={[
              styles.title,
              {
                color: ink,
                fontSize: theme.font.headline,
                fontWeight: theme.weight.bold,
              },
            ]}
          >
            {note.title}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}

        <View style={styles.headerIcons}>
          {renderSyncBadge()}
          {note.isPinned ? (
            <Ionicons
              name="pin"
              size={15}
              color={ink}
              style={{ marginLeft: 6, transform: [{ rotate: '45deg' }] }}
            />
          ) : null}
        </View>
      </View>

      {/* Body: Checklist preview or Text snippet */}
      {isChecklist ? (
        <View style={styles.checklistPreview}>
          {previewChecklist.map((item) => (
            <View key={item.id} style={styles.checklistItem}>
              <Ionicons
                name={item.checked ? 'checkbox' : 'square-outline'}
                size={14}
                color={ink}
                style={{ opacity: item.checked ? 0.5 : 0.85, marginRight: 6 }}
              />
              <Text
                numberOfLines={1}
                style={[
                  styles.checklistText,
                  {
                    color: ink,
                    fontSize: theme.font.callout,
                    opacity: item.checked ? 0.5 : 0.9,
                    textDecorationLine: item.checked ? 'line-through' : 'none',
                  },
                ]}
              >
                {item.text || 'Item'}
              </Text>
            </View>
          ))}
          {remainingChecklistCount > 0 ? (
            <Text style={[styles.moreText, { color: ink, fontSize: theme.font.caption, opacity: 0.6 }]}>
              +{remainingChecklistCount} more {remainingChecklistCount === 1 ? 'item' : 'items'}
            </Text>
          ) : null}
        </View>
      ) : note.content ? (
        <Text
          numberOfLines={4}
          style={[
            styles.content,
            {
              color: ink,
              fontSize: theme.font.body,
              opacity: 0.85,
              marginTop: note.title ? 6 : 0,
            },
          ]}
        >
          {note.content}
        </Text>
      ) : null}

      {/* Footer: Tags, Reminder, Priority, Date */}
      <View style={[styles.footer, { marginTop: theme.spacing.md }]}>
        <View style={styles.tagsRow}>
          {note.reminderTime ? (
            <View style={[styles.badge, { backgroundColor: 'rgba(0,0,0,0.06)' }]}>
              <Ionicons name="alarm-outline" size={11} color={ink} style={{ marginRight: 3 }} />
              <Text style={[styles.badgeText, { color: ink, fontSize: 10 }]}>
                {relativeTime(note.reminderTime)}
              </Text>
            </View>
          ) : null}

          {note.priority === 'urgent' || note.priority === 'high' ? (
            <View
              style={[
                styles.badge,
                {
                  backgroundColor:
                    note.priority === 'urgent' ? theme.colors.dangerSoft : theme.colors.warningSoft,
                },
              ]}
            >
              <Text
                style={[
                  styles.badgeText,
                  {
                    color:
                      note.priority === 'urgent' ? theme.colors.danger : theme.colors.warning,
                    fontSize: 10,
                    fontWeight: theme.weight.bold,
                  },
                ]}
              >
                {note.priority.toUpperCase()}
              </Text>
            </View>
          ) : null}

          {note.tags.slice(0, 2).map((t) => (
            <View key={t} style={[styles.badge, { backgroundColor: 'rgba(0,0,0,0.06)' }]}>
              <Text style={[styles.badgeText, { color: ink, fontSize: 10 }]}>#{t}</Text>
            </View>
          ))}
        </View>

        <Text style={[styles.dateText, { color: ink, fontSize: 11, opacity: 0.5 }]}>
          {relativeTime(note.updatedAt)}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 10,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  title: {
    flex: 1,
    letterSpacing: -0.2,
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
  },
  syncBadge: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    lineHeight: 20,
  },
  checklistPreview: {
    marginTop: 6,
    gap: 4,
  },
  checklistItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  checklistText: {
    flex: 1,
  },
  moreText: {
    marginTop: 2,
    fontStyle: 'italic',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tagsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 5,
    flex: 1,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeText: {
    letterSpacing: 0.1,
  },
  dateText: {
    marginLeft: 6,
  },
});
