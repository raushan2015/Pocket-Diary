import React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

export interface CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  variant?: 'elevated' | 'outlined' | 'flat';
}

export function Card({ children, style, variant = 'outlined' }: CardProps) {
  const theme = useTheme();

  const getVariantStyle = (): ViewStyle => {
    switch (variant) {
      case 'elevated':
        return {
          backgroundColor: theme.colors.surface,
          shadowColor: '#000000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: theme.dark ? 0.3 : 0.08,
          shadowRadius: 6,
          elevation: 3,
          borderWidth: theme.dark ? 1 : 0,
          borderColor: theme.colors.border,
        };
      case 'outlined':
        return {
          backgroundColor: theme.colors.surface,
          borderWidth: 1,
          borderColor: theme.colors.border,
        };
      case 'flat':
        return {
          backgroundColor: theme.colors.surfaceAlt,
        };
    }
  };

  return (
    <View
      style={[
        styles.card,
        {
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
        },
        getVariantStyle(),
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
  },
});
