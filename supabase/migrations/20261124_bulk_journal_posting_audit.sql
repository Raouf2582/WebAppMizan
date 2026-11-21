-- ============================================================================
-- Bulk Journal Posting Audit Log Table & RLS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.journal_bulk_posting_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_number TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('SELECTED', 'ALL_DRAFTS')),
  total_targeted INTEGER NOT NULL DEFAULT 0 CHECK (total_targeted >= 0),
  posted_count INTEGER NOT NULL DEFAULT 0 CHECK (posted_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  filter_snapshot JSONB NULL,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  admin_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_journal_bulk_posting_audit_created_at
  ON public.journal_bulk_posting_audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_journal_bulk_posting_audit_admin_user_id
  ON public.journal_bulk_posting_audit_logs(admin_user_id);

ALTER TABLE public.journal_bulk_posting_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.journal_bulk_posting_audit_logs FROM anon, public;
GRANT SELECT, INSERT ON public.journal_bulk_posting_audit_logs TO authenticated;
GRANT ALL ON public.journal_bulk_posting_audit_logs TO service_role;

DROP POLICY IF EXISTS journal_bulk_posting_audit_admin_select ON public.journal_bulk_posting_audit_logs;
CREATE POLICY journal_bulk_posting_audit_admin_select
  ON public.journal_bulk_posting_audit_logs FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS journal_bulk_posting_audit_admin_insert ON public.journal_bulk_posting_audit_logs;
CREATE POLICY journal_bulk_posting_audit_admin_insert
  ON public.journal_bulk_posting_audit_logs FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() AND admin_user_id = public.current_actor_id());
