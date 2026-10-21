import React from 'react';
import {
  Pressable,
  Text,
  ActivityIndicator,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

export interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'destructive' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  style,
  textStyle,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const getContainerStyle = (pressed: boolean): ViewStyle => {
    let bg = theme.colors.primary;
    let borderColor = 'transparent';
    let borderWidth = 0;

    switch (variant) {
      case 'primary':
        bg = theme.colors.primary;
        break;
      case 'secondary':
        bg = theme.colors.surfaceAlt;
        borderColor = theme.colors.border;
        borderWidth = 1;
        break;
      case 'destructive':
        bg = theme.colors.danger;
        break;
      case 'outline':
        bg = 'transparent';
        borderColor = theme.colors.border;
        borderWidth = 1.5;
        break;
      case 'ghost':
        bg = 'transparent';
        break;
    }

    const height = size === 'sm' ? 36 : size === 'lg' ? 52 : 44;
    const paddingHorizontal = size === 'sm' ? theme.spacing.md : theme.spacing.lg;
    const borderRadius = theme.radii.md;

    return {
      backgroundColor: bg,
      borderColor,
      borderWidth,
      height,
      minHeight: size === 'sm' ? 36 : theme.touch,
      paddingHorizontal,
      borderRadius,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: isDisabled ? 0.45 : pressed ? 0.8 : 1,
    };
  };

  const getTextColor = (): string => {
    switch (variant) {
      case 'primary':
        return theme.colors.primaryText;
      case 'secondary':
        return theme.colors.text;
      case 'destructive':
        return '#FFFFFF';
      case 'outline':
        return theme.colors.text;
      case 'ghost':
        return theme.colors.primary;
    }
  };

  const getFontSize = (): number => {
    return size === 'sm' ? theme.font.callout : size === 'lg' ? theme.font.headline : theme.font.body;
  };

  return (
    <Pressable
      testID={testID}
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [styles.base, getContainerStyle(pressed), style]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={getTextColor()} style={styles.indicator} />
      ) : (
        <>
          {icon ? <>{icon}</> : null}
          <Text
            style={[
              styles.text,
              {
                color: getTextColor(),
                fontSize: getFontSize(),
                fontWeight: theme.weight.semibold,
                marginLeft: icon ? theme.spacing.sm : 0,
              },
              textStyle,
            ]}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  text: {
    textAlign: 'center',
  },
  indicator: {
    marginVertical: 2,
  },
});
