import { loadToken } from './auth';
import { GITHUB_CLIENT_ID, GITHUB_DEVICE_SCOPE } from '@/constants/github';

// Device Flow

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_DEVICE_SCOPE }),
  });

  if (!response.ok) {
    throw new Error('Failed to request device code');
  }

  return response.json();
}

export async function pollForToken(
  deviceCode: string,
  expiresIn: number,
  interval: number,
  signal?: AbortSignal
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Cancelled');

    await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await response.json();

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === 'slow_down') {
      pollInterval = (data.interval ?? pollInterval) + 1;
    } else if (data.error === 'authorization_pending') {
      // Continue polling
    } else if (data.error === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    } else if (data.error === 'access_denied') {
      throw new Error('Access denied.');
    } else if (data.error) {
      throw new Error(data.error_description ?? data.error);
    }
  }

  throw new Error('Device code expired');
}

// GitHub API

export interface GitHubProfile {
  login: string;
  name?: string;
  email?: string;
  avatar_url?: string;
}

export async function fetchUserProfile(): Promise<GitHubProfile | null> {
  const token = await loadToken('githubToken');
  if (!token) return null;

  try {
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function fetchPrimaryEmail(): Promise<string | null> {
  const token = await loadToken('githubToken');
  if (!token) return null;

  try {
    const response = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const emails: Array<{ email: string; primary: boolean; verified: boolean }> =
      await response.json();
    const primary = emails.find((e) => e.primary && e.verified);
    return primary?.email ?? emails[0]?.email ?? null;
  } catch {
    return null;
  }
}
