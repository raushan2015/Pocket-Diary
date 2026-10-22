/**
 * Tag editor: chips for current tags + a compact inline add input.
 * Tags sync by name (the server dedupes case-insensitively).
 */
import React, { useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/ThemeProvider';

export interface TagEditorProps {
  tags: string[];
  disabled?: boolean;
  onChange(tags: string[]): void;
}

export function TagEditor({ tags, disabled, onChange }: TagEditorProps) {
  const theme = useTheme();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const commitDraft = () => {
    const cleaned = draft
      .split(',')
      .map((t) => t.trim().replace(/^#/, ''))
      .filter(Boolean);
    if (cleaned.length > 0) {
      const next = [...tags];
      for (const t of cleaned) {
        if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
      }
      onChange(next);
    }
    setDraft('');
    setAdding(false);
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
      <Ionicons
        name="pricetag-outline"
        size={20}
        color={tags.length > 0 ? theme.colors.primary : theme.colors.textSubtle}
        style={{ marginRight: theme.spacing.md }}
      />
      <View style={styles.chipWrap}>
        {tags.map((tag) => (
          <View
            key={tag}
            style={[styles.chip, { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radii.pill }]}
          >
            <Text style={{ color: theme.colors.text, fontSize: theme.font.caption }}>#{tag}</Text>
            {!disabled ? (
              <Pressable
                onPress={() => removeTag(tag)}
                accessibilityRole="button"
                accessibilityLabel={`Remove tag ${tag}`}
                hitSlop={8}
                style={styles.chipX}
              >
                <Ionicons name="close" size={13} color={theme.colors.textSubtle} />
              </Pressable>
            ) : null}
          </View>
        ))}

        {adding ? (
          <TextInput
            autoFocus
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={commitDraft}
            onBlur={commitDraft}
            placeholder="tag, another tag"
            placeholderTextColor={theme.colors.textSubtle}
            returnKeyType="done"
            style={[
              styles.input,
              {
                color: theme.colors.text,
                fontSize: theme.font.caption,
                borderColor: theme.colors.primary,
                borderRadius: theme.radii.pill,
              },
            ]}
          />
        ) : !disabled ? (
          <Pressable
            onPress={() => setAdding(true)}
            accessibilityRole="button"
            accessibilityLabel="Add tag"
            hitSlop={8}
            style={[styles.addChip, { borderColor: theme.colors.border, borderRadius: theme.radii.pill }]}
          >
            <Ionicons name="add" size={14} color={theme.colors.primary} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chipWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipX: {
    marginLeft: 4,
    padding: 2,
  },
  addChip: {
    borderWidth: 1,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 3,
    minWidth: 120,
  },
});
