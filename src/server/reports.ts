import * as XLSX from 'xlsx';
import {
  computeAccountLedger,
  computeBalanceSheet,
  computeCostCenterProfitability,
  computeIncomeStatement,
  computeTrialBalance,
  type PostedLineFact,
} from '../shared/accounting.ts';
import type {
  Account,
  AccountLedgerReport,
  BalanceSheetReport,
  CostCenter,
  CostCenterProfitabilityReport,
  IncomeStatementReport,
  TrialBalanceReport,
} from '../shared/types.ts';
import { dbQuery } from './db.ts';
import { AppError } from './errors.ts';

export async function fetchAllAccounts(): Promise<Account[]> {
  const { rows } = await dbQuery<Account>(
    `SELECT * FROM public.accounts ORDER BY code ASC`,
  );
  return rows;
}

export async function fetchAllCostCenters(): Promise<CostCenter[]> {
  const { rows } = await dbQuery<CostCenter>(
    `SELECT * FROM public.cost_centers ORDER BY code ASC`,
  );
  return rows;
}

export async function fetchPostedLineFacts(): Promise<PostedLineFact[]> {
  const { rows } = await dbQuery<PostedLineFact>(
    `SELECT
       jl.id AS line_id,
       je.id AS entry_id,
       je.entry_number,
       je.entry_date::TEXT AS entry_date,
       je.description AS entry_description,
       je.reference_number,
       jl.account_id,
       jl.cost_center_id,
       cc.name_ar AS cost_center_name,
       jl.debit,
       jl.credit,
       jl.description AS line_description
     FROM public.journal_lines jl
     INNER JOIN public.journal_entries je ON je.id = jl.journal_entry_id
     LEFT JOIN public.cost_centers cc ON cc.id = jl.cost_center_id
     WHERE je.status = 'POSTED'`,
  );
  return rows;
}

export async function buildAccountLedger(
  accountId: string,
  startDate: string,
  endDate: string,
  costCenterId: string | null,
): Promise<AccountLedgerReport> {
  const [accounts, facts] = await Promise.all([fetchAllAccounts(), fetchPostedLineFacts()]);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new AppError(404, 'الحساب المحدد غير موجود.', 'NOT_FOUND');
  }
  return computeAccountLedger(account, facts, startDate, endDate, costCenterId);
}

export async function buildTrialBalance(
  startDate: string,
  endDate: string,
  costCenterId: string | null,
): Promise<TrialBalanceReport> {
  const [accounts, facts] = await Promise.all([fetchAllAccounts(), fetchPostedLineFacts()]);
  return computeTrialBalance(accounts, facts, startDate, endDate, costCenterId);
}

export async function buildCostCenterProfitability(
  startDate: string,
  endDate: string,
): Promise<CostCenterProfitabilityReport> {
  const [costCenters, accounts, facts] = await Promise.all([
    fetchAllCostCenters(),
    fetchAllAccounts(),
    fetchPostedLineFacts(),
  ]);
  return computeCostCenterProfitability(costCenters, accounts, facts, startDate, endDate);
}

export async function buildIncomeStatement(
  startDate: string,
  endDate: string,
  costCenterId: string | null,
): Promise<IncomeStatementReport> {
  const [accounts, facts] = await Promise.all([fetchAllAccounts(), fetchPostedLineFacts()]);
  return computeIncomeStatement(accounts, facts, startDate, endDate, costCenterId);
}

export async function buildBalanceSheet(
  asOfDate: string,
  costCenterId: string | null,
): Promise<BalanceSheetReport> {
  const [accounts, facts] = await Promise.all([fetchAllAccounts(), fetchPostedLineFacts()]);
  return computeBalanceSheet(accounts, facts, asOfDate, costCenterId);
}

function createStyledSheet(
  title: string,
  periodLabel: string,
  headers: string[],
  rows: Array<Array<string | number>>,
  totalsRow?: Array<string | number>,
  numericColIndices: number[] = [],
): XLSX.WorkSheet {
  const aoa: Array<Array<string | number>> = [[title], [periodLabel], [], headers, ...rows];
  if (totalsRow) {
    aoa.push(totalsRow);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!views'] = [{ rightToLeft: true }];

  const lastCol = Math.max(0, headers.length - 1);
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
  ];

  ws['!cols'] = headers.map((h, colIdx) => {
    let maxLen = h.length;
    for (const r of rows) {
      const val = r[colIdx] !== undefined && r[colIdx] !== null ? String(r[colIdx]) : '';
      if (val.length > maxLen) maxLen = val.length;
    }
    if (totalsRow && totalsRow[colIdx] !== undefined) {
      const val = String(totalsRow[colIdx]);
      if (val.length > maxLen) maxLen = val.length;
    }
    return { wch: Math.min(45, Math.max(14, maxLen + 4)) };
  });

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let r = 4; r <= range.e.r; r++) {
    for (const c of numericColIndices) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell && typeof cell.v === 'number') {
        cell.z = '#,##0.00';
      }
    }
  }

  return ws;
}

export function generateReportWorkbookBuffer(
  reportType: 'ledger' | 'trial-balance' | 'cost-centers' | 'income-statement' | 'balance-sheet',
  payload: unknown,
): { buffer: Buffer; filename: string } {
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };

  if (reportType === 'ledger') {
    const data = payload as AccountLedgerReport;
    const headers = ['التاريخ', 'رقم القيد', 'البيان', 'مركز التكلفة', 'المرجع', 'مدين', 'دائن', 'الرصيد'];
    const rows = data.rows.map((r) => [
      r.entry_date,
      r.entry_number,
      r.line_description ? `${r.description} — ${r.line_description}` : r.description,
      r.cost_center_name ?? '-',
      r.reference_number ?? '-',
      r.debit,
      r.credit,
      r.running_balance,
    ]);
    rows.unshift(['-', '-', 'الرصيد الافتتاحي', '-', '-', 0, 0, data.openingBalance]);
    const totals = [
      'الإجمالي',
      '',
      '',
      '',
      '',
      data.totalDebit,
      data.totalCredit,
      data.closingBalance,
    ];
    const ws = createStyledSheet(
      `كشف حساب: ${data.account.code} — ${data.account.name_ar}`,
      `الفترة من ${data.startDate} إلى ${data.endDate}`,
      headers,
      rows,
      totals,
      [5, 6, 7],
    );
    XLSX.utils.book_append_sheet(wb, ws, 'أستاذ الحساب');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    return { buffer, filename: `ledger_${data.account.code}_${data.startDate}_${data.endDate}.xlsx` };
  }

  if (reportType === 'trial-balance') {
    const data = payload as TrialBalanceReport;
    const headers = [
      'رمز الحساب',
      'اسم الحساب',
      'افتتاحي مدين',
      'افتتاحي دائن',
      'حركة مدين',
      'حركة دائن',
      'ختامي مدين',
      'ختامي دائن',
    ];
    const rows = data.rows.map((r) => [
      r.code,
      r.name_ar,
      r.opening_debit,
      r.opening_credit,
      r.period_debit,
      r.period_credit,
      r.closing_debit,
      r.closing_credit,
    ]);
    const totals = [
      'الإجمالي',
      '',
      data.totals.opening_debit,
      data.totals.opening_credit,
      data.totals.period_debit,
      data.totals.period_credit,
      data.totals.closing_debit,
      data.totals.closing_credit,
    ];
    const ws = createStyledSheet(
      'ميزان المراجعة',
      `الفترة من ${data.startDate} إلى ${data.endDate}`,
      headers,
      rows,
      totals,
      [2, 3, 4, 5, 6, 7],
    );
    XLSX.utils.book_append_sheet(wb, ws, 'ميزان المراجعة');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    return { buffer, filename: `trial_balance_${data.startDate}_${data.endDate}.xlsx` };
  }

  if (reportType === 'cost-centers') {
    const data = payload as CostCenterProfitabilityReport;
    const headers = [
      'الرمز',
      'مركز التكلفة',
      'الإيرادات المباشرة',
      'المصروفات المباشرة',
      'الصافي المباشر',
      'إجمالي الإيرادات (شامل الفرعي)',
      'إجمالي المصروفات (شامل الفرعي)',
      'صافي الربح/الخسارة التجميعي',
    ];
    const rows = data.rows.map((r) => [
      r.code,
      r.name_ar,
      r.direct_revenue,
      r.direct_expenses,
      r.direct_net_profit,
      r.total_revenue,
      r.total_expenses,
      r.total_net_profit,
    ]);
    const totals = [
      'الإجمالي',
      '',
      data.totals.revenue,
      data.totals.expenses,
      data.totals.net_profit,
      '',
      '',
      '',
    ];
    const ws = createStyledSheet(
      'تقرير ربحية مراكز التكلفة',
      `الفترة من ${data.startDate} إلى ${data.endDate}`,
      headers,
      rows,
      totals,
      [2, 3, 4, 5, 6, 7],
    );
    XLSX.utils.book_append_sheet(wb, ws, 'ربحية مراكز التكلفة');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    return { buffer, filename: `cost_center_profitability_${data.startDate}_${data.endDate}.xlsx` };
  }

  if (reportType === 'income-statement') {
    const data = payload as IncomeStatementReport;
    const headers = ['التصنيف', 'رمز الحساب', 'اسم الحساب', 'المبلغ'];
    const rows: Array<Array<string | number>> = [
      ...data.revenues.map((r) => ['الإيرادات', r.code, r.name_ar, r.balance]),
      ['إجمالي الإيرادات', '', '', data.totalRevenue],
      ...data.expenses.map((r) => ['المصروفات', r.code, r.name_ar, r.balance]),
      ['إجمالي المصروفات', '', '', data.totalExpenses],
    ];
    const totals = ['صافي الربح / (الخسارة)', '', '', data.netProfit];
    const ws = createStyledSheet(
      'قائمة الدخل',
      `الفترة من ${data.startDate} إلى ${data.endDate}`,
      headers,
      rows,
      totals,
      [3],
    );
    XLSX.utils.book_append_sheet(wb, ws, 'قائمة الدخل');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    return { buffer, filename: `income_statement_${data.startDate}_${data.endDate}.xlsx` };
  }

  const data = payload as BalanceSheetReport;
  const headers = ['البند', 'رمز الحساب', 'اسم الحساب', 'الرصيد'];
  const rows: Array<Array<string | number>> = [
    ...data.assets.map((r) => ['الأصول', r.code, r.name_ar, r.balance]),
    ['إجمالي الأصول', '', '', data.totalAssets],
    ...data.liabilities.map((r) => ['الالتزامات', r.code, r.name_ar, r.balance]),
    ['إجمالي الالتزامات', '', '', data.totalLiabilities],
    ...data.equity.map((r) => ['حقوق الملكية', r.code, r.name_ar, r.balance]),
    ['أرباح / (خسائر) الفترة الحالية', '', '', data.currentPeriodNetProfit],
    ['إجمالي حقوق الملكية', '', '', data.totalEquity],
  ];
  const totals = ['إجمالي الالتزامات وحقوق الملكية', '', '', data.totalLiabilitiesAndEquity];
  const ws = createStyledSheet(
    'الميزانية العمومية (قائمة المركز المالي)',
    `كما في تاريخ ${data.asOfDate}`,
    headers,
    rows,
    totals,
    [3],
  );
  XLSX.utils.book_append_sheet(wb, ws, 'الميزانية العمومية');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return { buffer, filename: `balance_sheet_${data.asOfDate}.xlsx` };
}
