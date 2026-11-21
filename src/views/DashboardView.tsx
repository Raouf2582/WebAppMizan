import React, { useEffect, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  FolderTree,
} from 'lucide-react';
import { EmptyState, StatusText } from '../components/ui.tsx';
import { apiRequest } from '../lib/api.ts';
import { formatDate, formatMoney, JOURNAL_STATUS_LABELS } from '../lib/format.ts';
import type { DashboardSummary } from '../shared/types.ts';
import type { NavSection } from '../components/Layout.tsx';

export function DashboardView({
  onNavigate,
  onNotify,
}: {
  onNavigate: (section: NavSection) => void;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiRequest<{ summary: DashboardSummary }>('/api/dashboard')
      .then((res) => {
        if (active) setSummary(res.summary);
      })
      .catch((err) => {
        if (active) onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل لوحة التحكم.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onNotify]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg border border-slate-200 bg-white p-5" />
          ))}
        </div>
      </div>
    );
  }

  if (!summary) return null;

  const isEmptySystem =
    summary.totalAccounts === 0 &&
    summary.totalCostCenters === 0 &&
    summary.totalJournalEntries === 0;

  return (
    <div className="space-y-6">
      {isEmptySystem ? (
        <EmptyState
          icon={FolderTree}
          title="النظام المحاسبي جاهز للبدء"
          description="قاعدة البيانات فارغة تماماً كما هو مطلوب. ابدأ بإعداد الفترات المحاسبية وشجرة الحسابات ومراكز التكلفة لإدخال القيود والسندات."
          action={
            <button
              type="button"
              onClick={() => onNavigate('accounts')}
              className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
            >
              الانتقال إلى شجرة الحسابات
            </button>
          }
        />
      ) : null}

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="text-xs font-medium text-slate-500">إجمالي الحسابات</div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {summary.totalAccounts}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            نشط: <span className="font-mono tabular-nums">{summary.activeAccounts}</span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="text-xs font-medium text-slate-500">مراكز التكلفة</div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {summary.totalCostCenters}
          </div>
          <div className="mt-1 text-xs text-slate-500">مراكز التكلفة المسجلة</div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="text-xs font-medium text-slate-500">القيود اليومية</div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {summary.totalJournalEntries}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <span>مرحل: {summary.postedJournalEntries}</span>
            <span aria-hidden="true">·</span>
            <span>مسودة: {summary.draftJournalEntries}</span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="text-xs font-medium text-slate-500">صافي الربح / (الخسارة)</div>
          <div
            className={`mt-2 font-mono text-2xl font-bold tabular-nums ${
              summary.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {formatMoney(summary.netProfit)}
          </div>
          <div className="mt-1 text-xs text-slate-500">من القيود المرحلة فقط</div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="text-xs font-medium text-slate-500">إجمالي الحركات المدينة (مرحلة)</div>
          <div className="mt-2 font-mono text-xl font-bold text-slate-900 tabular-nums">
            {formatMoney(summary.totalDebitMovements)}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="text-xs font-medium text-slate-500">إجمالي الحركات الدائنة (مرحلة)</div>
          <div className="mt-2 font-mono text-xl font-bold text-slate-900 tabular-nums">
            {formatMoney(summary.totalCreditMovements)}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="text-xs font-medium text-slate-500">إجمالي الإيرادات</div>
          <div className="mt-2 font-mono text-xl font-bold text-emerald-700 tabular-nums">
            {formatMoney(summary.totalRevenue)}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="text-xs font-medium text-slate-500">إجمالي المصروفات</div>
          <div className="mt-2 font-mono text-xl font-bold text-slate-900 tabular-nums">
            {formatMoney(summary.totalExpenses)}
          </div>
        </div>
      </div>

      {/* Recent Journals */}
      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-bold text-slate-900">أحدث القيود اليومية</h2>
          <button
            type="button"
            onClick={() => onNavigate('journals')}
            className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
          >
            عرض جميع القيود
          </button>
        </div>
        {summary.recentJournals.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={BookOpen}
              title="لا توجد قيود يومية مسجلة"
              description="ستظهر هنا أحدث القيود المحاسبية فور إدخالها."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-3">رقم القيد</th>
                  <th className="px-4 py-3">التاريخ</th>
                  <th className="px-4 py-3">البيان</th>
                  <th className="px-4 py-3">إجمالي المدين</th>
                  <th className="px-4 py-3">إجمالي الدائن</th>
                  <th className="px-4 py-3">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {summary.recentJournals.map((je) => (
                  <tr key={je.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900">
                      {je.entry_number}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600 tabular-nums">
                      {formatDate(je.entry_date)}
                    </td>
                    <td className="px-4 py-3 text-slate-800">{je.description}</td>
                    <td className="px-4 py-3 font-mono text-slate-900 tabular-nums">
                      {formatMoney(je.total_debit)}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-900 tabular-nums">
                      {formatMoney(je.total_credit)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusText
                        variant={je.status === 'POSTED' ? 'posted' : 'draft'}
                        label={JOURNAL_STATUS_LABELS[je.status]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Vouchers Split */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="text-base font-bold text-slate-900">أحدث سندات القبض</h2>
            <button
              type="button"
              onClick={() => onNavigate('receipts')}
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
            >
              عرض الكل
            </button>
          </div>
          {summary.recentReceipts.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={ArrowDownLeft}
                title="لا توجد سندات قبض"
                description="لم يتم تسجيل أي سند قبض حتى الآن."
              />
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {summary.recentReceipts.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900">
                      <span className="font-mono text-xs text-slate-500">{v.voucher_number}</span>
                      {' · '}
                      <span>{v.party_name}</span>
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {formatDate(v.voucher_date)} · {v.description}
                    </div>
                  </div>
                  <div className="text-left shrink-0">
                    <div className="font-mono font-bold text-emerald-700 tabular-nums">
                      {formatMoney(v.amount)}
                    </div>
                    <StatusText
                      variant={v.status === 'POSTED' ? 'posted' : 'draft'}
                      label={JOURNAL_STATUS_LABELS[v.status]}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="text-base font-bold text-slate-900">أحدث سندات الصرف</h2>
            <button
              type="button"
              onClick={() => onNavigate('payments')}
              className="text-xs font-semibold text-emerald-700 hover:text-emerald-800"
            >
              عرض الكل
            </button>
          </div>
          {summary.recentPayments.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={ArrowUpRight}
                title="لا توجد سندات صرف"
                description="لم يتم تسجيل أي سند صرف حتى الآن."
              />
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {summary.recentPayments.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-4 px-5 py-3.5 text-sm">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900">
                      <span className="font-mono text-xs text-slate-500">{v.voucher_number}</span>
                      {' · '}
                      <span>{v.party_name}</span>
                    </div>
                    <div className="truncate text-xs text-slate-500">
                      {formatDate(v.voucher_date)} · {v.description}
                    </div>
                  </div>
                  <div className="text-left shrink-0">
                    <div className="font-mono font-bold text-slate-900 tabular-nums">
                      {formatMoney(v.amount)}
                    </div>
                    <StatusText
                      variant={v.status === 'POSTED' ? 'posted' : 'draft'}
                      label={JOURNAL_STATUS_LABELS[v.status]}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
