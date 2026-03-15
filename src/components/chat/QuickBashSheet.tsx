import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  Modal,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing, Fonts } from '@/constants/theme';
import * as api from '@/services/api';

interface QuickBashSheetProps {
  spriteName: string;
  onInsertIntoChat: (text: string) => void;
  onClose: () => void;
}

export function QuickBashSheet({
  spriteName,
  onInsertIntoChat,
  onClose,
}: QuickBashSheetProps) {
  const colors = useTheme();
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const handleRun = async () => {
    const cmd = command.trim();
    if (!cmd || isRunning) return;

    setIsRunning(true);
    setOutput('');
    setHasRun(true);

    try {
      const result = await api.runExec(spriteName, cmd, 30);
      const outputText = result.output || (result.success ? '(no output)' : '(command failed)');
      setOutput(outputText);
    } catch (err: any) {
      setOutput(`Error: ${err.message ?? 'Failed to run command'}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleInsert = () => {
    const trimmedOutput = output.trim();
    if (!trimmedOutput) return;

    const markdown = `\`\`\`\n$ ${command.trim()}\n${trimmedOutput}\n\`\`\``;
    onInsertIntoChat(markdown);
    onClose();
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={[styles.closeButton, { color: colors.tint }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.text }]}>Quick Bash</Text>
          <View style={{ width: 60 }} />
        </View>

        <View style={styles.content}>
          <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>COMMAND</Text>
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={[
                styles.commandInput,
                {
                  color: colors.text,
                  backgroundColor: colors.inputBackground,
                  borderColor: colors.border,
                  fontFamily: Fonts?.mono ?? 'monospace',
                },
              ]}
              placeholder="Enter bash command..."
              placeholderTextColor={colors.textSecondary}
              value={command}
              onChangeText={setCommand}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={handleRun}
              editable={!isRunning}
            />
            <Pressable
              style={[
                styles.runButton,
                {
                  backgroundColor:
                    command.trim() && !isRunning ? colors.tint : colors.backgroundElement,
                },
              ]}
              onPress={handleRun}
              disabled={!command.trim() || isRunning}
              hitSlop={8}
            >
              {isRunning ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={[styles.runButtonText, { opacity: command.trim() ? 1 : 0.4 }]}>
                  Run
                </Text>
              )}
            </Pressable>
          </View>

          {(hasRun || isRunning) && (
            <>
              <Text style={[styles.sectionLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>
                OUTPUT
              </Text>
              <ScrollView
                style={[styles.outputScroll, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}
                contentContainerStyle={styles.outputContent}
              >
                {isRunning ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="small" color={colors.tint} />
                    <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
                      Running...
                    </Text>
                  </View>
                ) : (
                  <Text
                    style={[
                      styles.outputText,
                      {
                        color: colors.text,
                        fontFamily: Fonts?.mono ?? 'monospace',
                      },
                    ]}
                    selectable
                  >
                    {output}
                  </Text>
                )}
              </ScrollView>

              {!isRunning && output.trim() && (
                <Pressable
                  style={[styles.insertButton, { backgroundColor: colors.tint }]}
                  onPress={handleInsert}
                >
                  <Text style={styles.insertButtonText}>Insert into Chat</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: FontSize.lg,
    fontWeight: '700',
  },
  closeButton: {
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    padding: Spacing.lg,
  },
  sectionLabel: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  commandInput: {
    flex: 1,
    fontSize: FontSize.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Platform.OS === 'ios' ? Spacing.md : Spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 40,
  },
  runButton: {
    paddingHorizontal: Spacing.lg,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
  },
  runButtonText: {
    color: '#FFFFFF',
    fontSize: FontSize.md,
    fontWeight: '600',
  },
  outputScroll: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
  },
  outputContent: {
    padding: Spacing.md,
  },
  outputText: {
    fontSize: FontSize.sm,
    lineHeight: 18,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
  },
  loadingText: {
    fontSize: FontSize.sm,
  },
  insertButton: {
    marginTop: Spacing.md,
    paddingVertical: Spacing.md,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insertButtonText: {
    color: '#FFFFFF',
    fontSize: FontSize.md,
    fontWeight: '600',
  },
});
