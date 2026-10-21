import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/features/auth/AuthContext';
import { useSync } from '@/features/sync/SyncContext';
import { useTheme } from '@/theme/ThemeProvider';
import { TextField } from '@/components/ui/TextField';
import { NoteCard } from '@/components/notes/NoteCard';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import type { Note } from '@/features/notes/types';

export default function SearchScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { session } = useAuth();
  const { notesRepo, workspaceRepo } = useSync();

  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [results, setResults] = useState<Note[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);

  const activeWorkspaceId = session?.activeWorkspaceId || '';

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const tags = workspaceRepo.listTags(activeWorkspaceId);
    setAvailableTags(tags.map((t) => t.name));
  }, [workspaceRepo, activeWorkspaceId]);

  const performSearch = useCallback(() => {
    if (!activeWorkspaceId) return;
    if (!query.trim() && !selectedTag) {
      setResults([]);
      return;
    }

    const res = notesRepo.listNotes({
      workspaceId: activeWorkspaceId,
      search: query.trim() || undefined,
      tagName: selectedTag || undefined,
    });
    setResults(res.notes);
  }, [notesRepo, activeWorkspaceId, query, selectedTag]);

  useEffect(() => {
    performSearch();
  }, [performSearch]);

  return (
    <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: theme.colors.bg }]}>
      {/* Search Input Box */}
      <View
        style={[
          styles.searchBox,
          {
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.md,
          },
        ]}
      >
        <TextField
          placeholder="Search notes, checklists, tags..."
          value={query}
          onChangeText={setQuery}
          leftIcon="search-outline"
          clearable
          autoCorrect={false}
          returnKeyType="search"
          containerStyle={{ marginBottom: theme.spacing.sm }}
        />

        {availableTags.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: theme.spacing.sm, gap: 6 }}
          >
            {availableTags.map((tag) => (
              <Chip
                key={tag}
                label={`#${tag}`}
                selected={selectedTag === tag}
                onPress={() => setSelectedTag(selectedTag === tag ? null : tag)}
                size="sm"
              />
            ))}
          </ScrollView>
        ) : null}
      </View>

      {/* Results List */}
      {!query.trim() && !selectedTag ? (
        <EmptyState
          icon="search-outline"
          title="Search your notes"
          description="Type a word, phrase, or select a tag above to search instantly across your notes."
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon="document-text-outline"
          title="No results found"
          description={`No notes matched "${query || selectedTag}". Try a different search term.`}
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.listContent, { padding: theme.spacing.lg }]}
          ListHeaderComponent={
            <Text
              style={[
                styles.resultCount,
                { color: theme.colors.textSubtle, fontSize: theme.font.caption, marginBottom: theme.spacing.sm },
              ]}
            >
              Found {results.length} {results.length === 1 ? 'note' : 'notes'}
            </Text>
          }
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
  searchBox: {
    borderBottomWidth: 1,
  },
  listContent: {
    paddingBottom: 40,
  },
  resultCount: {
    letterSpacing: 0.1,
  },
});
