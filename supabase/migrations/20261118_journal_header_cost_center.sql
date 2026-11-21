-- Safe incremental migration: Move cost center selection to journal_entries header level
-- Preserves existing journal_lines.cost_center_id for reporting compatibility.

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS cost_center_id UUID NULL REFERENCES public.cost_centers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_journal_entries_cost_center
  ON public.journal_entries(cost_center_id);

-- Drop old 5-argument signatures if they exist so only the clean 6-argument signatures remain
DROP FUNCTION IF EXISTS public.create_journal_entry_with_lines(DATE, TEXT, TEXT, UUID, JSONB);
DROP FUNCTION IF EXISTS public.update_draft_journal_entry(UUID, DATE, TEXT, TEXT, UUID, JSONB);

CREATE OR REPLACE FUNCTION public.create_journal_entry_with_lines(
  p_entry_date DATE,
  p_description TEXT,
  p_reference_number TEXT,
  p_actor_id UUID,
  p_lines JSONB,
  p_cost_center_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_id UUID;
  v_entry_id UUID;
  v_entry_number TEXT;
  v_line JSONB;
  v_idx INTEGER := 0;
  v_total_debit NUMERIC(18, 2) := 0;
  v_total_credit NUMERIC(18, 2) := 0;
  v_debit NUMERIC(18, 2);
  v_credit NUMERIC(18, 2);
  v_cc_status TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_actor_id AND is_active = true) THEN
    RAISE EXCEPTION 'UNAUTHORIZED_ACTOR: المستخدم غير نشط أو غير مخول.';
  END IF;

  IF p_lines IS NULL OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'MIN_TWO_LINES: يجب أن يحتوي القيد على سطرين صحيحين على الأقل.';
  END IF;

  IF p_cost_center_id IS NOT NULL THEN
    SELECT status INTO v_cc_status FROM public.cost_centers WHERE id = p_cost_center_id;
    IF NOT FOUND OR v_cc_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'INVALID_COST_CENTER: مركز التكلفة المحدد غير موجود أو غير نشط.';
    END IF;
  END IF;

  v_period_id := public.resolve_open_period(p_entry_date);
  v_entry_number := public.next_document_number('journal', 'JE');

  INSERT INTO public.journal_entries (
    entry_number, entry_date, period_id, description, reference_number, cost_center_id,
    status, source_type, total_debit, total_credit, created_by
  ) VALUES (
    v_entry_number, p_entry_date, v_period_id, trim(p_description), NULLIF(trim(COALESCE(p_reference_number, '')), ''), p_cost_center_id,
    'DRAFT', 'MANUAL', 0, 0, p_actor_id
  )
  RETURNING id INTO v_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_idx := v_idx + 1;
    v_debit := COALESCE((v_line->>'debit')::NUMERIC(18,2), 0);
    v_credit := COALESCE((v_line->>'credit')::NUMERIC(18,2), 0);

    INSERT INTO public.journal_lines (
      journal_entry_id, line_order, account_id, cost_center_id, debit, credit, description
    ) VALUES (
      v_entry_id,
      v_idx,
      (v_line->>'account_id')::UUID,
      p_cost_center_id,
      v_debit,
      v_credit,
      NULLIF(trim(COALESCE(v_line->>'description', '')), '')
    );

    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  END LOOP;

  IF v_total_debit <= 0 OR v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: القيد غير متوازن (المدين: %, الدائن: %).', v_total_debit, v_total_credit;
  END IF;

  UPDATE public.journal_entries
  SET total_debit = v_total_debit, total_credit = v_total_credit
  WHERE id = v_entry_id;

  RETURN v_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_draft_journal_entry(
  p_entry_id UUID,
  p_entry_date DATE,
  p_description TEXT,
  p_reference_number TEXT,
  p_actor_id UUID,
  p_lines JSONB,
  p_cost_center_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry RECORD;
  v_actor RECORD;
  v_period_id UUID;
  v_line JSONB;
  v_idx INTEGER := 0;
  v_total_debit NUMERIC(18, 2) := 0;
  v_total_credit NUMERIC(18, 2) := 0;
  v_debit NUMERIC(18, 2);
  v_credit NUMERIC(18, 2);
  v_cc_status TEXT;
BEGIN
  SELECT role, is_active INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active <> true THEN
    RAISE EXCEPTION 'UNAUTHORIZED_ACTOR: المستخدم غير نشط.';
  END IF;

  SELECT * INTO v_entry FROM public.journal_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: القيد غير موجود.';
  END IF;

  IF v_entry.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: القيد المرحل غير قابل للتعديل.';
  END IF;

  IF v_entry.source_type <> 'MANUAL' THEN
    RAISE EXCEPTION 'VOUCHER_JOURNAL_LOCKED: لا يمكن تعديل قيد مرتبط بسند من هنا.';
  END IF;

  IF v_actor.role <> 'ADMIN' AND v_entry.created_by <> p_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN: لا يمكنك تعديل قيد مسودة أنشأه مستخدم آخر.';
  END IF;

  IF p_lines IS NULL OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'MIN_TWO_LINES: يجب أن يحتوي القيد على سطرين صحيحين على الأقل.';
  END IF;

  IF p_cost_center_id IS NOT NULL THEN
    SELECT status INTO v_cc_status FROM public.cost_centers WHERE id = p_cost_center_id;
    IF NOT FOUND OR v_cc_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'INVALID_COST_CENTER: مركز التكلفة المحدد غير موجود أو غير نشط.';
    END IF;
  END IF;

  v_period_id := public.resolve_open_period(p_entry_date);

  UPDATE public.journal_entries
  SET entry_date = p_entry_date,
      period_id = v_period_id,
      description = trim(p_description),
      reference_number = NULLIF(trim(COALESCE(p_reference_number, '')), ''),
      cost_center_id = p_cost_center_id
  WHERE id = p_entry_id;

  DELETE FROM public.journal_lines WHERE journal_entry_id = p_entry_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_idx := v_idx + 1;
    v_debit := COALESCE((v_line->>'debit')::NUMERIC(18,2), 0);
    v_credit := COALESCE((v_line->>'credit')::NUMERIC(18,2), 0);

    INSERT INTO public.journal_lines (
      journal_entry_id, line_order, account_id, cost_center_id, debit, credit, description
    ) VALUES (
      p_entry_id,
      v_idx,
      (v_line->>'account_id')::UUID,
      p_cost_center_id,
      v_debit,
      v_credit,
      NULLIF(trim(COALESCE(v_line->>'description', '')), '')
    );

    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
  END LOOP;

  IF v_total_debit <= 0 OR v_total_debit <> v_total_credit THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: القيد غير متوازن (المدين: %, الدائن: %).', v_total_debit, v_total_credit;
  END IF;

  UPDATE public.journal_entries
  SET total_debit = v_total_debit, total_credit = v_total_credit
  WHERE id = p_entry_id;

  RETURN p_entry_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_journal_entry_with_lines(DATE, TEXT, TEXT, UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_journal_entry_with_lines(DATE, TEXT, TEXT, UUID, JSONB, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.update_draft_journal_entry(UUID, DATE, TEXT, TEXT, UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_draft_journal_entry(UUID, DATE, TEXT, TEXT, UUID, JSONB, UUID) TO service_role;
