import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

interface CreateSpriteSheetProps {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}

export function CreateSpriteSheet({ onClose, onCreate }: CreateSpriteSheetProps) {
  const colors = useTheme();
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string>();

  const handleCreate = async () => {
    const trimmed = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!trimmed) {
      setError('Please enter a name');
      return;
    }
    setIsCreating(true);
    setError(undefined);
    try {
      await onCreate(trimmed);
      onClose();
    } catch (err: any) {
      setError(err.message ?? 'Failed to create sprite');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.5)' }]}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.card }]}>
        <Text style={[styles.title, { color: colors.text }]}>New Sprite</Text>
        <TextInput
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.inputBackground,
              borderColor: colors.border,
            },
          ]}
          placeholder="sprite-name"
          placeholderTextColor={colors.textSecondary}
          value={name}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          editable={!isCreating}
        />
        {error && <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>}
        <View style={styles.buttons}>
          <Pressable
            style={[styles.button, { backgroundColor: colors.backgroundElement }]}
            onPress={onClose}
            disabled={isCreating}
          >
            <Text style={[styles.buttonText, { color: colors.text }]}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.primaryButton, { backgroundColor: colors.tint }]}
            onPress={handleCreate}
            disabled={isCreating || !name.trim()}
          >
            {isCreating ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={[styles.buttonText, { color: '#fff' }]}>Create</Text>
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: Spacing.xl,
    paddingBottom: 40,
  },
  title: {
    fontSize: FontSize.xl,
    fontWeight: '700',
    marginBottom: Spacing.lg,
  },
  input: {
    fontSize: FontSize.lg,
    padding: Spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: Spacing.md,
  },
  error: {
    fontSize: FontSize.sm,
    marginBottom: Spacing.sm,
  },
  buttons: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.sm,
  },
  button: {
    flex: 1,
    paddingVertical: Spacing.md,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  primaryButton: {},
  buttonText: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
});
