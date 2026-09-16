export interface DesktopRoom {
  id: string;
  name: string;
  purpose: string;
  notes: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface RoomAgent {
  room_id: string;
  agent_id: string;
  messaging_group_id: string;
  active: number;
}
export interface RoomMessage {
  seq: number;
  id: string;
  room_id: string;
  thread_id: string | null;
  author_id: string;
  author_kind: 'human' | 'agent';
  author_name: string;
  text: string;
  targets: string;
  fingerprint: string;
  created_at: string;
}
export interface RoomDelivery {
  message_id: string;
  agent_id: string;
  targeted: number;
  state: string;
  attempts: number;
  error: string | null;
}
