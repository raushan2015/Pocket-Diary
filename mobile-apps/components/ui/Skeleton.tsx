import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
}

export function Skeleton({
  width = '100%',
  height = 20,
  borderRadius,
  style,
}: SkeletonProps) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.8,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        styles.skeleton,
        {
          width: width as any,
          height,
          borderRadius: borderRadius ?? theme.radii.sm,
          backgroundColor: theme.colors.surfaceAlt,
          opacity,
        },
        style,
      ]}
    />
  );
}

export function NoteCardSkeleton() {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.lg,
          marginBottom: theme.spacing.md,
        },
      ]}
    >
      <Skeleton width="60%" height={18} style={{ marginBottom: 12 }} />
      <Skeleton width="95%" height={14} style={{ marginBottom: 6 }} />
      <Skeleton width="80%" height={14} style={{ marginBottom: 16 }} />
      <View style={styles.row}>
        <Skeleton width={60} height={20} borderRadius={10} style={{ marginRight: 8 }} />
        <Skeleton width={45} height={20} borderRadius={10} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    overflow: 'hidden',
  },
  card: {
    borderWidth: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
