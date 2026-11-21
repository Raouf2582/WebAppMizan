-- ============================================================================
-- SAVED POSTING-LEVEL VALUE MAPPINGS FOR CHART OF ACCOUNTS EXCEL IMPORT
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.account_import_posting_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_value TEXT NOT NULL CHECK (char_length(trim(source_value)) >= 1),
  normalized_token TEXT NOT NULL UNIQUE CHECK (char_length(trim(normalized_token)) >= 1),
  internal_target TEXT NOT NULL CHECK (internal_target IN ('GROUP', 'POSTING')),
  updated_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_account_import_posting_mappings_token
  ON public.account_import_posting_mappings(normalized_token);

DROP TRIGGER IF EXISTS trg_account_import_posting_mappings_updated_at
  ON public.account_import_posting_mappings;
CREATE TRIGGER trg_account_import_posting_mappings_updated_at
  BEFORE UPDATE ON public.account_import_posting_mappings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.account_import_posting_mappings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.account_import_posting_mappings FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_import_posting_mappings TO authenticated;
GRANT ALL ON public.account_import_posting_mappings TO service_role;

DROP POLICY IF EXISTS account_import_posting_mappings_admin_all
  ON public.account_import_posting_mappings;
CREATE POLICY account_import_posting_mappings_admin_all
  ON public.account_import_posting_mappings
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
