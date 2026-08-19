import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { PiModelOption } from '@/services/pi-models';

interface PiModelPickerProps {
  models: PiModelOption[];
  value: string;
  onChange: (model: string) => void;
  loading?: boolean;
  disabled?: boolean;
}

/**
 * Chip picker for the pi agent's model catalog (`pi --list-models`). Values are
 * the `provider/model` ids pi's `--model` flag accepts; empty = pi's own
 * default model. Mirrors CodexModelPicker.
 */
export function PiModelPicker({
  models,
  value,
  onChange,
  loading = false,
  disabled = false,
}: PiModelPickerProps) {
  const colors = useTheme();
  const [customMode, setCustomMode] = useState(false);
  const selectedModel = models.find((model) => model.id === value);
  const showCustomInput = customMode || (!!value && !selectedModel);

  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.options}
        keyboardShouldPersistTaps="handled"
      >
        <ModelChip
          label="Pi default"
          selected={!value && !customMode}
          disabled={disabled}
          onPress={() => {
            setCustomMode(false);
            onChange('');
          }}
        />
        {models.map((model) => (
          <ModelChip
            key={model.id}
            label={model.model}
            selected={!customMode && value === model.id}
            disabled={disabled}
            onPress={() => {
              setCustomMode(false);
              onChange(model.id);
            }}
          />
        ))}
        <ModelChip
          label="Custom"
          selected={showCustomInput}
          disabled={disabled}
          onPress={() => setCustomMode(true)}
        />
        {loading && <ActivityIndicator size="small" color={colors.tint} style={styles.loader} />}
      </ScrollView>

      {showCustomInput && (
        <TextInput
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.inputBackground,
              borderColor: colors.border,
            },
          ]}
          value={value}
          onChangeText={onChange}
          editable={!disabled}
          placeholder="provider/model"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}

      {(selectedModel || (!loading && models.length === 0)) && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {selectedModel
            ? `${selectedModel.provider} · ${selectedModel.supportsThinking ? 'thinking' : 'no thinking'} · ${selectedModel.supportsImages ? 'images' : 'text only'}`
            : 'Open this picker on a Sprite to refresh the installed pi model catalog.'}
        </Text>
      )}
    </View>
  );
}

interface ModelChipProps {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}

function ModelChip({ label, selected, disabled, onPress }: ModelChipProps) {
  const colors = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      style={[
        styles.chip,
        { borderColor: colors.border, backgroundColor: colors.backgroundElement },
        selected && { borderColor: colors.tint, backgroundColor: `${colors.tint}12` },
      ]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={[styles.chipText, { color: selected ? colors.tint : colors.textSecondary }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  options: {
    gap: Spacing.sm,
    paddingVertical: 2,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  chipText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  loader: {
    marginHorizontal: Spacing.sm,
  },
  input: {
    fontSize: FontSize.md,
    padding: Spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: Spacing.sm,
  },
  hint: {
    fontSize: FontSize.xs,
    lineHeight: 17,
    marginTop: Spacing.sm,
  },
});
