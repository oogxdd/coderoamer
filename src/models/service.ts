export interface ServiceRequest {
  cmd: string;
  args?: string[];
  needs?: string[];
  http_port?: number;
}

export interface ServiceLogEvent {
  type: ServiceLogEventType;
  data?: string;
  exit_code?: number;
  timestamp?: number;
  log_files?: Record<string, string>;
}

export type ServiceLogEventType =
  | 'stdout'
  | 'stderr'
  | 'exit'
  | 'error'
  | 'complete'
  | 'started'
  | 'stopping'
  | 'stopped';

export interface ServiceInfo {
  name: string;
  state: ServiceState;
}

export interface ServiceState {
  status: string;
}
