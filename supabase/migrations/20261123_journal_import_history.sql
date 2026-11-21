-- ============================================================================
-- EXCEL JOURNAL IMPORT HISTORY MANAGEMENT & AUDIT LOGS
-- ============================================================================

-- 1. Journal Import Batches table
CREATE TABLE IF NOT EXISTS public.journal_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL CHECK (char_length(trim(file_name)) >= 1),
  sheet_names TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  imported_rows INTEGER NOT NULL DEFAULT 0 CHECK (imported_rows >= 0),
  detected_entries_count INTEGER NOT NULL DEFAULT 0 CHECK (detected_entries_count >= 0),
  drafts_created_count INTEGER NOT NULL DEFAULT 0 CHECK (drafts_created_count >= 0),
  rejected_entries_count INTEGER NOT NULL DEFAULT 0 CHECK (rejected_entries_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'COMPLETED_WITH_SKIPS', 'FAILED')),
  generated_entry_numbers TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  error_message TEXT NULL,
  details JSONB NOT NULL DEFAULT '[]'::jsonb,
  performed_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_journal_import_batches_created_at
  ON public.journal_import_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_import_batches_status
  ON public.journal_import_batches(status);
CREATE INDEX IF NOT EXISTS idx_journal_import_batches_performed_by
  ON public.journal_import_batches(performed_by);

-- 2. Traceable FK link on journal_entries (STRICTLY ON DELETE RESTRICT - NO CASCADE!)
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS import_batch_id UUID NULL
  REFERENCES public.journal_import_batches(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_journal_entries_import_batch_id
  ON public.journal_entries(import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- 3. Immutable Audit Log for Import Batch Deletions
CREATE TABLE IF NOT EXISTS public.journal_import_deletion_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL,
  batch_number TEXT NOT NULL,
  file_name TEXT NOT NULL,
  deletion_type TEXT NOT NULL CHECK (deletion_type IN ('DELETE_BATCH_AND_ENTRIES', 'DELETE_HISTORY_ONLY')),
  affected_entries_count INTEGER NOT NULL DEFAULT 0 CHECK (affected_entries_count >= 0),
  affected_entry_numbers TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  admin_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_journal_import_deletion_audit_created_at
  ON public.journal_import_deletion_audit_logs(created_at DESC);

-- 4. Update protect_posted_and_closed_journals() to allow ONLY safe import_batch_id unlinking
--    under app.bypass_import_batch_unlink = 'true' without touching any accounting field.
CREATE OR REPLACE FUNCTION public.protect_posted_and_closed_journals()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.bypass_import_batch_unlink', true) = 'true'
     AND OLD.import_batch_id IS NOT NULL
     AND NEW.import_batch_id IS NULL
     AND NEW.entry_number IS NOT DISTINCT FROM OLD.entry_number
     AND NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.period_id IS NOT DISTINCT FROM OLD.period_id
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW.reference_number IS NOT DISTINCT FROM OLD.reference_number
     AND NEW.cost_center_id IS NOT DISTINCT FROM OLD.cost_center_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
     AND NEW.source_voucher_id IS NOT DISTINCT FROM OLD.source_voucher_id
     AND NEW.reversed_entry_id IS NOT DISTINCT FROM OLD.reversed_entry_id
     AND NEW.total_debit IS NOT DISTINCT FROM OLD.total_debit
     AND NEW.total_credit IS NOT DISTINCT FROM OLD.total_credit
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.posted_by IS NOT DISTINCT FROM OLD.posted_by
     AND NEW.posted_at IS NOT DISTINCT FROM OLD.posted_at THEN
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE')
     AND current_setting('app.bypass_admin_delete_guard', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: القيد المرحل غير قابل للتعديل أو الحذف. استخدم قيداً عكسياً أو تسوية.';
    END IF;

    SELECT status INTO v_period_status FROM public.accounting_periods WHERE id = OLD.period_id;
    IF v_period_status = 'CLOSED' THEN
      RAISE EXCEPTION 'CLOSED_PERIOD_IMMUTABLE: لا يمكن تعديل أو حذف قيود تنتمي لفترة محاسبية مغلقة.';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO v_period_status FROM public.accounting_periods WHERE id = NEW.period_id;
    IF v_period_status <> 'OPEN' THEN
      RAISE EXCEPTION 'CLOSED_ACCOUNTING_PERIOD: لا يمكن حفظ قيد في فترة محاسبية مغلقة.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 5. Atomic Admin-only Import Batch Deletion RPC (Option 1 & Option 2)
CREATE OR REPLACE FUNCTION public.delete_journal_import_batch_atomic(
  p_batch_id UUID,
  p_actor_id UUID,
  p_mode TEXT
)
RETURNS TABLE (
  batch_id UUID,
  batch_number TEXT,
  file_name TEXT,
  deletion_type TEXT,
  affected_entries_count INTEGER,
  affected_entry_numbers TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor RECORD;
  v_batch RECORD;
  v_entry RECORD;
  v_entry_ids UUID[] := '{}'::UUID[];
  v_entry_numbers TEXT[] := '{}'::TEXT[];
  v_block_reasons TEXT[] := '{}'::TEXT[];
  v_affected_count INTEGER := 0;
BEGIN
  SELECT role, is_active INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active <> true OR v_actor.role <> 'ADMIN' THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: إدارة وحذف سجل استيراد القيود متاح لمدير النظام فقط.';
  END IF;

  IF p_mode NOT IN ('DELETE_BATCH_AND_ENTRIES', 'DELETE_HISTORY_ONLY') THEN
    RAISE EXCEPTION 'INVALID_DELETION_MODE: نوع عملية الحذف غير صالح.';
  END IF;

  SELECT * INTO v_batch
  FROM public.journal_import_batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: سجل عملية الاستيراد غير موجود.';
  END IF;

  FOR v_entry IN
    SELECT
      je.id,
      je.entry_number,
      je.status,
      je.source_type,
      je.source_voucher_id,
      ap.status AS period_status,
      EXISTS (SELECT 1 FROM public.vouchers v WHERE v.journal_entry_id = je.id) AS has_voucher_link,
      EXISTS (SELECT 1 FROM public.journal_entries rev WHERE rev.reversed_entry_id = je.id) AS has_reversal_link
    FROM public.journal_entries je
    JOIN public.accounting_periods ap ON ap.id = je.period_id
    WHERE je.import_batch_id = p_batch_id
    ORDER BY je.entry_number ASC
    FOR UPDATE OF je
  LOOP
    v_entry_ids := array_append(v_entry_ids, v_entry.id);
    v_entry_numbers := array_append(v_entry_numbers, v_entry.entry_number);

    IF p_mode = 'DELETE_BATCH_AND_ENTRIES' THEN
      IF v_entry.status <> 'DRAFT' THEN
        v_block_reasons := array_append(
          v_block_reasons,
          format('القيد (%s) مرحّل بالفعل ولا يمكن حذفه', v_entry.entry_number)
        );
      ELSIF v_entry.period_status = 'CLOSED' THEN
        v_block_reasons := array_append(
          v_block_reasons,
          format('القيد (%s) ينتمي إلى فترة محاسبية مغلقة', v_entry.entry_number)
        );
      ELSIF v_entry.source_type <> 'MANUAL' OR v_entry.source_voucher_id IS NOT NULL OR v_entry.has_voucher_link THEN
        v_block_reasons := array_append(
          v_block_reasons,
          format('القيد (%s) مرتبط بسند قبض أو صرف', v_entry.entry_number)
        );
      ELSIF v_entry.has_reversal_link THEN
        v_block_reasons := array_append(
          v_block_reasons,
          format('القيد (%s) مرتبط بقيد عكسي', v_entry.entry_number)
        );
      END IF;
    END IF;
  END LOOP;

  v_affected_count := COALESCE(array_length(v_entry_ids, 1), 0);

  IF p_mode = 'DELETE_BATCH_AND_ENTRIES' THEN
    IF COALESCE(array_length(v_block_reasons, 1), 0) > 0 THEN
      RAISE EXCEPTION 'BATCH_DELETE_BLOCKED: تعذر حذف دفعة الاستيراد والقيود المرتبطة بها للأسباب التالية: %',
        array_to_string(v_block_reasons, '؛ ');
    END IF;

    IF v_affected_count > 0 THEN
      DELETE FROM public.journal_lines
      WHERE journal_entry_id = ANY(v_entry_ids);

      DELETE FROM public.journal_entries
      WHERE id = ANY(v_entry_ids)
        AND import_batch_id = p_batch_id;
    END IF;
  ELSE
    -- DELETE_HISTORY_ONLY: Safely detach import_batch_id while preserving all entries untouched
    IF v_affected_count > 0 THEN
      PERFORM set_config('app.bypass_import_batch_unlink', 'true', true);
      UPDATE public.journal_entries
      SET import_batch_id = NULL
      WHERE id = ANY(v_entry_ids)
        AND import_batch_id = p_batch_id;
      PERFORM set_config('app.bypass_import_batch_unlink', 'false', true);
    END IF;
  END IF;

  INSERT INTO public.journal_import_deletion_audit_logs (
    batch_id,
    batch_number,
    file_name,
    deletion_type,
    affected_entries_count,
    affected_entry_numbers,
    admin_user_id
  ) VALUES (
    v_batch.id,
    v_batch.batch_number,
    v_batch.file_name,
    p_mode,
    v_affected_count,
    v_entry_numbers,
    p_actor_id
  );

  DELETE FROM public.journal_import_batches WHERE id = p_batch_id;

  RETURN QUERY
  SELECT
    v_batch.id,
    v_batch.batch_number,
    v_batch.file_name,
    p_mode,
    v_affected_count,
    v_entry_numbers;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_journal_import_batch_atomic(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_journal_import_batch_atomic(UUID, UUID, TEXT) TO service_role;

-- 6. Strict Admin-only Row Level Security (RLS)
ALTER TABLE public.journal_import_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journal_import_batches FROM anon, public;
GRANT SELECT, INSERT, DELETE ON public.journal_import_batches TO authenticated;
GRANT ALL ON public.journal_import_batches TO service_role;

DROP POLICY IF EXISTS journal_import_batches_admin_select ON public.journal_import_batches;
CREATE POLICY journal_import_batches_admin_select ON public.journal_import_batches
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS journal_import_batches_admin_insert ON public.journal_import_batches;
CREATE POLICY journal_import_batches_admin_insert ON public.journal_import_batches
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() AND performed_by = public.current_actor_id());

DROP POLICY IF EXISTS journal_import_batches_admin_delete ON public.journal_import_batches;
CREATE POLICY journal_import_batches_admin_delete ON public.journal_import_batches
  FOR DELETE TO authenticated
  USING (public.is_admin());

ALTER TABLE public.journal_import_deletion_audit_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.journal_import_deletion_audit_logs FROM anon, public;
GRANT SELECT, INSERT ON public.journal_import_deletion_audit_logs TO authenticated;
GRANT ALL ON public.journal_import_deletion_audit_logs TO service_role;

DROP POLICY IF EXISTS journal_import_audit_admin_select ON public.journal_import_deletion_audit_logs;
CREATE POLICY journal_import_audit_admin_select ON public.journal_import_deletion_audit_logs
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS journal_import_audit_admin_insert ON public.journal_import_deletion_audit_logs;
CREATE POLICY journal_import_audit_admin_insert ON public.journal_import_deletion_audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() AND admin_user_id = public.current_actor_id());
