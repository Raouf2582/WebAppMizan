-- Safe incremental migration: Admin-only journal deletion & atomic reversal linkage

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS reversed_entry_id UUID NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'journal_entries_no_self_reversal'
      AND conrelid = 'public.journal_entries'::regclass
  ) THEN
    ALTER TABLE public.journal_entries
      ADD CONSTRAINT journal_entries_no_self_reversal
      CHECK (reversed_entry_id IS NULL OR reversed_entry_id <> id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_unique_reversal
  ON public.journal_entries(reversed_entry_id)
  WHERE reversed_entry_id IS NOT NULL;

-- Tighten journal_lines RLS so regular users cannot delete lines directly via DB
DROP POLICY IF EXISTS journal_lines_modify ON public.journal_lines;
DROP POLICY IF EXISTS journal_lines_insert ON public.journal_lines;
DROP POLICY IF EXISTS journal_lines_update ON public.journal_lines;
DROP POLICY IF EXISTS journal_lines_delete ON public.journal_lines;

CREATE POLICY journal_lines_insert ON public.journal_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.journal_entries je
      WHERE je.id = journal_entry_id
        AND je.status = 'DRAFT'
        AND (public.is_admin() OR (public.is_active_user() AND je.created_by = public.current_actor_id()))
    )
  );

CREATE POLICY journal_lines_update ON public.journal_lines
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.journal_entries je
      WHERE je.id = journal_entry_id
        AND je.status = 'DRAFT'
        AND (public.is_admin() OR (public.is_active_user() AND je.created_by = public.current_actor_id()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.journal_entries je
      WHERE je.id = journal_entry_id
        AND je.status = 'DRAFT'
        AND (public.is_admin() OR (public.is_active_user() AND je.created_by = public.current_actor_id()))
    )
  );

CREATE POLICY journal_lines_delete ON public.journal_lines
  FOR DELETE TO authenticated
  USING (
    public.is_admin()
    AND EXISTS (
      SELECT 1 FROM public.journal_entries je
      WHERE je.id = journal_entry_id
        AND je.status = 'DRAFT'
    )
  );

-- Atomic Admin-only journal reversal RPC
CREATE OR REPLACE FUNCTION public.reverse_journal_entry_atomic(
  p_original_entry_id UUID,
  p_reversal_date DATE,
  p_actor_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor RECORD;
  v_orig RECORD;
  v_existing_rev_number TEXT;
  v_period_id UUID;
  v_cc_status TEXT;
  v_rev_id UUID;
  v_rev_number TEXT;
  v_line RECORD;
  v_idx INTEGER := 0;
  v_total_debit NUMERIC(18, 2) := 0;
  v_total_credit NUMERIC(18, 2) := 0;
BEGIN
  SELECT role, is_active INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active <> true OR v_actor.role <> 'ADMIN' THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: إنشاء القيود العكسية متاح لمدير النظام فقط.';
  END IF;

  SELECT * INTO v_orig FROM public.journal_entries WHERE id = p_original_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: القيد المحاسبي غير موجود.';
  END IF;

  IF v_orig.status <> 'POSTED' THEN
    RAISE EXCEPTION 'ONLY_POSTED_REVERSIBLE: لا يمكن إنشاء قيد عكسي إلا للقيود المرحّلة.';
  END IF;

  SELECT entry_number INTO v_existing_rev_number
  FROM public.journal_entries
  WHERE reversed_entry_id = p_original_entry_id
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ALREADY_REVERSED: تم إنشاء قيد عكسي لهذا القيد مسبقاً برقم (%).', v_existing_rev_number;
  END IF;

  v_period_id := public.resolve_open_period(p_reversal_date);

  IF v_orig.cost_center_id IS NOT NULL THEN
    SELECT status INTO v_cc_status FROM public.cost_centers WHERE id = v_orig.cost_center_id;
    IF NOT FOUND OR v_cc_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'INVALID_COST_CENTER: مركز التكلفة المرتبط بالقيد الأصلي غير نشط.';
    END IF;
  END IF;

  v_rev_number := public.next_document_number('journal', 'JE');

  INSERT INTO public.journal_entries (
    entry_number, entry_date, period_id, description, reference_number, cost_center_id,
    reversed_entry_id, status, source_type, total_debit, total_credit, created_by
  ) VALUES (
    v_rev_number,
    p_reversal_date,
    v_period_id,
    'قيد عكسي للقيد رقم ' || v_orig.entry_number || ' — ' || v_orig.description,
    v_orig.entry_number,
    v_orig.cost_center_id,
    v_orig.id,
    'DRAFT',
    'MANUAL',
    0,
    0,
    p_actor_id
  )
  RETURNING id INTO v_rev_id;

  FOR v_line IN
    SELECT * FROM public.journal_lines
    WHERE journal_entry_id = p_original_entry_id
    ORDER BY line_order ASC
  LOOP
    v_idx := v_idx + 1;
    INSERT INTO public.journal_lines (
      journal_entry_id, line_order, account_id, cost_center_id, debit, credit, description
    ) VALUES (
      v_rev_id,
      v_idx,
      v_line.account_id,
      v_orig.cost_center_id,
      v_line.credit,
      v_line.debit,
      v_line.description
    );

    v_total_debit := v_total_debit + v_line.credit;
    v_total_credit := v_total_credit + v_line.debit;
  END LOOP;

  IF v_idx < 2 OR v_total_debit <= 0 OR v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: القيد العكسي غير متوازن أو لا يحتوي على بنود صالحة.';
  END IF;

  UPDATE public.journal_entries
  SET total_debit = v_total_debit, total_credit = v_total_credit
  WHERE id = v_rev_id;

  RETURN v_rev_id;
END;
$$;

-- Atomic Admin-only journal deletion RPC
CREATE OR REPLACE FUNCTION public.delete_journal_entry_atomic(
  p_entry_id UUID,
  p_actor_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor RECORD;
  v_entry RECORD;
  v_period_status TEXT;
BEGIN
  SELECT role, is_active INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active <> true OR v_actor.role <> 'ADMIN' THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: حذف القيود المحاسبية متاح لمدير النظام فقط.';
  END IF;

  SELECT * INTO v_entry FROM public.journal_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: القيد المحاسبي غير موجود.';
  END IF;

  IF v_entry.source_type <> 'MANUAL'
     OR v_entry.source_voucher_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.vouchers WHERE journal_entry_id = p_entry_id) THEN
    RAISE EXCEPTION 'VOUCHER_JOURNAL_LOCKED: لا يمكن حذف قيد ناتج عن سند قبض أو صرف للحفاظ على سلامة السندات.';
  END IF;

  SELECT status INTO v_period_status FROM public.accounting_periods WHERE id = v_entry.period_id;
  IF v_period_status = 'CLOSED' THEN
    RAISE EXCEPTION 'CLOSED_PERIOD_IMMUTABLE: لا يمكن حذف قيد ينتمي لفترة محاسبية مغلقة.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE reversed_entry_id = p_entry_id) THEN
    RAISE EXCEPTION 'HAS_REVERSAL_DEPENDENCY: لا يمكن حذف قيد مرتبط بقيد عكسي للحفاظ على المرجعية المحاسبية.';
  END IF;

  IF v_entry.status = 'POSTED' THEN
    RAISE EXCEPTION 'REVERSAL_REQUIRED_BEFORE_DELETE: لا يمكن حذف قيد مرحّل أثّر على أرصدة الحسابات والتقارير المالية. يرجى إنشاء قيد عكسي بدلاً من الحذف.';
  END IF;

  DELETE FROM public.journal_entries WHERE id = p_entry_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_journal_entry_atomic(UUID, DATE, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_journal_entry_atomic(UUID, DATE, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.delete_journal_entry_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_journal_entry_atomic(UUID, UUID) TO service_role;
