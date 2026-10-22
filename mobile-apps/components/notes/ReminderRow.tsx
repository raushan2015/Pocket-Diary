/**
 * Reminder row: sets or clears a note's reminder time.
 * iOS: compact 'datetime' picker (inline, committed on Done);
 * Android: system dialogs, staged date → time.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/theme/ThemeProvider';
import { formatDateTime } from '@/utils/time';

export interface ReminderRowProps {
  reminderTime: number | null;
  disabled?: boolean;
  onChange(time: number | null): void;
}

export function ReminderRow({ reminderTime, disabled, onChange }: ReminderRowProps) {
  const theme = useTheme();
  const [showIosPicker, setShowIosPicker] = useState(false);
  const [androidStage, setAndroidStage] = useState<'date' | 'time' | null>(null);
  const [stagedDate, setStagedDate] = useState<number | null>(null);
  // Picker input values are computed once, when the picker opens (event
  // handler) — never during render.
  const [pickerBase, setPickerBase] = useState<number>(0);

  const openPicker = () => {
    setStagedDate(null);
    setPickerBase(Date.now() + 60 * 60 * 1000);
    if (Platform.OS === 'android') {
      setAndroidStage('date');
    } else {
      setShowIosPicker(true);
    }
  };

  const handleIosChange = (_event: unknown, date?: Date) => {
    if (date) onChange(date.getTime());
  };

  const handleAndroidDate = (_event: unknown, date?: Date) => {
    setAndroidStage(null);
    if (!date) return;
    setStagedDate(date.getTime());
    setAndroidStage('time');
  };

  const handleAndroidTime = (_event: unknown, date?: Date) => {
    setAndroidStage(null);
    if (!date || stagedDate == null) return;
    // Combine the picked calendar date with the picked time-of-day.
    const combined = new Date(stagedDate);
    const time = new Date(date);
    combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
    onChange(combined.getTime());
  };

  return (
    <View style={styles.wrap}>
      <View style={[styles.row, { borderBottomColor: theme.colors.border }]}>
        <Ionicons
          name="alarm-outline"
          size={20}
          color={reminderTime ? theme.colors.primary : theme.colors.textSubtle}
          style={{ marginRight: theme.spacing.md }}
        />
        <View style={styles.info}>
          {reminderTime ? (
            <>
              <Text
                style={{ color: theme.colors.text, fontSize: theme.font.callout, fontWeight: theme.weight.medium }}
              >
                {formatDateTime(reminderTime)}
              </Text>
              <Text style={{ color: theme.colors.textSubtle, fontSize: theme.font.caption }}>
                {"You'll be notified when it's due (best effort by the OS)."}
              </Text>
            </>
          ) : (
            <Text style={{ color: theme.colors.textSubtle, fontSize: theme.font.callout }}>
              No reminder set
            </Text>
          )}
        </View>

        {!disabled ? (
          <View style={styles.actions}>
            {reminderTime ? (
              <>
                <Pressable
                  onPress={openPicker}
                  accessibilityRole="button"
                  accessibilityLabel="Change reminder time"
                  hitSlop={8}
                  style={styles.actionBtn}
                >
                  <Ionicons name="create-outline" size={20} color={theme.colors.primary} />
                </Pressable>
                <Pressable
                  onPress={() => onChange(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Clear reminder"
                  hitSlop={8}
                  style={styles.actionBtn}
                >
                  <Ionicons name="close-circle-outline" size={20} color={theme.colors.textSubtle} />
                </Pressable>
              </>
            ) : (
              <Pressable
                onPress={openPicker}
                accessibilityRole="button"
                accessibilityLabel="Add a reminder"
                hitSlop={8}
                style={[styles.addBtn, { borderColor: theme.colors.border, borderRadius: theme.radii.pill }]}
              >
                <Ionicons name="add" size={16} color={theme.colors.primary} />
                <Text
                  style={{
                    color: theme.colors.primary,
                    fontSize: theme.font.caption,
                    fontWeight: theme.weight.semibold,
                    marginLeft: 4,
                  }}
                >
                  Remind me
                </Text>
              </Pressable>
            )}
          </View>
        ) : null}
      </View>

      {showIosPicker && Platform.OS === 'ios' ? (
        <View style={[styles.iosPickerCard, { backgroundColor: theme.colors.surfaceAlt, borderRadius: theme.radii.md }]}>
          <DateTimePicker
            value={reminderTime ? new Date(reminderTime) : new Date(pickerBase)}
            mode="datetime"
            display="compact"
            minimumDate={pickerBase ? new Date(pickerBase - 60 * 60 * 1000) : undefined}
            onChange={handleIosChange}
          />
          <Pressable
            onPress={() => setShowIosPicker(false)}
            accessibilityRole="button"
            accessibilityLabel="Done setting reminder"
            style={[styles.doneBtn, { borderColor: theme.colors.primary, borderRadius: theme.radii.sm }]}
          >
            <Text style={{ color: theme.colors.primary, fontWeight: theme.weight.semibold, fontSize: theme.font.callout }}>
              Done
            </Text>
          </Pressable>
        </View>
      ) : null}

      {androidStage === 'date' ? (
        <DateTimePicker
          value={reminderTime ? new Date(reminderTime) : new Date(pickerBase)}
          mode="date"
          display="default"
          minimumDate={pickerBase ? new Date(pickerBase - 60 * 60 * 1000) : undefined}
          onChange={handleAndroidDate}
        />
      ) : null}
      {androidStage === 'time' ? (
        <DateTimePicker
          value={stagedDate ? new Date(stagedDate) : new Date(pickerBase)}
          mode="time"
          display="default"
          is24Hour
          onChange={handleAndroidTime}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  info: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionBtn: {
    padding: 8,
    marginLeft: 4,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  iosPickerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  doneBtn: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
});
