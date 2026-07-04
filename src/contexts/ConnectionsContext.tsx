/**
 * ConnectionsContext — owns the list of VM connections and which one is active.
 *
 * Complements AuthContext (which keeps Claude/GitHub/etc. credentials and the
 * legacy sprites-token gate). This context:
 *  - loads + migrates the connection list (legacy spritesToken → default sprite
 *    connection, handled in services/connections),
 *  - tracks the active connection, and
 *  - keeps api.ts's module-level active-connection pointer in sync so every
 *    provider-agnostic api call targets the right VM.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Connection } from '@/models/connection';
import * as api from '@/services/api';
import {
  loadConnections,
  addConnection as addConnectionSvc,
  updateConnection as updateConnectionSvc,
  removeConnection as removeConnectionSvc,
  loadActiveConnectionId,
  saveActiveConnectionId,
} from '@/services/connections';

interface ConnectionsContextValue {
  isLoading: boolean;
  connections: Connection[];
  activeConnection: Connection | null;
  hasAnyConnection: boolean;
  refresh: () => Promise<void>;
  addConnection: (conn: Connection) => Promise<void>;
  updateConnection: (id: string, patch: Partial<Connection>) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  setActive: (idOrConn: string | Connection | null) => Promise<void>;
}

const ConnectionsContext = createContext<ConnectionsContextValue | null>(null);

export function ConnectionsProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Resolve the active connection object, falling back to the first connection
  // when the stored pointer is missing/stale.
  const activeConnection = useMemo(
    () => connections.find((c) => c.id === activeId) ?? connections[0] ?? null,
    [connections, activeId]
  );

  // Mirror the active connection into api.ts so module-level api calls resolve
  // their base URL + token without every caller having to thread it.
  useEffect(() => {
    api.setActiveConnection(activeConnection);
  }, [activeConnection]);

  const refresh = useCallback(async () => {
    const list = await loadConnections();
    const storedActive = await loadActiveConnectionId();
    setConnections(list);
    setActiveId(storedActive ?? list[0]?.id ?? null);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addConnection = useCallback(async (conn: Connection) => {
    const next = await addConnectionSvc(conn);
    setConnections(next);
    // First connection added becomes active automatically.
    setActiveId((cur) => cur ?? conn.id);
  }, []);

  const updateConnection = useCallback(
    async (id: string, patch: Partial<Connection>) => {
      const next = await updateConnectionSvc(id, patch);
      setConnections(next);
    },
    []
  );

  const removeConnection = useCallback(async (id: string) => {
    const next = await removeConnectionSvc(id);
    setConnections(next);
    setActiveId((cur) => (cur === id ? next[0]?.id ?? null : cur));
  }, []);

  const setActive = useCallback(async (idOrConn: string | Connection | null) => {
    const id =
      typeof idOrConn === 'string' ? idOrConn : idOrConn ? idOrConn.id : null;
    setActiveId(id);
    await saveActiveConnectionId(id);
  }, []);

  const value = useMemo<ConnectionsContextValue>(
    () => ({
      isLoading,
      connections,
      activeConnection,
      hasAnyConnection: connections.length > 0,
      refresh,
      addConnection,
      updateConnection,
      removeConnection,
      setActive,
    }),
    [
      isLoading,
      connections,
      activeConnection,
      refresh,
      addConnection,
      updateConnection,
      removeConnection,
      setActive,
    ]
  );

  return (
    <ConnectionsContext.Provider value={value}>{children}</ConnectionsContext.Provider>
  );
}

export function useConnections(): ConnectionsContextValue {
  const ctx = useContext(ConnectionsContext);
  if (!ctx) throw new Error('useConnections must be used within ConnectionsProvider');
  return ctx;
}
