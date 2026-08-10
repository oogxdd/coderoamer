import React, { useMemo } from 'react';
import { StyleSheet, View, ViewStyle, StyleProp } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

interface SwipeBackViewProps {
  /** Called when a left-edge swipe to the right completes. */
  onSwipeBack?: () => void;
  enabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/** Width of the left strip where the gesture may begin, in points. */
const EDGE_WIDTH = 40;
/** How far right the finger must travel to count as "back". */
const DISTANCE_THRESHOLD = 60;
/** A quicker flick counts even if it didn't travel as far. */
const VELOCITY_THRESHOLD = 350;

/**
 * Left-edge swipe to go back, for "screens" that are really state inside one
 * route — the open conversation, a settings sub-view. The native stack gesture
 * can't see those, and would pop the whole screen instead of stepping back one
 * level, so callers disable it (`navigation.setOptions({ gestureEnabled })`)
 * while this is active.
 *
 * Deliberately narrow: it only starts within the left edge strip, only
 * activates on horizontal movement, and gives up as soon as the drag looks
 * vertical, so it can't steal from a scrolling transcript.
 */
export function SwipeBackView({ onSwipeBack, enabled = true, style, children }: SwipeBackViewProps) {
  const active = enabled && !!onSwipeBack;

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(active)
        .hitSlop({ left: 0, width: EDGE_WIDTH })
        .activeOffsetX(12)
        .failOffsetY([-20, 20])
        .onEnd((event) => {
          'worklet';
          if (!onSwipeBack) return;
          const far = event.translationX > DISTANCE_THRESHOLD;
          const fast = event.velocityX > VELOCITY_THRESHOLD && event.translationX > 20;
          if (far || fast) runOnJS(onSwipeBack)();
        }),
    [active, onSwipeBack]
  );

  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.flex, style]}>{children}</View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
