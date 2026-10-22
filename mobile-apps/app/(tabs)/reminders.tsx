import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  SectionList,
  RefreshControl,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/features/auth/AuthContext';
import { useSync } from '@/features/sync/SyncContext';
import { useTheme } from '@/theme/ThemeProvider';
import { NoteCard } from '@/components/notes/NoteCard';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Note } from '@/features/notes/types';

interface ReminderSection {
  title: string;
  data: Note[];
}

export default function RemindersScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session } = useAuth();
  const { notesRepo, runSync, syncStatus } = useSync();

  const activeWorkspaceId = session?.activeWorkspaceId || '';
  const [refreshing, setRefreshing] = useState(false);
  // "Now" for bucketing: captured at mount (lazy initializer — runs once) and
  // refreshed from each sync completion. Never read during render.
  const [nowBase] = useState(() => Date.now());
  const now = syncStatus.lastSyncAt ?? nowBase;

  // Derived synchronously from SQLite; recomputed after syncs and refreshes.
  const sections: ReminderSection[] = useMemo(() => {
    if (!activeWorkspaceId) return [];

    const res = notesRepo.listNotes({ workspaceId: activeWorkspaceId });
    const withReminders = res.notes.filter((n) => n.reminderTime != null && !n.isArchived && !n.deletedAt);

    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const endOfDayMs = endOfDay.getTime();

    const overdue: Note[] = [];
    const today: Note[] = [];
    const upcoming: Note[] = [];

    withReminders.forEach((note) => {
      const time = note.reminderTime!;
      if (time < now) {
        overdue.push(note);
      } else if (time <= endOfDayMs) {
        today.push(note);
      } else {
        upcoming.push(note);
      }
    });

    const list: ReminderSection[] = [];
    if (overdue.length > 0) list.push({ title: 'OVERDUE', data: overdue });
    if (today.length > 0) list.push({ title: 'TODAY', data: today });
    if (upcoming.length > 0) list.push({ title: 'UPCOMING', data: upcoming });
    return list;
    // `now` flows in via deps (sync completions re-bucket); SQLite reads are
    // the reason the repo deps are not referenced in the callback body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesRepo, activeWorkspaceId, syncStatus.lastSyncAt, syncStatus.pendingCount, now]);

  const totalCount = sections.reduce((acc, s) => acc + s.data.length, 0);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await runSync();
    } finally {
      setRefreshing(false);
    }
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
          Reminders
        </Text>
      </View>

      {totalCount === 0 ? (
        <EmptyState
          icon="alarm-outline"
          title="No active reminders"
          description="Add reminder times to any note to keep track of tasks, due dates, and deadlines."
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.listContent, { padding: theme.spacing.lg }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
          renderSectionHeader={({ section: { title } }) => (
            <Text
              style={[
                styles.sectionHeader,
                {
                  color: title === 'OVERDUE' ? theme.colors.danger : theme.colors.textSubtle,
                  fontSize: theme.font.caption,
                  fontWeight: theme.weight.bold,
                  marginTop: theme.spacing.sm,
                  marginBottom: theme.spacing.sm,
                },
              ]}
            >
              {title}
            </Text>
          )}
          renderItem={({ item }) => (
            <NoteCard
              note={item}
              onPress={() => router.push(`/note/${item.id}`)}
            />
          )}
        />
      )}
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
  listContent: {
    paddingBottom: 40,
  },
  sectionHeader: {
    letterSpacing: 0.5,
  },
});
