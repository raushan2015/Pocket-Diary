import React from 'react';
import {
  Pressable,
  Text,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/ThemeProvider';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  color?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  size?: 'sm' | 'md';
}

export function Chip({
  label,
  selected = false,
  onPress,
  onRemove,
  icon,
  color,
  style,
  textStyle,
  size = 'md',
}: ChipProps) {
  const theme = useTheme();

  const isClickable = Boolean(onPress);
  const isSm = size === 'sm';

  const bg = selected
    ? theme.colors.primary
    : color
    ? color
    : theme.colors.surfaceAlt;

  const textColor = selected
    ? theme.colors.primaryText
    : theme.colors.text;

  return (
    <Pressable
      onPress={onPress}
      disabled={!isClickable}
      accessibilityRole={isClickable ? 'button' : undefined}
      accessibilityState={isClickable ? { selected } : undefined}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: bg,
          borderColor: selected ? theme.colors.primary : theme.colors.border,
          borderWidth: selected ? 0 : 1,
          borderRadius: theme.radii.pill,
          paddingHorizontal: isSm ? theme.spacing.sm : theme.spacing.md,
          paddingVertical: isSm ? 4 : 6,
          opacity: pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={isSm ? 12 : 14}
          color={textColor}
          style={{ marginRight: 4 }}
        />
      ) : null}

      <Text
        style={[
          styles.label,
          {
            color: textColor,
            fontSize: isSm ? theme.font.caption : theme.font.callout,
            fontWeight: selected ? theme.weight.semibold : theme.weight.medium,
          },
          textStyle,
        ]}
      >
        {label}
      </Text>

      {onRemove ? (
        <Pressable
          hitSlop={6}
          onPress={onRemove}
          accessibilityLabel={`Remove ${label}`}
          accessibilityRole="button"
          style={{ marginLeft: 4 }}
        >
          <Ionicons name="close" size={isSm ? 12 : 14} color={textColor} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  label: {
    letterSpacing: 0.1,
  },
});
