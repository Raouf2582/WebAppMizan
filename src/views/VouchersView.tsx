import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Edit2,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import {
  ConfirmModal,
  EmptyState,
  ModalShell,
  StatusText,
} from '../components/ui.tsx';
import { apiRequest } from '../lib/api.ts';
import {
  formatDate,
  formatMoney,
  JOURNAL_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
} from '../lib/format.ts';
import type {
  Account,
  CostCenter,
  JournalStatus,
  PaymentMethod,
  UserProfile,
  Voucher,
  VoucherType,
} from '../shared/types.ts';

export function VouchersView({
  voucherType,
  profile,
  onNotify,
}: {
  voucherType: VoucherType;
  profile: UserProfile;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const isAdmin = profile.role === 'ADMIN';
  const isReceipt = voucherType === 'RECEIPT';
  const titleLabel = isReceipt ? 'سندات القبض' : 'سندات الصرف';
  const partyLabel = isReceipt ? 'المستلم منه' : 'المصروف له';

  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const [loading, setLoading] = useState(true);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<JournalStatus | 'ALL'>('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Form
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Voucher | null>(null);
  const [voucherDate, setVoucherDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [cashBankAccountId, setCashBankAccountId] = useState('');
  const [counterAccountId, setCounterAccountId] = useState('');
  const [partyName, setPartyName] = useState('');
  const [amount, setAmount] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [description, setDescription] = useState('');
  const [finalizeImmediately, setFinalizeImmediately] = useState(false);
  const [saving, setSaving] = useState(false);

  // Confirmations
  const [finalizeTarget, setFinalizeTarget] = useState<Voucher | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Voucher | null>(null);

  const postableAccounts = useMemo(
    () => accounts.filter((a) => a.status === 'ACTIVE' && a.is_postable),
    [accounts],
  );
  const cashAccounts = useMemo(
    () => postableAccounts.filter((a) => a.account_type === 'ASSET'),
    [postableAccounts],
  );
  const activeCostCenters = useMemo(
    () => costCenters.filter((c) => c.status === 'ACTIVE'),
    [costCenters],
  );
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const costCenterRequired = useMemo(() => {
    const c1 = cashBankAccountId ? accountMap.get(cashBankAccountId)?.cost_center_required : false;
    const c2 = counterAccountId ? accountMap.get(counterAccountId)?.cost_center_required : false;
    return Boolean(c1 || c2);
  }, [cashBankAccountId, counterAccountId, accountMap]);

  const loadMetadata = useCallback(async () => {
    try {
      const [accRes, ccRes] = await Promise.all([
        apiRequest<{ accounts?: Account[] }>('/api/accounts'),
        apiRequest<{ costCenters?: CostCenter[] }>('/api/cost-centers'),
      ]);
      setAccounts(Array.isArray(accRes.accounts) ? accRes.accounts : []);
      setCostCenters(Array.isArray(ccRes.costCenters) ? ccRes.costCenters : []);
    } catch {
      // ignore
    }
  }, []);

  const loadVouchers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        type: voucherType,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (search.trim()) params.set('search', search.trim());

      const res = await apiRequest<{ vouchers?: Voucher[]; total?: number }>(
        `/api/vouchers?${params.toString()}`,
      );
      setVouchers(Array.isArray(res.vouchers) ? res.vouchers : []);
      setTotal(typeof res.total === 'number' ? res.total : 0);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : `تعذر تحميل ${titleLabel}.`);
    } finally {
      setLoading(false);
    }
  }, [voucherType, page, statusFilter, startDate, endDate, search, titleLabel, onNotify]);

  useEffect(() => {
    setPage(1);
  }, [voucherType]);

  useEffect(() => {
    loadMetadata();
  }, [loadMetadata]);

  useEffect(() => {
    loadVouchers();
  }, [loadVouchers]);

  function openNew() {
    setEditing(null);
    setVoucherDate(new Date().toISOString().slice(0, 10));
    setPaymentMethod('CASH');
    setCashBankAccountId('');
    setCounterAccountId('');
    setPartyName('');
    setAmount('');
    setCostCenterId('');
    setReferenceNumber('');
    setDescription('');
    setFinalizeImmediately(false);
    setFormOpen(true);
  }

  function openEdit(v: Voucher) {
    setEditing(v);
    setVoucherDate(v.voucher_date);
    setPaymentMethod(v.payment_method);
    setCashBankAccountId(v.cash_bank_account_id);
    setCounterAccountId(v.counter_account_id);
    setPartyName(v.party_name);
    setAmount(String(v.amount));
    setCostCenterId(v.cost_center_id || '');
    setReferenceNumber(v.reference_number || '');
    setDescription(v.description);
    setFinalizeImmediately(false);
    setFormOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        voucher_type: voucherType,
        voucher_date: voucherDate,
        payment_method: paymentMethod,
        cash_bank_account_id: cashBankAccountId,
        counter_account_id: counterAccountId,
        party_name: partyName,
        amount: Number(amount),
        description,
        reference_number: referenceNumber || null,
        cost_center_id: costCenterId || null,
        finalize_immediately: isAdmin ? finalizeImmediately : false,
      };

      if (editing) {
        await apiRequest(`/api/vouchers/${editing.id}`, { method: 'PATCH', body });
        onNotify('success', 'تم تحديث السند بنجاح.');
      } else {
        await apiRequest('/api/vouchers', { method: 'POST', body });
        onNotify(
          'success',
          finalizeImmediately && isAdmin
            ? 'تم حفظ السند واعتماده وتوليد القيد المحاسبي تلقائياً.'
            : 'تم حفظ السند كمسودة.',
        );
      }

      setFormOpen(false);
      await loadVouchers();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حفظ السند.');
    } finally {
      setSaving(false);
    }
  }

  async function handleFinalize() {
    if (!finalizeTarget) return;
    setSaving(true);
    try {
      await apiRequest(`/api/vouchers/${finalizeTarget.id}/finalize`, { method: 'POST' });
      onNotify(
        'success',
        `تم اعتماد السند ${finalizeTarget.voucher_number} وتوليد وترحيل القيد المحاسبي المرتبط به.`,
      );
      setFinalizeTarget(null);
      await loadVouchers();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر اعتماد السند.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget || !isAdmin) return;
    setSaving(true);
    try {
      const res = await apiRequest<{
        deleted: boolean;
        voucherNumber: string;
        deletedJournalEntryNumber: string | null;
      }>(`/api/vouchers/${deleteTarget.id}`, { method: 'DELETE' });

      if (res.deletedJournalEntryNumber) {
        onNotify(
          'success',
          `تم حذف ${isReceipt ? 'سند القبض' : 'سند الصرف'} رقم "${res.voucherNumber}" وحذف القيد المحاسبي المرتبط "${res.deletedJournalEntryNumber}" بنجاح.`,
        );
      } else {
        onNotify(
          'success',
          `تم حذف ${isReceipt ? 'سند القبض' : 'سند الصرف'} رقم "${res.voucherNumber}" بنجاح.`,
        );
      }
      setDeleteTarget(null);
      await loadVouchers();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حذف السند.');
    } finally {
      setSaving(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cashAccObj = cashBankAccountId ? accountMap.get(cashBankAccountId) : undefined;
  const counterAccObj = counterAccountId ? accountMap.get(counterAccountId) : undefined;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="بحث برقم السند أو الطرف أو البيان..."
              className="w-56 rounded-lg border border-slate-300 py-2 pr-9 pl-3 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as JournalStatus | 'ALL');
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
          >
            <option value="ALL">كل الحالات</option>
            <option value="DRAFT">مسودة</option>
            <option value="POSTED">مرحل ومعتمد</option>
          </select>

          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-700"
          />
          <input
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-700"
          />
        </div>

        <button
          type="button"
          onClick={openNew}
          className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>{isReceipt ? 'سند قبض جديد' : 'سند صرف جديد'}</span>
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">جاري تحميل {titleLabel}...</div>
        ) : vouchers.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={isReceipt ? ArrowDownLeft : ArrowUpRight}
              title={`لا توجد ${titleLabel}`}
              description={
                isReceipt
                  ? 'أنشئ سند قبض لتسجيل المقبوضات النقدية أو البنكية وتوليد القيد التلقائي.'
                  : 'أنشئ سند صرف لتسجيل المدفوعات النقدية أو البنكية وتوليد القيد التلقائي.'
              }
              action={
                <button
                  type="button"
                  onClick={openNew}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                >
                  {isReceipt ? 'إنشاء سند قبض' : 'إنشاء سند صرف'}
                </button>
              }
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-3">رقم السند</th>
                    <th className="px-4 py-3">التاريخ</th>
                    <th className="px-4 py-3">{partyLabel}</th>
                    <th className="px-4 py-3">حساب الصندوق / البنك</th>
                    <th className="px-4 py-3">الحساب المقابل</th>
                    <th className="px-4 py-3">طريقة الدفع</th>
                    <th className="px-4 py-3">المبلغ</th>
                    <th className="px-4 py-3">رقم القيد</th>
                    <th className="px-4 py-3">الحالة</th>
                    <th className="px-4 py-3">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {vouchers.map((v) => {
                    const canEdit =
                      v.status === 'DRAFT' && (isAdmin || v.created_by === profile.id);
                    return (
                      <tr key={v.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900">
                          {v.voucher_number}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-600 tabular-nums">
                          {formatDate(v.voucher_date)}
                        </td>
                        <td className="px-4 py-3 font-medium text-slate-900">{v.party_name}</td>
                        <td className="px-4 py-3 text-xs text-slate-700">
                          {v.cash_bank_account
                            ? `${v.cash_bank_account.code} — ${v.cash_bank_account.name_ar}`
                            : '-'}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-700">
                          {v.counter_account
                            ? `${v.counter_account.code} — ${v.counter_account.name_ar}`
                            : '-'}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {PAYMENT_METHOD_LABELS[v.payment_method]}
                        </td>
                        <td className="px-4 py-3 font-mono font-bold text-slate-900 tabular-nums">
                          {formatMoney(v.amount)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-emerald-700">
                          {v.journal_entry?.entry_number || '-'}
                        </td>
                        <td className="px-4 py-3">
                          <StatusText
                            variant={v.status === 'POSTED' ? 'posted' : 'draft'}
                            label={JOURNAL_STATUS_LABELS[v.status]}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {canEdit ? (
                              <button
                                type="button"
                                onClick={() => openEdit(v)}
                                title="تعديل السند"
                                className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                              >
                                <Edit2 className="h-4 w-4" />
                              </button>
                            ) : null}
                            {isAdmin && v.status === 'DRAFT' ? (
                              <button
                                type="button"
                                onClick={() => setFinalizeTarget(v)}
                                title="اعتماد وتوليد القيد"
                                className="rounded p-1.5 text-emerald-700 hover:bg-emerald-50"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                              </button>
                            ) : null}
                            {isAdmin ? (
                              <button
                                type="button"
                                onClick={() => setDeleteTarget(v)}
                                title="حذف السند"
                                className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-600">
              <span>
                إجمالي السندات: <span className="font-mono font-semibold">{total}</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
                >
                  السابق
                </button>
                <span className="font-mono">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
                >
                  التالي
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Create / Edit Modal */}
      <ModalShell
        open={formOpen}
        title={
          editing
            ? `تعديل ${isReceipt ? 'سند قبض' : 'سند صرف'}`
            : isReceipt
              ? 'إنشاء سند قبض جديد'
              : 'إنشاء سند صرف جديد'
        }
        onClose={() => setFormOpen(false)}
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">التاريخ</label>
              <input
                type="date"
                required
                value={voucherDate}
                onChange={(e) => setVoucherDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">طريقة الدفع</label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">المبلغ</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                dir="ltr"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-left font-mono text-sm tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                حساب الصندوق / البنك
              </label>
              <select
                required
                value={cashBankAccountId}
                onChange={(e) => setCashBankAccountId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">اختر حساب الصندوق أو البنك...</option>
                {(cashAccounts.length > 0 ? cashAccounts : postableAccounts).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name_ar}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">الحساب المقابل</label>
              <select
                required
                value={counterAccountId}
                onChange={(e) => setCounterAccountId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">اختر الحساب المقابل...</option>
                {postableAccounts
                  .filter((a) => a.id !== cashBankAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name_ar}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">{partyLabel}</label>
              <input
                type="text"
                required
                value={partyName}
                onChange={(e) => setPartyName(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                مركز التكلفة {costCenterRequired ? '(إلزامي)*' : '(اختياري)'}
              </label>
              <select
                required={costCenterRequired}
                value={costCenterId}
                onChange={(e) => setCostCenterId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">بدون مركز تكلفة</option>
                {activeCostCenters.map((cc) => (
                  <option key={cc.id} value={cc.id}>
                    {cc.code} — {cc.name_ar}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">المرجع (اختياري)</label>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-700">البيان</label>
              <input
                type="text"
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          {/* Automatic Journal Entry Preview */}
          {cashAccObj && counterAccObj && Number(amount) > 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs">
              <div className="mb-2 font-bold text-slate-800">معاينة القيد المحاسبي التلقائي عند الاعتماد:</div>
              <div className="space-y-1 text-slate-700">
                <div className="flex justify-between">
                  <span>
                    من حـ / {isReceipt ? cashAccObj.name_ar : counterAccObj.name_ar} (مدين)
                  </span>
                  <span className="font-mono font-semibold tabular-nums">{formatMoney(amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span>
                    إلى حـ / {isReceipt ? counterAccObj.name_ar : cashAccObj.name_ar} (دائن)
                  </span>
                  <span className="font-mono font-semibold tabular-nums">{formatMoney(amount)}</span>
                </div>
              </div>
            </div>
          ) : null}

          {!editing && isAdmin ? (
            <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <input
                type="checkbox"
                checked={finalizeImmediately}
                onChange={(e) => setFinalizeImmediately(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-emerald-700"
              />
              <span>اعتماد السند وتوليد القيد المحاسبي وترحيله فوراً</span>
            </label>
          ) : null}

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {saving ? 'جاري الحفظ...' : editing ? 'تحديث السند' : 'حفظ السند'}
            </button>
          </div>
        </form>
      </ModalShell>

      <ConfirmModal
        open={!!finalizeTarget}
        title="تأكيد اعتماد السند وتوليد القيد"
        message={`هل تريد اعتماد السند رقم "${finalizeTarget?.voucher_number}"؟ سيتم توليد قيد يومية متوازن وترحيله آلياً ولا يمكن التراجع بعد الاعتماد.`}
        confirmLabel="اعتماد وترحيل"
        loading={saving}
        onConfirm={handleFinalize}
        onCancel={() => setFinalizeTarget(null)}
      />

      <ModalShell
        open={!!deleteTarget}
        title="تأكيد حذف السند"
        onClose={() => {
          if (!saving) setDeleteTarget(null);
        }}
        maxWidth="max-w-lg"
      >
        {deleteTarget ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <div className="text-xs text-slate-500">نوع السند</div>
                  <div className="mt-1 font-semibold text-slate-900">
                    {deleteTarget.voucher_type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">رقم السند</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900">
                    {deleteTarget.voucher_number}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">التاريخ</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900">
                    {formatDate(deleteTarget.voucher_date)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">المبلغ</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                    {formatMoney(deleteTarget.amount)}
                  </div>
                </div>
              </div>
            </div>

            {deleteTarget.journal_entry || deleteTarget.status === 'POSTED' ? (
              <div className="rounded-lg border border-red-200 bg-red-50/70 p-3.5 text-xs text-red-900">
                <div className="font-semibold">
                  تحذير: سيؤدي حذف هذا السند إلى حذف القيد المحاسبي المرتبط به تلقائياً
                  {deleteTarget.journal_entry?.entry_number ? (
                    <>
                      {' '}
                      (<span className="font-mono font-bold">{deleteTarget.journal_entry.entry_number}</span>)
                    </>
                  ) : null}
                  .
                </div>
                <p className="mt-1 text-red-800">
                  سيتم تحديث أرصدة حسابات الصندوق والبنك والحساب المقابل ودفتر الأستاذ وميزان المراجعة وجميع التقارير المالية فوراً.
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-700">
                هل أنت متأكد من حذف {deleteTarget.voucher_type === 'RECEIPT' ? 'سند القبض' : 'سند الصرف'} المسودة رقم{' '}
                <span className="font-mono font-semibold">{deleteTarget.voucher_number}</span> نهائياً؟
              </p>
            )}

            <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                type="button"
                disabled={saving}
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleDelete}
                className="rounded-lg bg-red-700 px-5 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
              >
                {saving ? 'جاري الحذف...' : 'تأكيد حذف السند'}
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>
    </div>
  );
}
