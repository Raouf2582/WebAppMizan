-- Safe incremental migration: Admin-only unrestricted journal entry deletion
-- including voucher-linked journals (keep voucher as DRAFT or delete voucher atomically).

-- 1. Allow trusted transaction-local bypass ONLY inside delete_journal_entry_atomic
CREATE OR REPLACE FUNCTION public.protect_posted_and_closed_journals()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_status TEXT;
BEGIN
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

CREATE OR REPLACE FUNCTION public.protect_and_validate_journal_lines()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_entry_status TEXT;
  v_period_status TEXT;
  v_acc RECORD;
  v_cc_status TEXT;
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.bypass_admin_delete_guard', true) = 'true' THEN
    RETURN OLD;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT je.status, ap.status
    INTO v_entry_status, v_period_status
    FROM public.journal_entries je
    JOIN public.accounting_periods ap ON ap.id = je.period_id
    WHERE je.id = OLD.journal_entry_id;

    IF v_entry_status = 'POSTED' THEN
      RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: لا يمكن تعديل أو حذف بنود قيد مرحل.';
    END IF;
    IF v_period_status = 'CLOSED' THEN
      RAISE EXCEPTION 'CLOSED_PERIOD_IMMUTABLE: لا يمكن تعديل بنود قيد في فترة مغلقة.';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT je.status, ap.status
    INTO v_entry_status, v_period_status
    FROM public.journal_entries je
    JOIN public.accounting_periods ap ON ap.id = je.period_id
    WHERE je.id = NEW.journal_entry_id;

    IF v_entry_status = 'POSTED' THEN
      RAISE EXCEPTION 'POSTED_ENTRY_IMMUTABLE: لا يمكن إضافة بنود لقيد مرحل.';
    END IF;
    IF v_period_status = 'CLOSED' THEN
      RAISE EXCEPTION 'CLOSED_PERIOD_IMMUTABLE: لا يمكن إضافة بنود لقيد في فترة مغلقة.';
    END IF;

    SELECT id, status, is_postable, cost_center_required
    INTO v_acc
    FROM public.accounts
    WHERE id = NEW.account_id;

    IF NOT FOUND OR v_acc.status <> 'ACTIVE' OR v_acc.is_postable <> true THEN
      RAISE EXCEPTION 'INVALID_ACCOUNT: الحساب المحدد غير نشط أو غير قابل للترحيل.';
    END IF;

    IF v_acc.cost_center_required = true AND NEW.cost_center_id IS NULL THEN
      RAISE EXCEPTION 'COST_CENTER_REQUIRED: الحساب المحدد يتطلب اختيار مركز تكلفة.';
    END IF;

    IF NEW.cost_center_id IS NOT NULL THEN
      SELECT status INTO v_cc_status FROM public.cost_centers WHERE id = NEW.cost_center_id;
      IF NOT FOUND OR v_cc_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'INVALID_COST_CENTER: مركز التكلفة المحدد غير موجود أو غير نشط.';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_posted_vouchers()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_status TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND current_setting('app.bypass_admin_delete_guard', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'POSTED_VOUCHER_IMMUTABLE: السند المرحل غير قابل للتعديل أو الحذف.';
    END IF;
    SELECT status INTO v_period_status FROM public.accounting_periods WHERE id = OLD.period_id;
    IF v_period_status = 'CLOSED' THEN
      RAISE EXCEPTION 'CLOSED_PERIOD_IMMUTABLE: لا يمكن تعديل أو حذف سند في فترة محاسبية مغلقة.';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO v_period_status FROM public.accounting_periods WHERE id = NEW.period_id;
    IF v_period_status <> 'OPEN' THEN
      RAISE EXCEPTION 'CLOSED_ACCOUNTING_PERIOD: لا يمكن حفظ سند في فترة محاسبية مغلقة.';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 2. Replace delete_journal_entry_atomic to allow ADMIN deletion of any journal entry
--    (including posted entries and voucher-linked entries with KEEP_DRAFT or DELETE_VOUCHER).
DROP FUNCTION IF EXISTS public.delete_journal_entry_atomic(UUID, UUID);

CREATE OR REPLACE FUNCTION public.delete_journal_entry_atomic(
  p_entry_id UUID,
  p_actor_id UUID,
  p_voucher_action TEXT DEFAULT 'KEEP_DRAFT'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor RECORD;
  v_entry RECORD;
  v_voucher RECORD;
BEGIN
  SELECT role, is_active INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active <> true OR v_actor.role <> 'ADMIN' THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: حذف القيود المحاسبية متاح لمدير النظام فقط.';
  END IF;

  IF p_voucher_action NOT IN ('KEEP_DRAFT', 'DELETE_VOUCHER') THEN
    RAISE EXCEPTION 'INVALID_VOUCHER_ACTION: خيار التعامل مع السند المرتبط غير صالح.';
  END IF;

  SELECT * INTO v_entry FROM public.journal_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: القيد المحاسبي غير موجود.';
  END IF;

  -- Activate transaction-local bypass strictly after active ADMIN verification
  PERFORM set_config('app.bypass_admin_delete_guard', 'true', true);

  -- Lock & cleanly handle any linked receipt/payment voucher before deleting journal entry
  SELECT * INTO v_voucher
  FROM public.vouchers
  WHERE journal_entry_id = p_entry_id
     OR id = v_entry.source_voucher_id
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF p_voucher_action = 'DELETE_VOUCHER' THEN
      DELETE FROM public.vouchers WHERE id = v_voucher.id;
    ELSE
      UPDATE public.vouchers
      SET status = 'DRAFT',
          journal_entry_id = NULL,
          posted_by = NULL,
          posted_at = NULL
      WHERE id = v_voucher.id;
    END IF;
  END IF;

  -- Clear any reversal pointer referencing this entry so FK ON DELETE RESTRICT stays clean
  UPDATE public.journal_entries
  SET reversed_entry_id = NULL
  WHERE reversed_entry_id = p_entry_id;

  -- Delete journal entry (cascades cleanly to journal_lines)
  DELETE FROM public.journal_entries WHERE id = p_entry_id;

  PERFORM set_config('app.bypass_admin_delete_guard', 'false', true);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_journal_entry_atomic(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_journal_entry_atomic(UUID, UUID, TEXT) TO service_role;
