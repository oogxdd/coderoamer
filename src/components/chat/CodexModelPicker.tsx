import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { FontSize, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { CodexModelOption } from '@/services/codex-models';

interface CodexModelPickerProps {
  models: CodexModelOption[];
  value: string;
  onChange: (model: string) => void;
  loading?: boolean;
  disabled?: boolean;
}

export function CodexModelPicker({
  models,
  value,
  onChange,
  loading = false,
  disabled = false,
}: CodexModelPickerProps) {
  const colors = useTheme();
  const [customMode, setCustomMode] = useState(false);
  const selectedModel = models.find((model) => model.model === value);
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
          label="Codex default"
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
            label={model.displayName}
            selected={!customMode && value === model.model}
            disabled={disabled}
            onPress={() => {
              setCustomMode(false);
              onChange(model.model);
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
          placeholder="Model id"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}

      {(selectedModel?.description || (!loading && models.length === 0)) && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {selectedModel?.description ??
            'Open this picker on a Sprite to refresh the installed Codex model catalog.'}
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
