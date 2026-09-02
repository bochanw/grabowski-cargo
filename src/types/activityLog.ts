// Odwzorowanie public.activity_log — patrz supabase/migrations/0003_activity_log.sql.
export type ActivityAction = "insert" | "update" | "delete";

export interface ActivityLogEntry {
  id: string;
  load_id: string | null;
  order_number: string | null;
  action: ActivityAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor: string;
  actor_id: string | null;
  created_at: string;
}
