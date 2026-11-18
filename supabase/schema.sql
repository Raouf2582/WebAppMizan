-- ============================================================================
-- MIZAN PROFESSIONAL WEB ACCOUNTING SYSTEM - COMPLETE SUPABASE SQL SCHEMA
-- ============================================================================
-- Rules enforced:
-- 1. Strictly empty initial database (NO seed data, NO sample records, NO demo users).
-- 2. Only initial record permitted is the first ADMIN created via First-Time Setup.
-- 3. No Audit Trail tables, functions, or triggers.
-- 4. Strict double-entry validation, immutable posted entries, closed period locks.
-- 5. Complete non-recursive Row Level Security (RLS) policies.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. PROFILES TABLE (User accounts & roles)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL CHECK (char_length(trim(full_name)) >= 2),
  username TEXT NOT NULL CHECK (char_length(trim(username)) >= 2 AND username !~ '\s'),
  email TEXT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'USER')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username_lower_unique
  ON public.profiles (LOWER(username));

-- ----------------------------------------------------------------------------
-- 2. DOCUMENT SEQUENCES TABLE (Atomic sequential numbering)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.system_sequences (
  seq_key TEXT PRIMARY KEY,
  last_value BIGINT NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 3. UNIFIED CHART OF ACCOUNTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (char_length(trim(code)) >= 1),
  name_ar TEXT NOT NULL CHECK (char_length(trim(name_ar)) >= 2),
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  parent_id UUID NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  is_postable BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  cost_center_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT accounts_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_parent_id ON public.accounts(parent_id);
CREATE INDEX IF NOT EXISTS idx_accounts_type_status ON public.accounts(account_type, status);

-- ----------------------------------------------------------------------------
-- 4. HIERARCHICAL COST CENTERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cost_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (char_length(trim(code)) >= 1),
  name_ar TEXT NOT NULL CHECK (char_length(trim(name_ar)) >= 2),
  description TEXT NULL,
  parent_id UUID NULL REFERENCES public.cost_centers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT cost_centers_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_cost_centers_parent_id ON public.cost_centers(parent_id);
CREATE INDEX IF NOT EXISTS idx_cost_centers_status ON public.cost_centers(status);

-- ----------------------------------------------------------------------------
-- 5. ACCOUNTING PERIODS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounting_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar TEXT NOT NULL UNIQUE CHECK (char_length(trim(name_ar)) >= 2),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_at TIMESTAMPTZ NULL,
  closed_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reopened_at TIMESTAMPTZ NULL,
  reopened_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT accounting_periods_valid_dates CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_periods_dates_status ON public.accounting_periods(start_date, end_date, status);

-- ----------------------------------------------------------------------------
-- 6. JOURNAL ENTRIES (HEADER)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number TEXT NOT NULL UNIQUE,
  entry_date DATE NOT NULL,
  period_id UUID NOT NULL REFERENCES public.accounting_periods(id) ON DELETE RESTRICT,
  description TEXT NOT NULL CHECK (char_length(trim(description)) >= 2),
  reference_number TEXT NULL,
  cost_center_id UUID NULL REFERENCES public.cost_centers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED')),
  source_type TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source_type IN ('MANUAL', 'RECEIPT_VOUCHER', 'PAYMENT_VOUCHER')),
  source_voucher_id UUID NULL,
  reversed_entry_id UUID NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  total_debit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (total_debit >= 0),
  total_credit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (total_credit >= 0),
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  posted_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  posted_at TIMESTAMPTZ NULL,
  CONSTRAINT journal_entries_no_self_reversal CHECK (reversed_entry_id IS NULL OR reversed_entry_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_date_status ON public.journal_entries(entry_date, status);
CREATE INDEX IF NOT EXISTS idx_journal_entries_period ON public.journal_entries(period_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_created_by ON public.journal_entries(created_by);
CREATE INDEX IF NOT EXISTS idx_journal_entries_cost_center ON public.journal_entries(cost_center_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_unique_reversal
  ON public.journal_entries(reversed_entry_id)
  WHERE reversed_entry_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 7. JOURNAL LINES (DETAILS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL CHECK (line_order >= 1),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  cost_center_id UUID NULL REFERENCES public.cost_centers(id) ON DELETE RESTRICT,
  debit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT journal_lines_single_side_positive CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON public.journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON public.journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_cost_center ON public.journal_lines(cost_center_id);

-- ----------------------------------------------------------------------------
-- 8. RECEIPT & PAYMENT VOUCHERS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_type TEXT NOT NULL CHECK (voucher_type IN ('RECEIPT', 'PAYMENT')),
  voucher_number TEXT NOT NULL UNIQUE,
  voucher_date DATE NOT NULL,
  period_id UUID NOT NULL REFERENCES public.accounting_periods(id) ON DELETE RESTRICT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD')),
  cash_bank_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  counter_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  party_name TEXT NOT NULL CHECK (char_length(trim(party_name)) >= 2),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL CHECK (char_length(trim(description)) >= 2),
  reference_number TEXT NULL,
  cost_center_id UUID NULL REFERENCES public.cost_centers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED')),
  journal_entry_id UUID NULL UNIQUE REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  posted_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  posted_at TIMESTAMPTZ NULL,
  CONSTRAINT vouchers_distinct_accounts CHECK (cash_bank_account_id <> counter_account_id)
);

CREATE INDEX IF NOT EXISTS idx_vouchers_type_date ON public.vouchers(voucher_type, voucher_date);
CREATE INDEX IF NOT EXISTS idx_vouchers_status ON public.vouchers(status);
CREATE INDEX IF NOT EXISTS idx_vouchers_created_by ON public.vouchers(created_by);

-- ----------------------------------------------------------------------------
-- 9. HELPER FUNCTIONS (SECURITY DEFINER + FIXED SEARCH_PATH)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := timezone('utc', now());
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_actor_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.current_user_id', true), '')::UUID,
    NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID
  );
$$;

-- Non-recursive RLS helper: check if current authenticated user is active
CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = public.current_actor_id()
      AND p.is_active = true
  );
$$;

-- Non-recursive RLS helper: check if current authenticated user is active ADMIN
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = public.current_actor_id()
      AND p.role = 'ADMIN'
      AND p.is_active = true
  );
$$;

-- Atomic sequential document number generator
CREATE OR REPLACE FUNCTION public.next_document_number(p_seq_key TEXT, p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_next BIGINT;
BEGIN
  INSERT INTO public.system_sequences (seq_key, last_value, updated_at)
  VALUES (p_seq_key, 1, timezone('utc', now()))
  ON CONFLICT (seq_key)
  DO UPDATE SET
    last_value = public.system_sequences.last_value + 1,
    updated_at = timezone('utc', now())
  RETURNING last_value INTO v_next;

  RETURN p_prefix || '-' || lpad(v_next::TEXT, 6, '0');
END;
$$;

-- Resolve open accounting period for a given date
CREATE OR REPLACE FUNCTION public.resolve_open_period(p_date DATE)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_id UUID;
  v_status TEXT;
BEGIN
  SELECT id, status INTO v_period_id, v_status
  FROM public.accounting_periods
  WHERE p_date BETWEEN start_date AND end_date
  LIMIT 1;

  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'NO_ACCOUNTING_PERIOD: لا توجد فترة محاسبية تغطي التاريخ المحدد (%).', p_date;
  END IF;

  IF v_status <> 'OPEN' THEN
    RAISE EXCEPTION 'CLOSED_ACCOUNTING_PERIOD: الفترة المحاسبية لهذا التاريخ مغلقة (%).', p_date;
  END IF;

  RETURN v_period_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. INTEGRITY TRIGGERS
-- ----------------------------------------------------------------------------

-- Updated_at triggers
DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_accounts_updated_at ON public.accounts;
CREATE TRIGGER trg_accounts_updated_at BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_cost_centers_updated_at ON public.cost_centers;
CREATE TRIGGER trg_cost_centers_updated_at BEFORE UPDATE ON public.cost_centers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_periods_updated_at ON public.accounting_periods;
CREATE TRIGGER trg_periods_updated_at BEFORE UPDATE ON public.accounting_periods
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_journal_entries_updated_at ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_updated_at BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_journal_lines_updated_at ON public.journal_lines;
CREATE TRIGGER trg_journal_lines_updated_at BEFORE UPDATE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_vouchers_updated_at ON public.vouchers;
CREATE TRIGGER trg_vouchers_updated_at BEFORE UPDATE ON public.vouchers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Prevent overlapping accounting periods
CREATE OR REPLACE FUNCTION public.check_period_no_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.accounting_periods ap
    WHERE ap.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::UUID)
      AND daterange(ap.start_date, ap.end_date, '[]') && daterange(NEW.start_date, NEW.end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'PERIOD_OVERLAP: نطاق تواريخ الفترة المحاسبية يتداخل مع فترة محاسبية قائمة.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_periods_no_overlap ON public.accounting_periods;
CREATE TRIGGER trg_periods_no_overlap
  BEFORE INSERT OR UPDATE OF start_date, end_date ON public.accounting_periods
  FOR EACH ROW EXECUTE FUNCTION public.check_period_no_overlap();

-- Prevent circular parent relationships & invalid hierarchy in accounts
CREATE OR REPLACE FUNCTION public.validate_account_hierarchy()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent_postable BOOLEAN;
  v_has_cycle BOOLEAN;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT is_postable INTO v_parent_postable
    FROM public.accounts
    WHERE id = NEW.parent_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVALID_PARENT_ACCOUNT: الحساب الأب غير موجود.';
    END IF;

    IF v_parent_postable = true THEN
      RAISE EXCEPTION 'PARENT_IS_POSTABLE: لا يمكن إضافة حساب فرعي تحت حساب قابل للترحيل؛ يجب أن يكون الحساب الأب حساباً رئيسياً غير قابل للترحيل.';
    END IF;

    IF TG_OP = 'UPDATE' THEN
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM public.accounts WHERE id = NEW.parent_id
        UNION ALL
        SELECT a.id, a.parent_id FROM public.accounts a INNER JOIN ancestors anc ON a.id = anc.parent_id
      )
      SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = NEW.id) INTO v_has_cycle;

      IF v_has_cycle THEN
        RAISE EXCEPTION 'CIRCULAR_ACCOUNT_HIERARCHY: لا يمكن تعيين علاقة أب دائرية في شجرة الحسابات.';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Cannot mark an account as postable if it already has child accounts
    IF NEW.is_postable = true AND EXISTS (SELECT 1 FROM public.accounts WHERE parent_id = NEW.id) THEN
      RAISE EXCEPTION 'ACCOUNT_HAS_CHILDREN: لا يمكن تحويل حساب رئيسي لديه حسابات فرعية إلى حساب قابل للترحيل.';
    END IF;

    -- Cannot mark an account as non-postable if it already has journal lines or vouchers
    IF OLD.is_postable = true AND NEW.is_postable = false THEN
      IF EXISTS (SELECT 1 FROM public.journal_lines WHERE account_id = NEW.id)
         OR EXISTS (SELECT 1 FROM public.vouchers WHERE cash_bank_account_id = NEW.id OR counter_account_id = NEW.id) THEN
        RAISE EXCEPTION 'ACCOUNT_HAS_TRANSACTIONS: لا يمكن تحويل حساب عليه حركات مالية إلى حساب غير قابل للترحيل.';
      END IF;
    END IF;

    -- Cannot deactivate an account if it has active children
    IF OLD.status = 'ACTIVE' AND NEW.status = 'INACTIVE' THEN
      IF EXISTS (SELECT 1 FROM public.accounts WHERE parent_id = NEW.id AND status = 'ACTIVE') THEN
        RAISE EXCEPTION 'ACTIVE_CHILD_ACCOUNTS: لا يمكن تعطيل حساب رئيسي لديه حسابات فرعية نشطة.';
      END IF;
      -- Prevent deactivating if referenced in draft journal entries or draft vouchers
      IF EXISTS (
        SELECT 1 FROM public.journal_lines jl
        JOIN public.journal_entries je ON je.id = jl.journal_entry_id
        WHERE jl.account_id = NEW.id AND je.status = 'DRAFT'
      ) OR EXISTS (
        SELECT 1 FROM public.vouchers v
        WHERE (v.cash_bank_account_id = NEW.id OR v.counter_account_id = NEW.id) AND v.status = 'DRAFT'
      ) THEN
        RAISE EXCEPTION 'ACCOUNT_IN_DRAFT_TRANSACTIONS: لا يمكن تعطيل حساب مستخدم في قيود أو سندات مسودة.';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_account_hierarchy ON public.accounts;
CREATE TRIGGER trg_validate_account_hierarchy
  BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.validate_account_hierarchy();

-- Prevent circular parent relationships in cost centers
CREATE OR REPLACE FUNCTION public.validate_cost_center_hierarchy()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_has_cycle BOOLEAN;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.cost_centers WHERE id = NEW.parent_id) THEN
      RAISE EXCEPTION 'INVALID_PARENT_COST_CENTER: مركز التكلفة الأب غير موجود.';
    END IF;

    IF TG_OP = 'UPDATE' THEN
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM public.cost_centers WHERE id = NEW.parent_id
        UNION ALL
        SELECT c.id, c.parent_id FROM public.cost_centers c INNER JOIN ancestors anc ON c.id = anc.parent_id
      )
      SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = NEW.id) INTO v_has_cycle;

      IF v_has_cycle THEN
        RAISE EXCEPTION 'CIRCULAR_COST_CENTER_HIERARCHY: لا يمكن تعيين علاقة أب دائرية في مراكز التكلفة.';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND NEW.status = 'INACTIVE' THEN
    IF EXISTS (SELECT 1 FROM public.cost_centers WHERE parent_id = NEW.id AND status = 'ACTIVE') THEN
      RAISE EXCEPTION 'ACTIVE_CHILD_COST_CENTERS: لا يمكن تعطيل مركز تكلفة لديه مراكز فرعية نشطة.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_cost_center_hierarchy ON public.cost_centers;
CREATE TRIGGER trg_validate_cost_center_hierarchy
  BEFORE INSERT OR UPDATE ON public.cost_centers
  FOR EACH ROW EXECUTE FUNCTION public.validate_cost_center_hierarchy();

-- Protect posted journal entries and closed period entries from any modification or deletion
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

DROP TRIGGER IF EXISTS trg_protect_journal_entries ON public.journal_entries;
CREATE TRIGGER trg_protect_journal_entries
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.protect_posted_and_closed_journals();

-- Protect journal lines of posted entries and validate account/cost center eligibility
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

DROP TRIGGER IF EXISTS trg_protect_journal_lines ON public.journal_lines;
CREATE TRIGGER trg_protect_journal_lines
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.protect_and_validate_journal_lines();

-- Protect posted/closed vouchers
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

DROP TRIGGER IF EXISTS trg_protect_vouchers ON public.vouchers;
CREATE TRIGGER trg_protect_vouchers
  BEFORE INSERT OR UPDATE OR DELETE ON public.vouchers
  FOR EACH ROW EXECUTE FUNCTION public.protect_posted_vouchers();

-- ----------------------------------------------------------------------------
-- 11. ATOMIC TRANSACTIONAL RPCs
-- ----------------------------------------------------------------------------

-- Atomic create draft journal entry with lines (header cost center applied to all lines)
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

-- Atomic update draft journal entry with lines (header cost center applied to all lines)
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

-- Atomic post journal entry (ADMIN only)
CREATE OR REPLACE FUNCTION public.post_journal_entry_atomic(
  p_entry_id UUID,
  p_actor_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor RECORD;
  v_entry RECORD;
  v_period_id UUID;
  v_line_count INTEGER;
  v_sum_debit NUMERIC(18, 2);
  v_sum_credit NUMERIC(18, 2);
  v_invalid_line_count INTEGER;
BEGIN
  SELECT role, is_active INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active <> true OR v_actor.role <> 'ADMIN' THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: ترحيل القيود متاح لمدير النظام فقط.';
  END IF;

  SELECT * INTO v_entry FROM public.journal_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: القيد غير موجود.';
  END IF;

  IF v_entry.status = 'POSTED' THEN
    RAISE EXCEPTION 'ALREADY_POSTED: القيد مرحل بالفعل.';
  END IF;

  v_period_id := public.resolve_open_period(v_entry.entry_date);

  SELECT
    COUNT(*),
    COALESCE(SUM(debit), 0),
    COALESCE(SUM(credit), 0)
  INTO v_line_count, v_sum_debit, v_sum_credit
  FROM public.journal_lines
  WHERE journal_entry_id = p_entry_id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'MIN_TWO_LINES: يجب أن يحتوي القيد على سطرين على الأقل قبل الترحيل.';
  END IF;

  IF v_sum_debit <= 0 OR v_sum_debit <> v_sum_credit THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: لا يمكن ترحيل قيد غير متوازن (المدين: %, الدائن: %).', v_sum_debit, v_sum_credit;
  END IF;

  -- Re-verify every line account & cost center is still active and valid at posting time
  SELECT COUNT(*) INTO v_invalid_line_count
  FROM public.journal_lines jl
  JOIN public.accounts a ON a.id = jl.account_id
  LEFT JOIN public.cost_centers cc ON cc.id = jl.cost_center_id
  WHERE jl.journal_entry_id = p_entry_id
    AND (
      a.status <> 'ACTIVE'
      OR a.is_postable <> true
      OR (a.cost_center_required = true AND jl.cost_center_id IS NULL)
      OR (jl.cost_center_id IS NOT NULL AND (cc.id IS NULL OR cc.status <> 'ACTIVE'))
    );

  IF v_invalid_line_count > 0 THEN
    RAISE EXCEPTION 'INVALID_LINES_AT_POSTING: أحد بنود القيد يحتوي على حساب أو مركز تكلفة غير نشط أو مفقود.';
  END IF;

  UPDATE public.journal_entries
  SET period_id = v_period_id,
      total_debit = v_sum_debit,
      total_credit = v_sum_credit,
      status = 'POSTED',
      posted_by = p_actor_id,
      posted_at = timezone('utc', now())
  WHERE id = p_entry_id;

  RETURN p_entry_id;
END;
$$;

-- Atomic finalize voucher + generate & post double-entry journal atomically
CREATE OR REPLACE FUNCTION public.finalize_voucher_atomic(
  p_voucher_id UUID,
  p_actor_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor RECORD;
  v_voucher RECORD;
  v_period_id UUID;
  v_cash_acc RECORD;
  v_counter_acc RECORD;
  v_cc_status TEXT;
  v_entry_id UUID;
  v_entry_number TEXT;
  v_source_type TEXT;
  v_debit_acc UUID;
  v_credit_acc UUID;
  v_debit_cc UUID;
  v_credit_cc UUID;
BEGIN
  SELECT role, is_active INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active <> true OR v_actor.role <> 'ADMIN' THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED: اعتماد وترحيل السندات متاح لمدير النظام فقط.';
  END IF;

  SELECT * INTO v_voucher FROM public.vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: السند غير موجود.';
  END IF;

  IF v_voucher.status = 'POSTED' OR v_voucher.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_POSTED: تم اعتماد وترحيل هذا السند مسبقاً ولا يمكن تكرار الترحيل.';
  END IF;

  v_period_id := public.resolve_open_period(v_voucher.voucher_date);

  SELECT id, status, is_postable, cost_center_required INTO v_cash_acc
  FROM public.accounts WHERE id = v_voucher.cash_bank_account_id;
  IF NOT FOUND OR v_cash_acc.status <> 'ACTIVE' OR v_cash_acc.is_postable <> true THEN
    RAISE EXCEPTION 'INVALID_CASH_ACCOUNT: حساب الصندوق/البنك غير نشط أو غير قابل للترحيل.';
  END IF;

  SELECT id, status, is_postable, cost_center_required INTO v_counter_acc
  FROM public.accounts WHERE id = v_voucher.counter_account_id;
  IF NOT FOUND OR v_counter_acc.status <> 'ACTIVE' OR v_counter_acc.is_postable <> true THEN
    RAISE EXCEPTION 'INVALID_COUNTER_ACCOUNT: الحساب المقابل غير نشط أو غير قابل للترحيل.';
  END IF;

  IF (v_cash_acc.cost_center_required = true OR v_counter_acc.cost_center_required = true)
     AND v_voucher.cost_center_id IS NULL THEN
    RAISE EXCEPTION 'COST_CENTER_REQUIRED: أحد الحسابات المحددة يتطلب اختيار مركز تكلفة.';
  END IF;

  IF v_voucher.cost_center_id IS NOT NULL THEN
    SELECT status INTO v_cc_status FROM public.cost_centers WHERE id = v_voucher.cost_center_id;
    IF NOT FOUND OR v_cc_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'INVALID_COST_CENTER: مركز التكلفة المحدد غير نشط.';
    END IF;
  END IF;

  v_entry_number := public.next_document_number('journal', 'JE');

  IF v_voucher.voucher_type = 'RECEIPT' THEN
    v_source_type := 'RECEIPT_VOUCHER';
    v_debit_acc := v_voucher.cash_bank_account_id;
    v_credit_acc := v_voucher.counter_account_id;
    v_debit_cc := CASE WHEN v_cash_acc.cost_center_required THEN v_voucher.cost_center_id ELSE NULL END;
    v_credit_cc := CASE WHEN v_counter_acc.cost_center_required OR NOT v_cash_acc.cost_center_required THEN v_voucher.cost_center_id ELSE NULL END;
  ELSE
    v_source_type := 'PAYMENT_VOUCHER';
    v_debit_acc := v_voucher.counter_account_id;
    v_credit_acc := v_voucher.cash_bank_account_id;
    v_debit_cc := CASE WHEN v_counter_acc.cost_center_required OR NOT v_cash_acc.cost_center_required THEN v_voucher.cost_center_id ELSE NULL END;
    v_credit_cc := CASE WHEN v_cash_acc.cost_center_required THEN v_voucher.cost_center_id ELSE NULL END;
  END IF;

  -- Create journal entry as DRAFT first so lines can be inserted cleanly, then mark POSTED
  INSERT INTO public.journal_entries (
    entry_number, entry_date, period_id, description, reference_number, cost_center_id,
    status, source_type, source_voucher_id, total_debit, total_credit, created_by
  ) VALUES (
    v_entry_number,
    v_voucher.voucher_date,
    v_period_id,
    CASE WHEN v_voucher.voucher_type = 'RECEIPT'
      THEN 'سند قبض رقم ' || v_voucher.voucher_number || ' — ' || v_voucher.party_name || ': ' || v_voucher.description
      ELSE 'سند صرف رقم ' || v_voucher.voucher_number || ' — ' || v_voucher.party_name || ': ' || v_voucher.description
    END,
    v_voucher.reference_number,
    v_voucher.cost_center_id,
    'DRAFT',
    v_source_type,
    v_voucher.id,
    v_voucher.amount,
    v_voucher.amount,
    v_voucher.created_by
  )
  RETURNING id INTO v_entry_id;

  INSERT INTO public.journal_lines (journal_entry_id, line_order, account_id, cost_center_id, debit, credit, description)
  VALUES
    (v_entry_id, 1, v_debit_acc, v_debit_cc, v_voucher.amount, 0, v_voucher.description),
    (v_entry_id, 2, v_credit_acc, v_credit_cc, 0, v_voucher.amount, v_voucher.description);

  UPDATE public.journal_entries
  SET status = 'POSTED',
      posted_by = p_actor_id,
      posted_at = timezone('utc', now())
  WHERE id = v_entry_id;

  UPDATE public.vouchers
  SET period_id = v_period_id,
      status = 'POSTED',
      journal_entry_id = v_entry_id,
      posted_by = p_actor_id,
      posted_at = timezone('utc', now())
  WHERE id = v_voucher.id;

  RETURN v_entry_id;
END;
$$;

-- Atomic create draft voucher
CREATE OR REPLACE FUNCTION public.create_voucher_atomic(
  p_voucher_type TEXT,
  p_voucher_date DATE,
  p_payment_method TEXT,
  p_cash_bank_account_id UUID,
  p_counter_account_id UUID,
  p_party_name TEXT,
  p_amount NUMERIC(18, 2),
  p_description TEXT,
  p_reference_number TEXT,
  p_cost_center_id UUID,
  p_actor_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period_id UUID;
  v_voucher_number TEXT;
  v_voucher_id UUID;
  v_cash_acc RECORD;
  v_counter_acc RECORD;
  v_cc_status TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_actor_id AND is_active = true) THEN
    RAISE EXCEPTION 'UNAUTHORIZED_ACTOR: المستخدم غير نشط.';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: يجب أن يكون مبلغ السند أكبر من صفر.';
  END IF;

  IF p_cash_bank_account_id = p_counter_account_id THEN
    RAISE EXCEPTION 'SAME_ACCOUNTS: لا يمكن أن يكون حساب الصندوق/البنك والحساب المقابل نفس الحساب.';
  END IF;

  v_period_id := public.resolve_open_period(p_voucher_date);

  SELECT id, status, is_postable, cost_center_required INTO v_cash_acc
  FROM public.accounts WHERE id = p_cash_bank_account_id;
  IF NOT FOUND OR v_cash_acc.status <> 'ACTIVE' OR v_cash_acc.is_postable <> true THEN
    RAISE EXCEPTION 'INVALID_CASH_ACCOUNT: حساب الصندوق/البنك غير نشط أو غير قابل للترحيل.';
  END IF;

  SELECT id, status, is_postable, cost_center_required INTO v_counter_acc
  FROM public.accounts WHERE id = p_counter_account_id;
  IF NOT FOUND OR v_counter_acc.status <> 'ACTIVE' OR v_counter_acc.is_postable <> true THEN
    RAISE EXCEPTION 'INVALID_COUNTER_ACCOUNT: الحساب المقابل غير نشط أو غير قابل للترحيل.';
  END IF;

  IF (v_cash_acc.cost_center_required = true OR v_counter_acc.cost_center_required = true) AND p_cost_center_id IS NULL THEN
    RAISE EXCEPTION 'COST_CENTER_REQUIRED: أحد الحسابات المحددة يتطلب اختيار مركز تكلفة.';
  END IF;

  IF p_cost_center_id IS NOT NULL THEN
    SELECT status INTO v_cc_status FROM public.cost_centers WHERE id = p_cost_center_id;
    IF NOT FOUND OR v_cc_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'INVALID_COST_CENTER: مركز التكلفة المحدد غير نشط.';
    END IF;
  END IF;

  IF p_voucher_type = 'RECEIPT' THEN
    v_voucher_number := public.next_document_number('receipt', 'RV');
  ELSIF p_voucher_type = 'PAYMENT' THEN
    v_voucher_number := public.next_document_number('payment', 'PV');
  ELSE
    RAISE EXCEPTION 'INVALID_VOUCHER_TYPE: نوع السند غير صحيح.';
  END IF;

  INSERT INTO public.vouchers (
    voucher_type, voucher_number, voucher_date, period_id, payment_method,
    cash_bank_account_id, counter_account_id, party_name, amount,
    description, reference_number, cost_center_id, status, created_by
  ) VALUES (
    p_voucher_type, v_voucher_number, p_voucher_date, v_period_id, p_payment_method,
    p_cash_bank_account_id, p_counter_account_id, trim(p_party_name), p_amount,
    trim(p_description), NULLIF(trim(COALESCE(p_reference_number, '')), ''), p_cost_center_id, 'DRAFT', p_actor_id
  )
  RETURNING id INTO v_voucher_id;

  RETURN v_voucher_id;
END;
$$;

-- Atomic update draft voucher
CREATE OR REPLACE FUNCTION public.update_draft_voucher_atomic(
  p_voucher_id UUID,
  p_voucher_date DATE,
  p_payment_method TEXT,
  p_cash_bank_account_id UUID,
  p_counter_account_id UUID,
  p_party_name TEXT,
  p_amount NUMERIC(18, 2),
  p_description TEXT,
  p_reference_number TEXT,
  p_cost_center_id UUID,
  p_actor_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor RECORD;
  v_voucher RECORD;
  v_period_id UUID;
  v_cash_acc RECORD;
  v_counter_acc RECORD;
  v_cc_status TEXT;
BEGIN
  SELECT role, is_active INTO v_actor FROM public.profiles WHERE id = p_actor_id;
  IF NOT FOUND OR v_actor.is_active <> true THEN
    RAISE EXCEPTION 'UNAUTHORIZED_ACTOR: المستخدم غير نشط.';
  END IF;

  SELECT * INTO v_voucher FROM public.vouchers WHERE id = p_voucher_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: السند غير موجود.';
  END IF;

  IF v_voucher.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'POSTED_VOUCHER_IMMUTABLE: السند المرحل غير قابل للتعديل.';
  END IF;

  IF v_actor.role <> 'ADMIN' AND v_voucher.created_by <> p_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN: لا يمكنك تعديل سند مسودة أنشأه مستخدم آخر.';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: يجب أن يكون مبلغ السند أكبر من صفر.';
  END IF;

  IF p_cash_bank_account_id = p_counter_account_id THEN
    RAISE EXCEPTION 'SAME_ACCOUNTS: لا يمكن أن يكون حساب الصندوق/البنك والحساب المقابل نفس الحساب.';
  END IF;

  v_period_id := public.resolve_open_period(p_voucher_date);

  SELECT id, status, is_postable, cost_center_required INTO v_cash_acc
  FROM public.accounts WHERE id = p_cash_bank_account_id;
  IF NOT FOUND OR v_cash_acc.status <> 'ACTIVE' OR v_cash_acc.is_postable <> true THEN
    RAISE EXCEPTION 'INVALID_CASH_ACCOUNT: حساب الصندوق/البنك غير نشط أو غير قابل للترحيل.';
  END IF;

  SELECT id, status, is_postable, cost_center_required INTO v_counter_acc
  FROM public.accounts WHERE id = p_counter_account_id;
  IF NOT FOUND OR v_counter_acc.status <> 'ACTIVE' OR v_counter_acc.is_postable <> true THEN
    RAISE EXCEPTION 'INVALID_COUNTER_ACCOUNT: الحساب المقابل غير نشط أو غير قابل للترحيل.';
  END IF;

  IF (v_cash_acc.cost_center_required = true OR v_counter_acc.cost_center_required = true) AND p_cost_center_id IS NULL THEN
    RAISE EXCEPTION 'COST_CENTER_REQUIRED: أحد الحسابات المحددة يتطلب اختيار مركز تكلفة.';
  END IF;

  IF p_cost_center_id IS NOT NULL THEN
    SELECT status INTO v_cc_status FROM public.cost_centers WHERE id = p_cost_center_id;
    IF NOT FOUND OR v_cc_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'INVALID_COST_CENTER: مركز التكلفة المحدد غير نشط.';
    END IF;
  END IF;

  UPDATE public.vouchers
  SET voucher_date = p_voucher_date,
      period_id = v_period_id,
      payment_method = p_payment_method,
      cash_bank_account_id = p_cash_bank_account_id,
      counter_account_id = p_counter_account_id,
      party_name = trim(p_party_name),
      amount = p_amount,
      description = trim(p_description),
      reference_number = NULLIF(trim(COALESCE(p_reference_number, '')), ''),
      cost_center_id = p_cost_center_id
  WHERE id = p_voucher_id;

  RETURN p_voucher_id;
END;
$$;

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

-- Atomic Admin-only journal deletion RPC (supports any journal entry including voucher-linked entries)
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

  PERFORM set_config('app.bypass_admin_delete_guard', 'true', true);

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

  UPDATE public.journal_entries
  SET reversed_entry_id = NULL
  WHERE reversed_entry_id = p_entry_id;

  DELETE FROM public.journal_entries WHERE id = p_entry_id;

  PERFORM set_config('app.bypass_admin_delete_guard', 'false', true);
  RETURN true;
END;
$$;

-- Restrict privileged atomic RPCs to service_role only (never callable directly by anon/authenticated)
REVOKE ALL ON FUNCTION public.next_document_number(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_document_number(TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.create_journal_entry_with_lines(DATE, TEXT, TEXT, UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_journal_entry_with_lines(DATE, TEXT, TEXT, UUID, JSONB, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.update_draft_journal_entry(UUID, DATE, TEXT, TEXT, UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_draft_journal_entry(UUID, DATE, TEXT, TEXT, UUID, JSONB, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.post_journal_entry_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_journal_entry_atomic(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.reverse_journal_entry_atomic(UUID, DATE, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_journal_entry_atomic(UUID, DATE, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.delete_journal_entry_atomic(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_journal_entry_atomic(UUID, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_voucher_atomic(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_voucher_atomic(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.create_voucher_atomic(TEXT, DATE, TEXT, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_voucher_atomic(TEXT, DATE, TEXT, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.update_draft_voucher_atomic(UUID, DATE, TEXT, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_draft_voucher_atomic(UUID, DATE, TEXT, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, UUID, UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- 12. ROW LEVEL SECURITY (RLS) & PRIVILEGES
-- ----------------------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_centers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;

-- Revoke default anon/public access
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM public;

-- Grant explicit privileges to authenticated and service_role
GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

GRANT SELECT (id, full_name, username, role, is_active, created_at, updated_at) ON public.profiles TO authenticated;
GRANT SELECT ON public.accounts, public.cost_centers, public.accounting_periods,
  public.journal_entries, public.journal_lines, public.vouchers TO authenticated;
GRANT INSERT, UPDATE ON public.journal_entries, public.journal_lines, public.vouchers TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.accounts, public.cost_centers, public.accounting_periods, public.profiles TO authenticated;
GRANT DELETE ON public.journal_entries, public.journal_lines, public.vouchers TO authenticated;

-- PROFILES RLS
DROP POLICY IF EXISTS profiles_select_policy ON public.profiles;
CREATE POLICY profiles_select_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (id = public.current_actor_id() OR public.is_admin());

DROP POLICY IF EXISTS profiles_admin_insert ON public.profiles;
CREATE POLICY profiles_admin_insert ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS profiles_admin_update ON public.profiles;
CREATE POLICY profiles_admin_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- SYSTEM SEQUENCES RLS (service_role / SECURITY DEFINER functions only)
DROP POLICY IF EXISTS system_sequences_deny_all ON public.system_sequences;
CREATE POLICY system_sequences_deny_all ON public.system_sequences
  FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

-- ACCOUNTS RLS
DROP POLICY IF EXISTS accounts_select_active ON public.accounts;
CREATE POLICY accounts_select_active ON public.accounts
  FOR SELECT TO authenticated
  USING (public.is_active_user());

DROP POLICY IF EXISTS accounts_admin_all ON public.accounts;
CREATE POLICY accounts_admin_all ON public.accounts
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- COST CENTERS RLS
DROP POLICY IF EXISTS cost_centers_select_active ON public.cost_centers;
CREATE POLICY cost_centers_select_active ON public.cost_centers
  FOR SELECT TO authenticated
  USING (public.is_active_user());

DROP POLICY IF EXISTS cost_centers_admin_all ON public.cost_centers;
CREATE POLICY cost_centers_admin_all ON public.cost_centers
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ACCOUNTING PERIODS RLS
DROP POLICY IF EXISTS periods_select_active ON public.accounting_periods;
CREATE POLICY periods_select_active ON public.accounting_periods
  FOR SELECT TO authenticated
  USING (public.is_active_user());

DROP POLICY IF EXISTS periods_admin_all ON public.accounting_periods;
CREATE POLICY periods_admin_all ON public.accounting_periods
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- JOURNAL ENTRIES RLS
DROP POLICY IF EXISTS journal_entries_select ON public.journal_entries;
CREATE POLICY journal_entries_select ON public.journal_entries
  FOR SELECT TO authenticated
  USING (public.is_active_user());

DROP POLICY IF EXISTS journal_entries_insert ON public.journal_entries;
CREATE POLICY journal_entries_insert ON public.journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND created_by = public.current_actor_id()
    AND status = 'DRAFT'
    AND posted_by IS NULL
    AND posted_at IS NULL
  );

DROP POLICY IF EXISTS journal_entries_update ON public.journal_entries;
CREATE POLICY journal_entries_update ON public.journal_entries
  FOR UPDATE TO authenticated
  USING (
    status = 'DRAFT'
    AND (public.is_admin() OR (public.is_active_user() AND created_by = public.current_actor_id()))
  )
  WITH CHECK (
    public.is_admin()
    OR (public.is_active_user() AND created_by = public.current_actor_id() AND status = 'DRAFT')
  );

DROP POLICY IF EXISTS journal_entries_delete ON public.journal_entries;
CREATE POLICY journal_entries_delete ON public.journal_entries
  FOR DELETE TO authenticated
  USING (public.is_admin() AND status = 'DRAFT');

-- JOURNAL LINES RLS
DROP POLICY IF EXISTS journal_lines_select ON public.journal_lines;
CREATE POLICY journal_lines_select ON public.journal_lines
  FOR SELECT TO authenticated
  USING (public.is_active_user());

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

-- VOUCHERS RLS
DROP POLICY IF EXISTS vouchers_select ON public.vouchers;
CREATE POLICY vouchers_select ON public.vouchers
  FOR SELECT TO authenticated
  USING (public.is_active_user());

DROP POLICY IF EXISTS vouchers_insert ON public.vouchers;
CREATE POLICY vouchers_insert ON public.vouchers
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND created_by = public.current_actor_id()
    AND status = 'DRAFT'
    AND journal_entry_id IS NULL
  );

DROP POLICY IF EXISTS vouchers_update ON public.vouchers;
CREATE POLICY vouchers_update ON public.vouchers
  FOR UPDATE TO authenticated
  USING (
    status = 'DRAFT'
    AND (public.is_admin() OR (public.is_active_user() AND created_by = public.current_actor_id()))
  )
  WITH CHECK (
    public.is_admin()
    OR (public.is_active_user() AND created_by = public.current_actor_id() AND status = 'DRAFT')
  );

DROP POLICY IF EXISTS vouchers_delete ON public.vouchers;
CREATE POLICY vouchers_delete ON public.vouchers
  FOR DELETE TO authenticated
  USING (public.is_admin() AND status = 'DRAFT');
