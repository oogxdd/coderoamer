import { describe, expect, it } from 'vitest';
import { normalizeAgentEffortForProvider } from '@/models/chat';

describe('normalizeAgentEffortForProvider', () => {
  it('migrates the legacy Codex minimal effort to none', () => {
    expect(normalizeAgentEffortForProvider('codexAppServer', 'minimal')).toBe('none');
    expect(normalizeAgentEffortForProvider('codex', 'minimal')).toBe('none');
  });

  it('keeps current Codex effort values and bounds cross-provider max', () => {
    expect(normalizeAgentEffortForProvider('codexAppServer', 'none')).toBe('none');
    expect(normalizeAgentEffortForProvider('codexAppServer', 'xhigh')).toBe('xhigh');
    expect(normalizeAgentEffortForProvider('codexAppServer', 'max')).toBe('xhigh');
  });

  it('rejects Codex-only values for Claude', () => {
    expect(normalizeAgentEffortForProvider('claude', 'none')).toBeUndefined();
    expect(normalizeAgentEffortForProvider('claude', 'minimal')).toBeUndefined();
    expect(normalizeAgentEffortForProvider('claude', 'max')).toBe('max');
  });
});
