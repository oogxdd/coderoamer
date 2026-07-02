import React from 'react';

import type { SkiaTerminalHandle } from './SkiaTerminal';
import type { TerminalTheme } from './SkiaTerminalRenderer';

type WebTerminalProps = {
  termRef: React.RefObject<SkiaTerminalHandle | null>;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  theme: TerminalTheme;
};

export default function WebTerminal(props: WebTerminalProps): React.ReactElement | null;
