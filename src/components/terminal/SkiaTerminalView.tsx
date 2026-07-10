import React, { forwardRef } from 'react';
import { SkiaTerminal, SkiaTerminalHandle } from './SkiaTerminal';
import type { TerminalTheme } from './SkiaTerminalRenderer';

export interface SkiaTerminalViewProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  fontSize?: number;
  cursorBlinkInterval?: number;
  theme?: TerminalTheme;
}

const SkiaTerminalView = forwardRef<SkiaTerminalHandle, SkiaTerminalViewProps>(
  ({ onData, onResize, fontSize = 13, cursorBlinkInterval = 600, theme }, ref) => (
    <SkiaTerminal
      ref={ref}
      onData={onData}
      onResize={onResize}
      fontSize={fontSize}
      cursorBlinkInterval={cursorBlinkInterval}
      theme={theme}
    />
  )
);
SkiaTerminalView.displayName = 'SkiaTerminalView';

export default SkiaTerminalView;
