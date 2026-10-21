import React from 'react';
import { ScrollView, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/ThemeProvider';
import { NOTE_COLORS, type NoteColorId } from '@/theme/tokens';

export interface ColorPickerProps {
  selectedColor: NoteColorId;
  onSelectColor: (color: NoteColorId) => void;
}

export function ColorPicker({ selectedColor, onSelectColor }: ColorPickerProps) {
  const theme = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.container, { paddingHorizontal: theme.spacing.lg }]}
    >
      {NOTE_COLORS.map((colorKey) => {
        const isSelected = selectedColor === colorKey;
        const swatchBg = theme.note[colorKey];
        const inkColor = theme.noteInk[colorKey];

        return (
          <Pressable
            key={colorKey}
            onPress={() => onSelectColor(colorKey)}
            accessibilityLabel={`Note color ${colorKey}`}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            style={({ pressed }) => [
              styles.swatch,
              {
                backgroundColor: swatchBg,
                borderColor: isSelected ? theme.colors.primary : theme.colors.border,
                borderWidth: isSelected ? 2.5 : 1,
                opacity: pressed ? 0.75 : 1,
              },
            ]}
          >
            {isSelected ? (
              <Ionicons name="checkmark" size={18} color={inkColor} />
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 12,
  },
  swatch: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
