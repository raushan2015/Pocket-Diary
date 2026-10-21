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

export interface BannerProps {
  title?: string;
  message: string;
  variant?: 'info' | 'warning' | 'error' | 'success' | 'conflict';
  onAction?: () => void;
  actionLabel?: string;
  onSecondaryAction?: () => void;
  secondaryActionLabel?: string;
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function Banner({
  title,
  message,
  variant = 'info',
  onAction,
  actionLabel,
  onSecondaryAction,
  secondaryActionLabel,
  onDismiss,
  style,
}: BannerProps) {
  const theme = useTheme();

  const getColors = () => {
    switch (variant) {
      case 'info':
        return {
          bg: theme.colors.primarySoft,
          border: theme.colors.primary,
          icon: theme.colors.primary,
          text: theme.colors.text,
          name: 'information-circle-outline' as const,
        };
      case 'warning':
        return {
          bg: theme.colors.warningSoft,
          border: theme.colors.warning,
          icon: theme.colors.warning,
          text: theme.colors.text,
          name: 'warning-outline' as const,
        };
      case 'error':
        return {
          bg: theme.colors.dangerSoft,
          border: theme.colors.danger,
          icon: theme.colors.danger,
          text: theme.colors.text,
          name: 'alert-circle-outline' as const,
        };
      case 'success':
        return {
          bg: theme.colors.successSoft,
          border: theme.colors.success,
          icon: theme.colors.success,
          text: theme.colors.text,
          name: 'checkmark-circle-outline' as const,
        };
      case 'conflict':
        return {
          bg: theme.colors.warningSoft,
          border: theme.colors.warning,
          icon: theme.colors.warning,
          text: theme.colors.text,
          name: 'git-compare-outline' as const,
        };
    }
  };

  const config = getColors();

  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.container,
        {
          backgroundColor: config.bg,
          borderColor: config.border,
          borderRadius: theme.radii.md,
          padding: theme.spacing.md,
        },
        style,
      ]}
    >
      <View style={styles.topRow}>
        <Ionicons
          name={config.name}
          size={20}
          color={config.icon}
          style={{ marginRight: theme.spacing.sm, marginTop: 1 }}
        />

        <View style={styles.content}>
          {title ? (
            <Text
              style={[
                styles.title,
                {
                  color: config.text,
                  fontSize: theme.font.callout,
                  fontWeight: theme.weight.semibold,
                  marginBottom: 2,
                },
              ]}
            >
              {title}
            </Text>
          ) : null}

          <Text
            style={[
              styles.message,
              {
                color: theme.colors.textSubtle,
                fontSize: theme.font.callout,
                lineHeight: 18,
              },
            ]}
          >
            {message}
          </Text>
        </View>

        {onDismiss ? (
          <Pressable
            hitSlop={8}
            onPress={onDismiss}
            accessibilityLabel="Dismiss banner"
            accessibilityRole="button"
            style={styles.dismissButton}
          >
            <Ionicons name="close" size={18} color={theme.colors.textSubtle} />
          </Pressable>
        ) : null}
      </View>

      {onAction || onSecondaryAction ? (
        <View style={[styles.actionsRow, { marginTop: theme.spacing.sm }]}>
          {onSecondaryAction && secondaryActionLabel ? (
            <Pressable
              onPress={onSecondaryAction}
              accessibilityRole="button"
              style={[
                styles.actionBtn,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: theme.radii.sm,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: 6,
                  marginRight: theme.spacing.sm,
                },
              ]}
            >
              <Text
                style={{
                  color: theme.colors.text,
                  fontSize: theme.font.caption,
                  fontWeight: theme.weight.semibold,
                }}
              >
                {secondaryActionLabel}
              </Text>
            </Pressable>
          ) : null}

          {onAction && actionLabel ? (
            <Pressable
              onPress={onAction}
              accessibilityRole="button"
              style={[
                styles.actionBtn,
                {
                  backgroundColor: config.icon,
                  borderRadius: theme.radii.sm,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: 6,
                },
              ]}
            >
              <Text
                style={{
                  color: '#FFFFFF',
                  fontSize: theme.font.caption,
                  fontWeight: theme.weight.semibold,
                }}
              >
                {actionLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderLeftWidth: 4,
    marginVertical: 6,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  content: {
    flex: 1,
  },
  title: {
    letterSpacing: 0.1,
  },
  message: {
    letterSpacing: 0.1,
  },
  dismissButton: {
    padding: 2,
    marginLeft: 6,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
  },
});
