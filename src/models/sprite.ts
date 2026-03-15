export type SpriteStatus = 'running' | 'warm' | 'cold' | 'unknown';

export interface Sprite {
  id: string;
  name: string;
  status: SpriteStatus;
  url?: string;
  created_at?: string;
  url_settings?: UrlSettings;
}

export interface UrlSettings {
  auth: string;
}

export interface SpritesListResponse {
  sprites: Sprite[];
}

export interface CreateSpriteRequest {
  name: string;
}

export interface UpdateSpriteRequest {
  url_settings: UrlSettings;
}

export function statusDisplayName(status: SpriteStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function statusColor(status: SpriteStatus): string {
  switch (status) {
    case 'running': return '#34C759';
    case 'warm': return '#FF9500';
    case 'cold': return '#007AFF';
    default: return '#8E8E93';
  }
}
