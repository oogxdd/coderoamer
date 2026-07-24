import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { ToolUseCard, toolUseSummary, toolUseIcon, toolElapsedString } from '@/models/chat';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing, Fonts } from '@/constants/theme';
import { ToolDetailSheet } from './ToolDetailSheet';
import { PlanCardView } from './PlanCardView';

interface ToolUseCardViewProps {
  card: ToolUseCard;
  workingDirectory?: string;
}

export function ToolUseCardView({ card, workingDirectory }: ToolUseCardViewProps) {
  const colors = useTheme();
  const [showDetail, setShowDetail] = useState(false);

  // Render PlanCardView for TodoWrite tool
  if (card.toolName === 'TodoWrite') {
    return <PlanCardView card={card} />;
  }

  const icon = toolUseIcon(card.toolName);
  const summary = toolUseSummary(card);
  const elapsed = toolElapsedString(card);
  const isComplete = !!card.result;

  // Relativize paths in summary
  const displaySummary =
    workingDirectory && summary.startsWith(workingDirectory)
      ? summary.slice(workingDirectory.length).replace(/^\//, '')
      : summary;

  return (
    <>
      <Pressable
        style={[
          styles.container,
          {
            backgroundColor: colors.toolCardBg,
            borderColor: colors.toolCardBorder,
          },
        ]}
        onPress={() => setShowDetail(true)}
      >
        <View style={styles.header}>
          <Text style={styles.icon}>{icon}</Text>
          <View style={styles.headerText}>
            <Text style={[styles.toolName, { color: colors.toolCardIcon }]}>
              {card.toolName}
            </Text>
            <Text
              style={[styles.summary, { color: colors.textSecondary }]}
              numberOfLines={1}
            >
              {displaySummary}
            </Text>
          </View>
          {isComplete && elapsed && (
            <Text style={[styles.elapsed, { color: colors.textSecondary }]}>
              {elapsed}
            </Text>
          )}
          {!isComplete && (
            <Text style={[styles.spinner, { color: colors.toolCardIcon }]}>⟳</Text>
          )}
        </View>

        {(card.result?.content || card.liveOutput) && (
          <ResultPreview content={card.result?.content ?? card.liveOutput} colors={colors} />
        )}
      </Pressable>

      {showDetail && (
        <ToolDetailSheet card={card} onClose={() => setShowDetail(false)} />
      )}
    </>
  );
}

function ResultPreview({ content, colors }: { content: any; colors: any }) {
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const strings = content.filter((x: any) => typeof x === 'string');
    if (strings.length > 0) text = strings.join('\n');
    else {
      const texts = content
        .filter((x: any) => x && typeof x === 'object' && typeof x.text === 'string')
        .map((x: any) => x.text);
      text = texts.join('\n');
    }
  } else {
    return null;
  }

  if (!text) return null;

  const lines = text.slice(-600).split('\n').slice(-2);
  const preview = lines.join('\n');

  return (
    <Text
      style={[
        styles.preview,
        {
          color: colors.textSecondary,
          fontFamily: Fonts?.mono ?? 'monospace',
        },
      ]}
      numberOfLines={2}
    >
      {preview}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: Spacing.lg,
    marginVertical: Spacing.xs,
    borderRadius: 10,
    borderWidth: 1,
    padding: Spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    fontSize: 16,
    marginRight: Spacing.sm,
  },
  headerText: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  toolName: {
    fontSize: FontSize.sm,
    fontWeight: '600',
  },
  summary: {
    fontSize: FontSize.sm,
    flex: 1,
  },
  elapsed: {
    fontSize: FontSize.xs,
    marginLeft: Spacing.sm,
  },
  spinner: {
    fontSize: 16,
    marginLeft: Spacing.sm,
  },
  preview: {
    fontSize: FontSize.xs,
    marginTop: Spacing.sm,
    lineHeight: 16,
  },
});
