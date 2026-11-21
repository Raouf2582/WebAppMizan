-- ============================================================================
-- ACCOUNT IMPORT HISTORY & TRACEABILITY LOGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.account_import_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_number TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL CHECK (char_length(trim(file_name)) >= 1),
  sheet_name TEXT NOT NULL CHECK (char_length(trim(sheet_name)) >= 1),
  import_mode TEXT NOT NULL CHECK (import_mode IN ('ADD_NEW', 'UPDATE_EXISTING')),
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  imported_count INTEGER NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'COMPLETED_WITH_SKIPS', 'FAILED')),
  error_message TEXT NULL,
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  performed_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_account_import_logs_created_at
  ON public.account_import_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_import_logs_performed_by
  ON public.account_import_logs(performed_by);

ALTER TABLE public.account_import_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.account_import_logs FROM anon, public;
GRANT SELECT, INSERT ON public.account_import_logs TO authenticated;
GRANT ALL ON public.account_import_logs TO service_role;

DROP POLICY IF EXISTS account_import_logs_admin_select ON public.account_import_logs;
CREATE POLICY account_import_logs_admin_select ON public.account_import_logs
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS account_import_logs_admin_insert ON public.account_import_logs;
CREATE POLICY account_import_logs_admin_insert ON public.account_import_logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() AND performed_by = public.current_actor_id());
