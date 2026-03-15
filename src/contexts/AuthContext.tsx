import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { loadAllTokens, saveToken, deleteToken, clearAllTokens, loadToken } from '@/services/auth';

interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  hasClaudeToken: boolean;
  hasGitHubToken: boolean;
}

interface AuthContextValue extends AuthState {
  refreshAuth: () => Promise<void>;
  saveSpritesToken: (token: string) => Promise<void>;
  saveClaudeToken: (token: string) => Promise<void>;
  saveGitHubToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  getClaudeToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isLoading: true,
    isAuthenticated: false,
    hasClaudeToken: false,
    hasGitHubToken: false,
  });

  const refreshAuth = useCallback(async () => {
    const tokens = await loadAllTokens();
    setState({
      isLoading: false,
      isAuthenticated: !!tokens.spritesToken,
      hasClaudeToken: !!tokens.claudeToken,
      hasGitHubToken: !!tokens.githubToken,
    });
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  const saveSpritesToken = useCallback(async (token: string) => {
    await saveToken('spritesToken', token);
    await refreshAuth();
  }, [refreshAuth]);

  const saveClaudeTokenFn = useCallback(async (token: string) => {
    await saveToken('claudeToken', token);
    await refreshAuth();
  }, [refreshAuth]);

  const saveGitHubToken = useCallback(async (token: string) => {
    await saveToken('githubToken', token);
    await refreshAuth();
  }, [refreshAuth]);

  const signOut = useCallback(async () => {
    await clearAllTokens();
    await refreshAuth();
  }, [refreshAuth]);

  const getClaudeToken = useCallback(async () => {
    return loadToken('claudeToken');
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        refreshAuth,
        saveSpritesToken,
        saveClaudeToken: saveClaudeTokenFn,
        saveGitHubToken,
        signOut,
        getClaudeToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
