import React, { useCallback, useEffect, useState } from 'react';
import { CalendarRange, Lock, Plus, Unlock } from 'lucide-react';
import { ConfirmModal, EmptyState, ModalShell, StatusText } from '../components/ui.tsx';
import { apiRequest } from '../lib/api.ts';
import { formatDate, PERIOD_STATUS_LABELS } from '../lib/format.ts';
import type { AccountingPeriod } from '../shared/types.ts';

export function PeriodsView({
  onNotify,
}: {
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [nameAr, setNameAr] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [actionTarget, setActionTarget] = useState<{
    period: AccountingPeriod;
    action: 'close' | 'reopen';
  } | null>(null);

  const loadPeriods = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ periods: AccountingPeriod[] }>('/api/periods');
      setPeriods(res.periods);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل الفترات المحاسبية.');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadPeriods();
  }, [loadPeriods]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiRequest('/api/periods', {
        method: 'POST',
        body: { name_ar: nameAr, start_date: startDate, end_date: endDate },
      });
      onNotify('success', 'تم إنشاء الفترة المحاسبية بنجاح.');
      setModalOpen(false);
      setNameAr('');
      setStartDate('');
      setEndDate('');
      await loadPeriods();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر إنشاء الفترة المحاسبية.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleStatus() {
    if (!actionTarget) return;
    setSaving(true);
    try {
      await apiRequest(`/api/periods/${actionTarget.period.id}/${actionTarget.action}`, {
        method: 'POST',
      });
      onNotify(
        'success',
        actionTarget.action === 'close' ? 'تم إغلاق الفترة المحاسبية.' : 'تم إعادة فتح الفترة المحاسبية.',
      );
      setActionTarget(null);
      await loadPeriods();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحديث حالة الفترة.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-600">
          تُشترط وجود فترة محاسبية مفتوحة تغطي تاريخ كل قيد أو سند مالي قبل حفظه أو ترحيله.
        </p>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>إضافة فترة محاسبية</span>
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">جاري التحميل...</div>
        ) : periods.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={CalendarRange}
              title="لا توجد فترات محاسبية"
              description="أنشئ أول فترة محاسبية (مثل السنة المالية أو الشهر الحالي) للسماح بتسجيل القيود والسندات."
              action={
                <button
                  type="button"
                  onClick={() => setModalOpen(true)}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                >
                  إنشاء فترة محاسبية
                </button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-3">اسم الفترة</th>
                  <th className="px-4 py-3">تاريخ البداية</th>
                  <th className="px-4 py-3">تاريخ النهاية</th>
                  <th className="px-4 py-3">الحالة</th>
                  <th className="px-4 py-3">تاريخ الإغلاق</th>
                  <th className="px-4 py-3">إجراء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {periods.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-semibold text-slate-900">{p.name_ar}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700 tabular-nums">
                      {formatDate(p.start_date)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700 tabular-nums">
                      {formatDate(p.end_date)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusText
                        variant={p.status === 'OPEN' ? 'open' : 'closed'}
                        label={PERIOD_STATUS_LABELS[p.status]}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500 tabular-nums">
                      {formatDate(p.closed_at)}
                    </td>
                    <td className="px-4 py-3">
                      {p.status === 'OPEN' ? (
                        <button
                          type="button"
                          onClick={() => setActionTarget({ period: p, action: 'close' })}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
                        >
                          <Lock className="h-3.5 w-3.5" />
                          <span>إغلاق الفترة</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setActionTarget({ period: p, action: 'reopen' })}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                          <Unlock className="h-3.5 w-3.5" />
                          <span>إعادة فتح</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ModalShell open={modalOpen} title="إنشاء فترة محاسبية جديدة" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">اسم الفترة المحاسبية</label>
            <input
              type="text"
              required
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              placeholder="مثال: السنة المالية 2026"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">تاريخ البداية</label>
              <input
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-emerald-700 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">تاريخ النهاية</label>
              <input
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-emerald-700 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {saving ? 'جاري الحفظ...' : 'إنشاء الفترة'}
            </button>
          </div>
        </form>
      </ModalShell>

      <ConfirmModal
        open={!!actionTarget}
        title={actionTarget?.action === 'close' ? 'تأكيد إغلاق الفترة' : 'تأكيد إعادة فتح الفترة'}
        message={
          actionTarget?.action === 'close'
            ? `سيؤدي إغلاق الفترة "${actionTarget?.period.name_ar}" إلى منع إضافة أو ترحيل أو تعديل أي قيود أو سندات ضمن تواريخها.`
            : `هل تريد إعادة فتح الفترة "${actionTarget?.period.name_ar}" للسماح بالحركات المحاسبية؟`
        }
        confirmLabel={actionTarget?.action === 'close' ? 'إغلاق الفترة' : 'إعادة الفتح'}
        danger={actionTarget?.action === 'close'}
        loading={saving}
        onConfirm={handleToggleStatus}
        onCancel={() => setActionTarget(null)}
      />
    </div>
  );
}
