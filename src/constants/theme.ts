import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    textSecondary: '#60646C',
    background: '#FFFFFF',
    backgroundSecondary: '#F2F2F7',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    border: '#C6C6C8',
    tint: '#007AFF',
    destructive: '#FF3B30',
    success: '#34C759',
    warning: '#FF9500',
    card: '#FFFFFF',
    inputBackground: '#F2F2F7',
    userBubble: '#007AFF',
    userBubbleText: '#FFFFFF',
    assistantBubble: '#F2F2F7',
    assistantBubbleText: '#000000',
    toolCardBg: '#FFF8F0',
    toolCardBorder: '#FFD9A0',
    toolCardIcon: '#FF9500',
  },
  dark: {
    text: '#FFFFFF',
    textSecondary: '#B0B4BA',
    background: '#000000',
    backgroundSecondary: '#1C1C1E',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    border: '#38383A',
    tint: '#0A84FF',
    destructive: '#FF453A',
    success: '#30D158',
    warning: '#FF9F0A',
    card: '#1C1C1E',
    inputBackground: '#1C1C1E',
    userBubble: '#0A84FF',
    userBubbleText: '#FFFFFF',
    assistantBubble: '#1C1C1E',
    assistantBubbleText: '#FFFFFF',
    toolCardBg: '#2A2215',
    toolCardBorder: '#5C4A20',
    toolCardIcon: '#FF9F0A',
  },
} as const;

export type ThemeColors = typeof Colors.light;
export type ThemeColor = keyof ThemeColors;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
});

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const FontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 28,
  title: 34,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
