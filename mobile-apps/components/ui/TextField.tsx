import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  type TextInputProps,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/ThemeProvider';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  helperText?: string;
  error?: string | null;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightIconPress?: () => void;
  isPassword?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  clearable?: boolean;
}

export function TextField({
  label,
  helperText,
  error,
  leftIcon,
  rightIcon,
  onRightIconPress,
  isPassword = false,
  containerStyle,
  inputStyle,
  clearable = false,
  value,
  onChangeText,
  onFocus,
  onBlur,
  disabled = false,
  placeholder,
  ...rest
}: TextFieldProps & { disabled?: boolean }) {
  const theme = useTheme();
  const [isFocused, setIsFocused] = useState(false);
  const [showPassword, setShowPassword] = useState(!isPassword);

  const hasError = Boolean(error);

  const borderColor = hasError
    ? theme.colors.danger
    : isFocused
    ? theme.colors.primary
    : theme.colors.border;

  return (
    <View style={[styles.wrapper, containerStyle]}>
      {label ? (
        <Text
          style={[
            styles.label,
            {
              color: hasError ? theme.colors.danger : theme.colors.textSubtle,
              fontSize: theme.font.callout,
              fontWeight: theme.weight.medium,
              marginBottom: theme.spacing.xs,
            },
          ]}
        >
          {label}
        </Text>
      ) : null}

      <View
        style={[
          styles.inputContainer,
          {
            backgroundColor: theme.colors.surface,
            borderColor,
            borderRadius: theme.radii.md,
            minHeight: theme.touch,
            paddingHorizontal: theme.spacing.md,
          },
          disabled && { opacity: 0.5, backgroundColor: theme.colors.surfaceAlt },
        ]}
      >
        {leftIcon ? (
          <Ionicons
            name={leftIcon}
            size={theme.icon.sm}
            color={hasError ? theme.colors.danger : isFocused ? theme.colors.primary : theme.colors.textSubtle}
            style={{ marginRight: theme.spacing.sm }}
          />
        ) : null}

        <TextInput
          value={value}
          onChangeText={onChangeText}
          editable={!disabled}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textSubtle}
          secureTextEntry={isPassword && !showPassword}
          onFocus={(e) => {
            setIsFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setIsFocused(false);
            onBlur?.(e);
          }}
          style={[
            styles.input,
            {
              color: theme.colors.text,
              fontSize: theme.font.body,
            },
            inputStyle,
          ]}
          {...rest}
        />

        {clearable && value && !disabled ? (
          <Pressable
            hitSlop={8}
            onPress={() => onChangeText?.('')}
            accessibilityLabel="Clear text"
            accessibilityRole="button"
            style={styles.iconButton}
          >
            <Ionicons name="close-circle" size={18} color={theme.colors.textSubtle} />
          </Pressable>
        ) : null}

        {isPassword ? (
          <Pressable
            hitSlop={8}
            onPress={() => setShowPassword((prev) => !prev)}
            accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
            accessibilityRole="button"
            style={styles.iconButton}
          >
            <Ionicons
              name={showPassword ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={theme.colors.textSubtle}
            />
          </Pressable>
        ) : rightIcon ? (
          <Pressable
            hitSlop={8}
            onPress={onRightIconPress}
            accessibilityRole={onRightIconPress ? 'button' : undefined}
            style={styles.iconButton}
          >
            <Ionicons name={rightIcon} size={20} color={theme.colors.textSubtle} />
          </Pressable>
        ) : null}
      </View>

      {hasError ? (
        <Text
          style={[
            styles.helperText,
            { color: theme.colors.danger, fontSize: theme.font.caption, marginTop: theme.spacing.xs },
          ]}
        >
          {error}
        </Text>
      ) : helperText ? (
        <Text
          style={[
            styles.helperText,
            { color: theme.colors.textSubtle, fontSize: theme.font.caption, marginTop: theme.spacing.xs },
          ]}
        >
          {helperText}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    marginBottom: 12,
  },
  label: {
    letterSpacing: 0.1,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
  },
  input: {
    flex: 1,
    paddingVertical: 10,
  },
  iconButton: {
    padding: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  helperText: {
    lineHeight: 16,
  },
});
