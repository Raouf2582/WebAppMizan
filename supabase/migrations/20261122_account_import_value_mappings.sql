-- ============================================================================
-- UNIFIED FIELD-SCOPED VALUE MAPPINGS FOR CHART OF ACCOUNTS EXCEL IMPORT
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.account_import_value_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_key TEXT NOT NULL CHECK (
    field_key IN ('account_type', 'normal_balance', 'is_postable', 'status', 'cost_center_required')
  ),
  source_value TEXT NOT NULL CHECK (char_length(trim(source_value)) >= 1),
  normalized_token TEXT NOT NULL CHECK (char_length(trim(normalized_token)) >= 1),
  internal_target TEXT NOT NULL,
  updated_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT account_import_value_mappings_unique_field_token UNIQUE (field_key, normalized_token),
  CONSTRAINT account_import_value_mappings_valid_target CHECK (
    (field_key = 'account_type' AND internal_target IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')) OR
    (field_key = 'normal_balance' AND internal_target IN ('DEBIT', 'CREDIT')) OR
    (field_key = 'is_postable' AND internal_target IN ('GROUP', 'POSTING')) OR
    (field_key = 'status' AND internal_target IN ('ACTIVE', 'INACTIVE')) OR
    (field_key = 'cost_center_required' AND internal_target IN ('REQUIRED', 'OPTIONAL'))
  )
);

CREATE INDEX IF NOT EXISTS idx_account_import_value_mappings_field_token
  ON public.account_import_value_mappings(field_key, normalized_token);

-- Migrate any existing posting-level mappings if present
DO $$
BEGIN
  IF to_regclass('public.account_import_posting_mappings') IS NOT NULL THEN
    INSERT INTO public.account_import_value_mappings (
      field_key, source_value, normalized_token, internal_target, updated_by, created_at, updated_at
    )
    SELECT
      'is_postable', source_value, normalized_token, internal_target, updated_by, created_at, updated_at
    FROM public.account_import_posting_mappings
    ON CONFLICT (field_key, normalized_token) DO NOTHING;
  END IF;
END $$;

DROP TABLE IF EXISTS public.account_import_posting_mappings;

DROP TRIGGER IF EXISTS trg_account_import_value_mappings_updated_at
  ON public.account_import_value_mappings;
CREATE TRIGGER trg_account_import_value_mappings_updated_at
  BEFORE UPDATE ON public.account_import_value_mappings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.account_import_value_mappings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.account_import_value_mappings FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_import_value_mappings TO authenticated;
GRANT ALL ON public.account_import_value_mappings TO service_role;

DROP POLICY IF EXISTS account_import_value_mappings_admin_all
  ON public.account_import_value_mappings;
CREATE POLICY account_import_value_mappings_admin_all
  ON public.account_import_value_mappings
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());
