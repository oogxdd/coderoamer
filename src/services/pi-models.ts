import { getSetting, setSetting } from '@/services/storage';
import { runExec } from '@/services/api';

/**
 * Model catalog for the pi agent on a sprite. pi keeps per-provider lists of
 * tool-capable models; `pi --list-models` prints them as a fixed-width table:
 *
 *   provider  model              context  max-out  thinking  images
 *   zai       glm-5.3            1M       131.1K   yes       no
 *
 * We parse that sprite-side output into chips for the session/settings model
 * pickers and cache it in AsyncStorage (mirroring codex-models.ts), so an
 * offline sprite still shows the last known catalog. The `id` we store is the
 * `provider/model` form `pi --model` accepts.
 */

const CACHE_KEY = 'piModelCatalog';
const REQUEST_TIMEOUT_S = 20;

export interface PiModelOption {
  /** Value passed to `pi --model` (`provider/model`). */
  id: string;
  provider: string;
  model: string;
  supportsThinking: boolean;
  supportsImages: boolean;
}

/** Split a `--list-models` table into options. Pure — unit-tested. */
export function parsePiModelTable(output: string): PiModelOption[] {
  if (typeof output !== 'string') return [];
  const lines = output.split('\n');

  // The table is column-aligned; the header line defines each column's start
  // offset, which stays correct even when a provider/model name is long
  // enough to leave only one separating space.
  const headerLine = lines.find((l) => l.trim().toLowerCase().startsWith('provider'));
  const offsets = headerLine
    ? {
        provider: headerLine.indexOf('provider'),
        model: headerLine.indexOf('model'),
        thinking: headerLine.indexOf('thinking'),
        images: headerLine.indexOf('images'),
      }
    : undefined;

  const options: PiModelOption[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line === headerLine) continue;

    let provider: string | undefined;
    let model: string | undefined;
    let thinkingCol: string | undefined;
    let imagesCol: string | undefined;
    if (
      offsets &&
      offsets.provider >= 0 &&
      offsets.model > offsets.provider &&
      offsets.thinking > offsets.model &&
      offsets.images > offsets.thinking
    ) {
      provider = line.slice(offsets.provider, offsets.model).trim();
      model = line.slice(offsets.model, offsets.thinking).trim().split(/\s{2,}/)[0];
      thinkingCol = line.slice(offsets.thinking, offsets.images).trim();
      imagesCol = line.slice(offsets.images).trim();
    } else {
      // Headerless fallback: split on runs of 2+ spaces.
      const columns = line.trim().split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
      if (columns.length < 2) continue;
      provider = columns[0];
      model = columns[1];
      thinkingCol = columns.find((c, i) => i >= 2 && (c === 'yes' || c === 'no'));
      imagesCol = columns.slice().reverse().find((c) => c === 'yes' || c === 'no');
    }

    if (!provider || !model || /\s/.test(provider) || /\s/.test(model)) continue;
    options.push({
      id: `${provider}/${model}`,
      provider,
      model,
      supportsThinking: thinkingCol === 'yes',
      supportsImages: imagesCol === 'yes',
    });
  }
  return options;
}

function parseCached(raw: string | null): PiModelOption[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PiModelOption =>
        !!x && typeof x === 'object' && typeof (x as PiModelOption).id === 'string'
    );
  } catch {
    return [];
  }
}

export async function getCachedPiModels(): Promise<PiModelOption[]> {
  return parseCached(await getSetting(CACHE_KEY));
}

export async function cachePiModels(models: PiModelOption[]): Promise<void> {
  await setSetting(CACHE_KEY, JSON.stringify(models));
}

/** Refresh the catalog from the sprite's installed pi (`pi --list-models`). */
export async function listPiModels(spriteName: string): Promise<PiModelOption[]> {
  const { output, success } = await runExec(
    spriteName,
    'PI_SKIP_VERSION_CHECK=1 pi --list-models 2>/dev/null',
    REQUEST_TIMEOUT_S
  );
  if (!success && !output.trim()) return [];
  return parsePiModelTable(output);
}
