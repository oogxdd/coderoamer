export interface Checkpoint {
  id: string;
  create_time?: string;
  is_auto?: boolean;
  comment?: string;
  source_id?: string;
}

export interface CreateCheckpointRequest {
  comment?: string;
}

export interface CheckpointStreamEvent {
  type: string;
  data?: string;
  error?: string;
  time?: string;
}
