import React from 'react';
import {
  Pressable,
  View,
  Text,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/ThemeProvider';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  value?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  onPress?: () => void;
  destructive?: boolean;
  rightElement?: React.ReactNode;
  showChevron?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function ListRow({
  title,
  subtitle,
  value,
  icon,
  iconColor,
  onPress,
  destructive = false,
  rightElement,
  showChevron = true,
  style,
  testID,
}: ListRowProps) {
  const theme = useTheme();
  const isClickable = Boolean(onPress);

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!isClickable}
      accessibilityRole={isClickable ? 'button' : undefined}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderBottomWidth: StyleSheet.hairlineWidth,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
          minHeight: theme.touch,
          opacity: pressed ? 0.7 : 1,
        },
        style,
      ]}
    >
      {icon ? (
        <View
          style={[
            styles.iconContainer,
            {
              backgroundColor: theme.colors.surfaceAlt,
              borderRadius: theme.radii.sm,
              marginRight: theme.spacing.md,
            },
          ]}
        >
          <Ionicons
            name={icon}
            size={18}
            color={destructive ? theme.colors.danger : iconColor || theme.colors.primary}
          />
        </View>
      ) : null}

      <View style={styles.textContainer}>
        <Text
          style={[
            styles.title,
            {
              color: destructive ? theme.colors.danger : theme.colors.text,
              fontSize: theme.font.body,
              fontWeight: theme.weight.medium,
            },
          ]}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={[
              styles.subtitle,
              {
                color: theme.colors.textSubtle,
                fontSize: theme.font.callout,
                marginTop: 2,
              },
            ]}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>

      {rightElement ? (
        <View style={styles.right}>{rightElement}</View>
      ) : (
        <View style={styles.right}>
          {value ? (
            <Text
              style={[
                styles.value,
                { color: theme.colors.textSubtle, fontSize: theme.font.callout, marginRight: 4 },
              ]}
            >
              {value}
            </Text>
          ) : null}
          {showChevron && isClickable ? (
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textSubtle} />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconContainer: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    letterSpacing: 0.1,
  },
  subtitle: {
    lineHeight: 18,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  value: {
    letterSpacing: 0.1,
  },
});
