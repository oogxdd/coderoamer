import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

interface CreateCheckpointSheetProps {
  onClose: () => void;
  onCreate: (comment?: string) => Promise<void>;
}

export function CreateCheckpointSheet({ onClose, onCreate }: CreateCheckpointSheetProps) {
  const colors = useTheme();
  const [comment, setComment] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string>();

  const handleCreate = async () => {
    setIsCreating(true);
    setError(undefined);
    try {
      await onCreate(comment.trim() || undefined);
      onClose();
    } catch (err: any) {
      setError(err.message ?? 'Failed to create checkpoint');
    }
    setIsCreating(false);
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.card }]}>
        <Text style={[styles.title, { color: colors.text }]}>New Checkpoint</Text>
        <TextInput
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.inputBackground,
              borderColor: colors.border,
            },
          ]}
          placeholder="Label (optional)"
          placeholderTextColor={colors.textSecondary}
          value={comment}
          onChangeText={setComment}
          autoFocus
          editable={!isCreating}
        />
        {error && <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>}
        <View style={styles.buttons}>
          <Pressable
            style={[styles.button, { backgroundColor: colors.backgroundElement }]}
            onPress={onClose}
          >
            <Text style={[styles.buttonText, { color: colors.text }]}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.button, { backgroundColor: colors.tint }]}
            onPress={handleCreate}
            disabled={isCreating}
          >
            {isCreating ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={[styles.buttonText, { color: '#fff' }]}>Create</Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
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
    minHeight: 44,
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: FontSize.lg,
    fontWeight: '600',
  },
});
