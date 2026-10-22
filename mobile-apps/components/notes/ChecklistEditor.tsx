import React, { useRef } from 'react';
import {
  View,
  TextInput,
  Pressable,
  StyleSheet,
  type TextInputInstance,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/ThemeProvider';
import type { ChecklistItem } from '@/features/notes/types';
import { generateLocalId } from '@/utils/ids';

export interface ChecklistEditorProps {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => void;
  inkColor?: string;
  editable?: boolean;
}

export function ChecklistEditor({
  items,
  onChange,
  inkColor,
  editable = true,
}: ChecklistEditorProps) {
  const theme = useTheme();
  const ink = inkColor || theme.colors.text;
  const inputRefs = useRef<Record<string, TextInputInstance | null>>({});

  const handleToggle = (id: string) => {
    if (!editable) return;
    const next = items.map((it) => (it.id === id ? { ...it, checked: !it.checked } : it));
    onChange(next);
  };

  const handleTextChange = (id: string, text: string) => {
    if (!editable) return;
    const next = items.map((it) => (it.id === id ? { ...it, text } : it));
    onChange(next);
  };

  const handleDelete = (id: string) => {
    if (!editable) return;
    const next = items.filter((it) => it.id !== id);
    onChange(next);
  };

  const handleAddItem = (afterId?: string) => {
    if (!editable) return;
    const newItem: ChecklistItem = {
      id: generateLocalId(),
      text: '',
      checked: false,
    };

    if (!afterId) {
      onChange([...items, newItem]);
    } else {
      const idx = items.findIndex((it) => it.id === afterId);
      const next = [...items];
      next.splice(idx + 1, 0, newItem);
      onChange(next);
    }

    setTimeout(() => {
      inputRefs.current[newItem.id]?.focus();
    }, 50);
  };

  return (
    <View style={styles.container}>
      {items.map((item) => (
        <View key={item.id} style={styles.row}>
          <Pressable
            hitSlop={8}
            onPress={() => handleToggle(item.id)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: item.checked }}
            accessibilityLabel={item.text || 'Checklist item'}
            style={styles.checkButton}
          >
            <Ionicons
              name={item.checked ? 'checkbox' : 'square-outline'}
              size={20}
              color={item.checked ? theme.colors.primary : ink}
              style={{ opacity: item.checked ? 0.6 : 0.8 }}
            />
          </Pressable>

          <TextInput
            ref={(r) => {
              inputRefs.current[item.id] = r;
            }}
            value={item.text}
            onChangeText={(t) => handleTextChange(item.id, t)}
            onSubmitEditing={() => handleAddItem(item.id)}
            placeholder="List item"
            placeholderTextColor={theme.colors.textSubtle}
            editable={editable}
            returnKeyType="next"
            blurOnSubmit={false}
            style={[
              styles.textInput,
              {
                color: ink,
                fontSize: theme.font.body,
                opacity: item.checked ? 0.5 : 1,
                textDecorationLine: item.checked ? 'line-through' : 'none',
              },
            ]}
          />

          {editable ? (
            <Pressable
              hitSlop={8}
              onPress={() => handleDelete(item.id)}
              accessibilityLabel="Delete item"
              accessibilityRole="button"
              style={styles.deleteButton}
            >
              <Ionicons name="close" size={18} color={theme.colors.textSubtle} />
            </Pressable>
          ) : null}
        </View>
      ))}

      {editable ? (
        <Pressable
          onPress={() => handleAddItem()}
          accessibilityRole="button"
          accessibilityLabel="Add checklist item"
          style={[styles.addRow, { marginTop: 4 }]}
        >
          <Ionicons name="add" size={20} color={theme.colors.primary} style={{ marginRight: 8 }} />
          <TextInput
            pointerEvents="none"
            editable={false}
            placeholder="List item"
            placeholderTextColor={theme.colors.textSubtle}
            style={[styles.addText, { color: theme.colors.textSubtle, fontSize: theme.font.body }]}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    paddingVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 40,
    marginVertical: 2,
  },
  checkButton: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  textInput: {
    flex: 1,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  deleteButton: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 40,
    paddingHorizontal: 6,
  },
  addText: {
    flex: 1,
    paddingVertical: 6,
  },
});
