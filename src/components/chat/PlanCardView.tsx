import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { ToolUseCard } from '@/models/chat';
import { JSONValue, jsonGet, jsonString } from '@/models/claude-events';
import { useTheme } from '@/hooks/use-theme';
import { FontSize, Spacing } from '@/constants/theme';

interface PlanCardViewProps {
  card: ToolUseCard;
}

interface TodoItem {
  id: string;
  content: string;
  status: 'completed' | 'in_progress' | 'pending';
}

function parseTodos(input: JSONValue): TodoItem[] {
  const todosRaw = jsonGet(input, 'todos');
  if (!Array.isArray(todosRaw)) return [];

  return todosRaw.map((item, index) => {
    const id = jsonString(jsonGet(item, 'id')) ?? `todo-${index}`;
    const content = jsonString(jsonGet(item, 'content')) ?? '';
    const status = jsonString(jsonGet(item, 'status')) as TodoItem['status'] ?? 'pending';
    return { id, content, status };
  });
}

function statusIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '\u2705';
    case 'in_progress':
      return '\u25B6\uFE0F';
    case 'pending':
      return '\u25CB';
  }
}

export function PlanCardView({ card }: PlanCardViewProps) {
  const colors = useTheme();
  const [expanded, setExpanded] = useState(false);

  const todos = parseTodos(card.input);
  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;

  return (
    <Pressable
      style={[
        styles.container,
        {
          backgroundColor: colors.toolCardBg,
          borderColor: colors.toolCardBorder,
        },
      ]}
      onPress={() => setExpanded((prev) => !prev)}
    >
      <View style={styles.header}>
        <Text style={styles.icon}>{'\uD83D\uDCCB'}</Text>
        <View style={styles.headerText}>
          <Text style={[styles.toolName, { color: colors.toolCardIcon }]}>
            Plan
          </Text>
          <Text style={[styles.progress, { color: colors.textSecondary }]}>
            {completedCount}/{totalCount} tasks completed
          </Text>
        </View>
        <Text style={[styles.chevron, { color: colors.textSecondary }]}>
          {expanded ? '\u25B2' : '\u25BC'}
        </Text>
      </View>

      {expanded && (
        <View style={styles.todoList}>
          {todos.map((todo) => (
            <View key={todo.id} style={styles.todoItem}>
              <Text style={styles.todoIcon}>{statusIcon(todo.status)}</Text>
              <Text
                style={[
                  styles.todoContent,
                  {
                    color:
                      todo.status === 'completed'
                        ? colors.textSecondary
                        : colors.text,
                  },
                  todo.status === 'completed' && styles.todoCompleted,
                ]}
              >
                {todo.content}
              </Text>
            </View>
          ))}
        </View>
      )}
    </Pressable>
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
  progress: {
    fontSize: FontSize.sm,
    flex: 1,
  },
  chevron: {
    fontSize: 10,
    marginLeft: Spacing.sm,
  },
  todoList: {
    marginTop: Spacing.md,
    gap: Spacing.sm,
  },
  todoItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  todoIcon: {
    fontSize: 14,
    marginTop: 1,
  },
  todoContent: {
    fontSize: FontSize.sm,
    flex: 1,
    lineHeight: 18,
  },
  todoCompleted: {
    textDecorationLine: 'line-through',
  },
});
