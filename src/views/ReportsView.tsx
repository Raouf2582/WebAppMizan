import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, Download, Printer } from 'lucide-react';
import { EmptyState } from '../components/ui.tsx';
import { apiRequest, downloadExcelFile } from '../lib/api.ts';
import { formatDate, formatMoney } from '../lib/format.ts';
import type {
  Account,
  AccountLedgerReport,
  BalanceSheetReport,
  CostCenter,
  CostCenterProfitabilityReport,
  IncomeStatementReport,
  TrialBalanceReport,
} from '../shared/types.ts';

type ReportTab =
  | 'ledger'
  | 'trial-balance'
  | 'cost-centers'
  | 'income-statement'
  | 'balance-sheet';

const REPORT_TABS: Array<{ id: ReportTab; label: string }> = [
  { id: 'ledger', label: 'أستاذ الحساب' },
  { id: 'trial-balance', label: 'ميزان المراجعة' },
  { id: 'cost-centers', label: 'ربحية مراكز التكلفة' },
  { id: 'income-statement', label: 'قائمة الدخل' },
  { id: 'balance-sheet', label: 'الميزانية العمومية' },
];

export function ReportsView({
  onNotify,
}: {
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<ReportTab>('trial-balance');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);

  // Filters
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const [accountId, setAccountId] = useState('');
  const [startDate, setStartDate] = useState(yearStart);
  const [endDate, setEndDate] = useState(today);
  const [asOfDate, setAsOfDate] = useState(today);
  const [costCenterId, setCostCenterId] = useState('');

  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [ledgerData, setLedgerData] = useState<AccountLedgerReport | null>(null);
  const [trialData, setTrialData] = useState<TrialBalanceReport | null>(null);
  const [ccData, setCcData] = useState<CostCenterProfitabilityReport | null>(null);
  const [incomeData, setIncomeData] = useState<IncomeStatementReport | null>(null);
  const [balanceData, setBalanceData] = useState<BalanceSheetReport | null>(null);

  useEffect(() => {
    Promise.all([
      apiRequest<{ accounts: Account[] }>('/api/accounts'),
      apiRequest<{ costCenters: CostCenter[] }>('/api/cost-centers'),
    ])
      .then(([accRes, ccRes]) => {
        setAccounts(accRes.accounts);
        setCostCenters(ccRes.costCenters);
        const firstPostable = accRes.accounts.find((a) => a.is_postable);
        if (firstPostable) setAccountId(firstPostable.id);
      })
      .catch(() => {});
  }, []);

  const fetchReport = useCallback(async () => {
    if (activeTab === 'ledger' && !accountId) {
      setLedgerData(null);
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (activeTab === 'balance-sheet') {
        params.set('asOfDate', asOfDate);
        if (costCenterId) params.set('costCenterId', costCenterId);
      } else {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
        if (activeTab !== 'cost-centers' && costCenterId) {
          params.set('costCenterId', costCenterId);
        }
        if (activeTab === 'ledger') {
          params.set('accountId', accountId);
        }
      }

      if (activeTab === 'ledger') {
        const res = await apiRequest<{ report: AccountLedgerReport }>(
          `/api/reports/ledger?${params.toString()}`,
        );
        setLedgerData(res.report);
      } else if (activeTab === 'trial-balance') {
        const res = await apiRequest<{ report: TrialBalanceReport }>(
          `/api/reports/trial-balance?${params.toString()}`,
        );
        setTrialData(res.report);
      } else if (activeTab === 'cost-centers') {
        const res = await apiRequest<{ report: CostCenterProfitabilityReport }>(
          `/api/reports/cost-centers?${params.toString()}`,
        );
        setCcData(res.report);
      } else if (activeTab === 'income-statement') {
        const res = await apiRequest<{ report: IncomeStatementReport }>(
          `/api/reports/income-statement?${params.toString()}`,
        );
        setIncomeData(res.report);
      } else if (activeTab === 'balance-sheet') {
        const res = await apiRequest<{ report: BalanceSheetReport }>(
          `/api/reports/balance-sheet?${params.toString()}`,
        );
        setBalanceData(res.report);
      }
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر إعداد التقرير المالي.');
    } finally {
      setLoading(false);
    }
  }, [activeTab, accountId, startDate, endDate, asOfDate, costCenterId, onNotify]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  async function handleExportExcel() {
    if (activeTab === 'ledger' && !accountId) {
      onNotify('error', 'يرجى اختيار الحساب أولاً.');
      return;
    }
    setExporting(true);
    try {
      const params = new URLSearchParams({ type: activeTab });
      if (activeTab === 'balance-sheet') {
        params.set('asOfDate', asOfDate);
        if (costCenterId) params.set('costCenterId', costCenterId);
      } else {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
        if (activeTab !== 'cost-centers' && costCenterId) params.set('costCenterId', costCenterId);
        if (activeTab === 'ledger') params.set('accountId', accountId);
      }
      await downloadExcelFile(
        `/api/reports/export/xlsx?${params.toString()}`,
        `${activeTab}.xlsx`,
      );
      onNotify('success', 'تم تصدير ملف Excel بنجاح.');
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تصدير التقرير.');
    } finally {
      setExporting(false);
    }
  }

  const activeTitle = REPORT_TABS.find((t) => t.id === activeTab)?.label || '';

  return (
    <div className="space-y-5">
      {/* Report Tabs */}
      <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
          {REPORT_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-md px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportExcel}
            disabled={exporting || (activeTab === 'ledger' && !accountId)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            <Download className="h-4 w-4 text-emerald-700" />
            <span>{exporting ? 'جاري التصدير...' : 'تصدير Excel'}</span>
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap"
          >
            <Printer className="h-4 w-4" />
            <span>طباعة / PDF</span>
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="no-print flex flex-wrap items-end gap-4 rounded-lg border border-slate-200 bg-white p-4">
        {activeTab === 'ledger' ? (
          <div className="min-w-[240px] flex-1">
            <label className="mb-1 block text-xs font-semibold text-slate-600">الحساب</label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">اختر الحساب...</option>
              {accounts
                .filter((a) => a.is_postable)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name_ar}
                  </option>
                ))}
            </select>
          </div>
        ) : null}

        {activeTab === 'balance-sheet' ? (
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">كما في تاريخ</label>
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">من تاريخ</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">إلى تاريخ</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
            </div>
          </>
        )}

        {activeTab !== 'cost-centers' ? (
          <div className="min-w-[200px]">
            <label className="mb-1 block text-xs font-semibold text-slate-600">تصفية بمركز التكلفة</label>
            <select
              value={costCenterId}
              onChange={(e) => setCostCenterId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">جميع مراكز التكلفة</option>
              {costCenters.map((cc) => (
                <option key={cc.id} value={cc.id}>
                  {cc.code} — {cc.name_ar}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <button
          type="button"
          onClick={fetchReport}
          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
        >
          تحديث التقرير
        </button>
      </div>

      {/* Printable Report Surface */}
      <div className="print-container rounded-lg border border-slate-200 bg-white p-6">
        <div className="mb-6 border-b border-slate-200 pb-4 text-center">
          <h2 className="text-lg font-bold text-slate-900">{activeTitle}</h2>
          <p className="mt-1 text-xs text-slate-500">
            {activeTab === 'balance-sheet'
              ? `كما في تاريخ: ${asOfDate}`
              : `الفترة من ${startDate} إلى ${endDate}`}
            {' · '}
            البيانات من القيود المرحلة فقط
          </p>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-slate-500">جاري احتساب التقرير المالي...</div>
        ) : activeTab === 'ledger' ? (
          !ledgerData ? (
            <EmptyState
              icon={BarChart3}
              title="اختر حساباً لعرض كشف الأستاذ"
              description="حدد الحساب المطلوب من الأعلى لعرض الرصيد الافتتاحي والحركات والرصيد الختامي."
            />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
                <div>
                  <span className="text-slate-500">الحساب: </span>
                  <span className="font-mono font-semibold">{ledgerData.account.code}</span> —{' '}
                  <span className="font-bold text-slate-900">{ledgerData.account.name_ar}</span>
                </div>
                <div className="flex flex-wrap gap-6">
                  <div>
                    <span className="text-slate-500">الرصيد الافتتاحي: </span>
                    <span className="font-mono font-bold tabular-nums">
                      {formatMoney(ledgerData.openingBalance)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">الرصيد الختامي: </span>
                    <span className="font-mono font-bold text-emerald-700 tabular-nums">
                      {formatMoney(ledgerData.closingBalance)}
                    </span>
                  </div>
                </div>
              </div>

              {ledgerData.rows.length === 0 ? (
                <EmptyState
                  icon={BarChart3}
                  title="لا توجد حركات مرحلة خلال الفترة"
                  description="لا توجد قيود مرحلة لهذا الحساب في النطاق الزمني المحدد."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                      <tr>
                        <th className="px-3 py-2.5">التاريخ</th>
                        <th className="px-3 py-2.5">رقم القيد</th>
                        <th className="px-3 py-2.5">البيان</th>
                        <th className="px-3 py-2.5">مركز التكلفة</th>
                        <th className="px-3 py-2.5">مدين</th>
                        <th className="px-3 py-2.5">دائن</th>
                        <th className="px-3 py-2.5">الرصيد التراكمي</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      <tr className="bg-slate-50/70 text-xs font-semibold text-slate-700">
                        <td className="px-3 py-2.5">-</td>
                        <td className="px-3 py-2.5">-</td>
                        <td className="px-3 py-2.5">الرصيد الافتتاحي</td>
                        <td className="px-3 py-2.5">-</td>
                        <td className="px-3 py-2.5 font-mono tabular-nums">0.00</td>
                        <td className="px-3 py-2.5 font-mono tabular-nums">0.00</td>
                        <td className="px-3 py-2.5 font-mono tabular-nums">
                          {formatMoney(ledgerData.openingBalance)}
                        </td>
                      </tr>
                      {ledgerData.rows.map((r) => (
                        <tr key={r.line_id} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-mono text-xs tabular-nums">
                            {formatDate(r.entry_date)}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-xs font-semibold">
                            {r.entry_number}
                          </td>
                          <td className="px-3 py-2.5">
                            {r.line_description ? `${r.description} — ${r.line_description}` : r.description}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-slate-600">
                            {r.cost_center_name || '-'}
                          </td>
                          <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.debit)}</td>
                          <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.credit)}</td>
                          <td className="px-3 py-2.5 font-mono font-semibold tabular-nums">
                            {formatMoney(r.running_balance)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-bold">
                      <tr>
                        <td colSpan={4} className="px-3 py-2.5">الإجمالي</td>
                        <td className="px-3 py-2.5 font-mono tabular-nums">
                          {formatMoney(ledgerData.totalDebit)}
                        </td>
                        <td className="px-3 py-2.5 font-mono tabular-nums">
                          {formatMoney(ledgerData.totalCredit)}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-emerald-700 tabular-nums">
                          {formatMoney(ledgerData.closingBalance)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )
        ) : activeTab === 'trial-balance' ? (
          !trialData || trialData.rows.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="ميزان المراجعة فارغ"
              description="لا توجد حركات مرحلة ضمن الفترة المحددة."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">الرمز</th>
                    <th className="px-3 py-2.5">اسم الحساب</th>
                    <th className="px-3 py-2.5">افتتاحي مدين</th>
                    <th className="px-3 py-2.5">افتتاحي دائن</th>
                    <th className="px-3 py-2.5">حركة مدين</th>
                    <th className="px-3 py-2.5">حركة دائن</th>
                    <th className="px-3 py-2.5">ختامي مدين</th>
                    <th className="px-3 py-2.5">ختامي دائن</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {trialData.rows.map((r) => (
                    <tr key={r.account_id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold">{r.code}</td>
                      <td className="px-3 py-2.5 font-medium text-slate-900">{r.name_ar}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.opening_debit)}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.opening_credit)}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.period_debit)}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.period_credit)}</td>
                      <td className="px-3 py-2.5 font-mono font-semibold tabular-nums">
                        {formatMoney(r.closing_debit)}
                      </td>
                      <td className="px-3 py-2.5 font-mono font-semibold tabular-nums">
                        {formatMoney(r.closing_credit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-bold">
                  <tr>
                    <td colSpan={2} className="px-3 py-2.5">الإجمالي</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatMoney(trialData.totals.opening_debit)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatMoney(trialData.totals.opening_credit)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatMoney(trialData.totals.period_debit)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatMoney(trialData.totals.period_credit)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-emerald-700 tabular-nums">
                      {formatMoney(trialData.totals.closing_debit)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-emerald-700 tabular-nums">
                      {formatMoney(trialData.totals.closing_credit)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        ) : activeTab === 'cost-centers' ? (
          !ccData || ccData.rows.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="لا توجد بيانات مراكز تكلفة"
              description="أضف مراكز تكلفة وقم بربط قيود الإيرادات والمصروفات بها لعرض الربحية."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">الرمز</th>
                    <th className="px-3 py-2.5">مركز التكلفة</th>
                    <th className="px-3 py-2.5">إيرادات مباشرة</th>
                    <th className="px-3 py-2.5">مصروفات مباشرة</th>
                    <th className="px-3 py-2.5">الصافي المباشر</th>
                    <th className="px-3 py-2.5">إيرادات تجميعية</th>
                    <th className="px-3 py-2.5">مصروفات تجميعية</th>
                    <th className="px-3 py-2.5">الصافي التجميعي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {ccData.rows.map((r) => (
                    <tr key={r.cost_center_id} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5 font-mono text-xs font-semibold">{r.code}</td>
                      <td className="px-3 py-2.5 font-medium text-slate-900">{r.name_ar}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.direct_revenue)}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.direct_expenses)}</td>
                      <td
                        className={`px-3 py-2.5 font-mono font-semibold tabular-nums ${
                          r.direct_net_profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {formatMoney(r.direct_net_profit)}
                      </td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.total_revenue)}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(r.total_expenses)}</td>
                      <td
                        className={`px-3 py-2.5 font-mono font-bold tabular-nums ${
                          r.total_net_profit >= 0 ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {formatMoney(r.total_net_profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-bold">
                  <tr>
                    <td colSpan={2} className="px-3 py-2.5">الإجمالي المباشر</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatMoney(ccData.totals.revenue)}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {formatMoney(ccData.totals.expenses)}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-emerald-700 tabular-nums">
                      {formatMoney(ccData.totals.net_profit)}
                    </td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )
        ) : activeTab === 'income-statement' ? (
          !incomeData || (incomeData.revenues.length === 0 && incomeData.expenses.length === 0) ? (
            <EmptyState
              icon={BarChart3}
              title="قائمة الدخل فارغة"
              description="لا توجد إيرادات أو مصروفات مرحلة ضمن الفترة المحددة."
            />
          ) : (
            <div className="space-y-6">
              <div>
                <h3 className="mb-2 text-sm font-bold text-slate-900">أولاً: الإيرادات</h3>
                <table className="w-full text-right text-sm">
                  <tbody className="divide-y divide-slate-200 border border-slate-200">
                    {incomeData.revenues.map((r) => (
                      <tr key={r.account_id}>
                        <td className="px-4 py-2.5 font-mono text-xs w-28">{r.code}</td>
                        <td className="px-4 py-2.5">{r.name_ar}</td>
                        <td className="px-4 py-2.5 font-mono text-left tabular-nums w-40">
                          {formatMoney(r.balance)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-bold">
                      <td colSpan={2} className="px-4 py-2.5">إجمالي الإيرادات</td>
                      <td className="px-4 py-2.5 font-mono text-left text-emerald-700 tabular-nums">
                        {formatMoney(incomeData.totalRevenue)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-bold text-slate-900">ثانياً: المصروفات</h3>
                <table className="w-full text-right text-sm">
                  <tbody className="divide-y divide-slate-200 border border-slate-200">
                    {incomeData.expenses.map((r) => (
                      <tr key={r.account_id}>
                        <td className="px-4 py-2.5 font-mono text-xs w-28">{r.code}</td>
                        <td className="px-4 py-2.5">{r.name_ar}</td>
                        <td className="px-4 py-2.5 font-mono text-left tabular-nums w-40">
                          {formatMoney(r.balance)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-bold">
                      <td colSpan={2} className="px-4 py-2.5">إجمالي المصروفات</td>
                      <td className="px-4 py-2.5 font-mono text-left text-slate-900 tabular-nums">
                        {formatMoney(incomeData.totalExpenses)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-slate-300 bg-slate-50 px-5 py-4 text-base font-bold">
                <span>صافي الربح / (الخسارة) للفترة</span>
                <span
                  className={`font-mono tabular-nums ${
                    incomeData.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {formatMoney(incomeData.netProfit)}
                </span>
              </div>
            </div>
          )
        ) : !balanceData ||
          (balanceData.assets.length === 0 &&
            balanceData.liabilities.length === 0 &&
            balanceData.equity.length === 0 &&
            balanceData.currentPeriodNetProfit === 0) ? (
          <EmptyState
            icon={BarChart3}
            title="الميزانية العمومية فارغة"
            description="لا توجد أرصدة أصول أو التزامات أو حقوق ملكية مرحلة حتى التاريخ المحدد."
          />
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* Assets */}
              <div>
                <h3 className="mb-2 text-sm font-bold text-slate-900">الأصول</h3>
                <table className="w-full text-right text-sm border border-slate-200">
                  <tbody className="divide-y divide-slate-200">
                    {balanceData.assets.map((r) => (
                      <tr key={r.account_id}>
                        <td className="px-3 py-2.5 font-mono text-xs w-24">{r.code}</td>
                        <td className="px-3 py-2.5">{r.name_ar}</td>
                        <td className="px-3 py-2.5 font-mono text-left tabular-nums">
                          {formatMoney(r.balance)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-bold">
                      <td colSpan={2} className="px-3 py-2.5">إجمالي الأصول</td>
                      <td className="px-3 py-2.5 font-mono text-left text-emerald-700 tabular-nums">
                        {formatMoney(balanceData.totalAssets)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Liabilities & Equity */}
              <div className="space-y-5">
                <div>
                  <h3 className="mb-2 text-sm font-bold text-slate-900">الالتزامات</h3>
                  <table className="w-full text-right text-sm border border-slate-200">
                    <tbody className="divide-y divide-slate-200">
                      {balanceData.liabilities.map((r) => (
                        <tr key={r.account_id}>
                          <td className="px-3 py-2.5 font-mono text-xs w-24">{r.code}</td>
                          <td className="px-3 py-2.5">{r.name_ar}</td>
                          <td className="px-3 py-2.5 font-mono text-left tabular-nums">
                            {formatMoney(r.balance)}
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50 font-bold">
                        <td colSpan={2} className="px-3 py-2.5">إجمالي الالتزامات</td>
                        <td className="px-3 py-2.5 font-mono text-left tabular-nums">
                          {formatMoney(balanceData.totalLiabilities)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-bold text-slate-900">حقوق الملكية</h3>
                  <table className="w-full text-right text-sm border border-slate-200">
                    <tbody className="divide-y divide-slate-200">
                      {balanceData.equity.map((r) => (
                        <tr key={r.account_id}>
                          <td className="px-3 py-2.5 font-mono text-xs w-24">{r.code}</td>
                          <td className="px-3 py-2.5">{r.name_ar}</td>
                          <td className="px-3 py-2.5 font-mono text-left tabular-nums">
                            {formatMoney(r.balance)}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <td className="px-3 py-2.5 font-mono text-xs">-</td>
                        <td className="px-3 py-2.5">أرباح / (خسائر) الفترة الحالية</td>
                        <td className="px-3 py-2.5 font-mono text-left tabular-nums">
                          {formatMoney(balanceData.currentPeriodNetProfit)}
                        </td>
                      </tr>
                      <tr className="bg-slate-50 font-bold">
                        <td colSpan={2} className="px-3 py-2.5">إجمالي حقوق الملكية</td>
                        <td className="px-3 py-2.5 font-mono text-left tabular-nums">
                          {formatMoney(balanceData.totalEquity)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm font-bold">
                  <span>إجمالي الالتزامات وحقوق الملكية</span>
                  <span className="font-mono text-emerald-700 tabular-nums">
                    {formatMoney(balanceData.totalLiabilitiesAndEquity)}
                  </span>
                </div>
              </div>
            </div>

            <div
              className={`rounded-lg border px-4 py-3 text-xs font-semibold ${
                balanceData.isBalanced
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {balanceData.isBalanced
                ? 'معادلة الميزانية متوازنة: إجمالي الأصول = إجمالي الالتزامات + حقوق الملكية'
                : 'تنبيه: الميزانية غير متوازنة!'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
