import Decimal from 'decimal.js';
import type {
  Account,
  AccountLedgerReport,
  BalanceSheetReport,
  CostCenter,
  CostCenterProfitabilityReport,
  IncomeStatementReport,
  JournalLine,
  LedgerTransactionRow,
  StatementAccountRow,
  TrialBalanceReport,
  TrialBalanceRow,
} from './types.ts';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export function toMoney(value: Decimal.Value): number {
  return new Decimal(value || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

export function validateDoubleEntryLines(
  lines: Array<{ account_id: string; cost_center_id?: string | null; debit: number; credit: number }>,
  accountMap: Map<string, Account>,
  costCenterMap: Map<string, CostCenter>,
): { valid: boolean; totalDebit: number; totalCredit: number; error?: string } {
  if (!lines || lines.length < 2) {
    return { valid: false, totalDebit: 0, totalCredit: 0, error: 'يجب أن يحتوي القيد على سطرين على الأقل.' };
  }

  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const d = new Decimal(line.debit || 0).toDecimalPlaces(2);
    const c = new Decimal(line.credit || 0).toDecimalPlaces(2);

    if (d.lt(0) || c.lt(0)) {
      return { valid: false, totalDebit: 0, totalCredit: 0, error: `السطر ${i + 1}: المبالغ السالبة غير مسموح بها.` };
    }
    if ((d.gt(0) && c.gt(0)) || (d.eq(0) && c.eq(0))) {
      return {
        valid: false,
        totalDebit: 0,
        totalCredit: 0,
        error: `السطر ${i + 1}: يجب إدخال قيمة موجبة في المدين أو الدائن فقط.`,
      };
    }

    const account = accountMap.get(line.account_id);
    if (!account) {
      return { valid: false, totalDebit: 0, totalCredit: 0, error: `السطر ${i + 1}: الحساب غير موجود.` };
    }
    if (account.status !== 'ACTIVE' || !account.is_postable) {
      return {
        valid: false,
        totalDebit: 0,
        totalCredit: 0,
        error: `السطر ${i + 1}: الحساب (${account.code} - ${account.name_ar}) غير نشط أو غير قابل للترحيل.`,
      };
    }

    if (account.cost_center_required && !line.cost_center_id) {
      return {
        valid: false,
        totalDebit: 0,
        totalCredit: 0,
        error: `السطر ${i + 1}: الحساب (${account.name_ar}) يتطلب تحديد مركز تكلفة.`,
      };
    }

    if (line.cost_center_id) {
      const cc = costCenterMap.get(line.cost_center_id);
      if (!cc || cc.status !== 'ACTIVE') {
        return {
          valid: false,
          totalDebit: 0,
          totalCredit: 0,
          error: `السطر ${i + 1}: مركز التكلفة غير موجود أو غير نشط.`,
        };
      }
    }

    totalDebit = totalDebit.plus(d);
    totalCredit = totalCredit.plus(c);
  }

  if (totalDebit.lte(0) || !totalDebit.eq(totalCredit)) {
    return {
      valid: false,
      totalDebit: totalDebit.toNumber(),
      totalCredit: totalCredit.toNumber(),
      error: `القيد غير متوازن: إجمالي المدين (${totalDebit.toFixed(2)}) لا يساوي إجمالي الدائن (${totalCredit.toFixed(2)}).`,
    };
  }

  return {
    valid: true,
    totalDebit: totalDebit.toNumber(),
    totalCredit: totalCredit.toNumber(),
  };
}

export interface PostedLineFact {
  line_id: string;
  entry_id: string;
  entry_number: string;
  entry_date: string;
  entry_description: string;
  reference_number: string | null;
  account_id: string;
  cost_center_id: string | null;
  cost_center_name: string | null;
  debit: number | string;
  credit: number | string;
  line_description: string | null;
}

function signedDeltaForAccount(normalBalance: 'DEBIT' | 'CREDIT', debit: Decimal, credit: Decimal): Decimal {
  return normalBalance === 'DEBIT' ? debit.minus(credit) : credit.minus(debit);
}

export function computeAccountLedger(
  account: Account,
  facts: PostedLineFact[],
  startDate: string,
  endDate: string,
  costCenterId: string | null,
): AccountLedgerReport {
  const filtered = facts.filter(
    (f) => f.account_id === account.id && (!costCenterId || f.cost_center_id === costCenterId),
  );

  let opening = new Decimal(0);
  const inPeriod: PostedLineFact[] = [];

  for (const row of filtered) {
    if (row.entry_date < startDate) {
      opening = opening.plus(
        signedDeltaForAccount(account.normal_balance, new Decimal(row.debit), new Decimal(row.credit)),
      );
    } else if (row.entry_date <= endDate) {
      inPeriod.push(row);
    }
  }

  inPeriod.sort((a, b) => {
    if (a.entry_date !== b.entry_date) return a.entry_date.localeCompare(b.entry_date);
    return a.entry_number.localeCompare(b.entry_number);
  });

  let running = opening;
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  const rows: LedgerTransactionRow[] = inPeriod.map((item) => {
    const d = new Decimal(item.debit);
    const c = new Decimal(item.credit);
    totalDebit = totalDebit.plus(d);
    totalCredit = totalCredit.plus(c);
    running = running.plus(signedDeltaForAccount(account.normal_balance, d, c));

    return {
      line_id: item.line_id,
      entry_id: item.entry_id,
      entry_number: item.entry_number,
      entry_date: item.entry_date,
      description: item.entry_description,
      line_description: item.line_description,
      reference_number: item.reference_number,
      cost_center_name: item.cost_center_name,
      debit: toMoney(d),
      credit: toMoney(c),
      running_balance: toMoney(running),
    };
  });

  return {
    account,
    startDate,
    endDate,
    costCenterId,
    openingBalance: toMoney(opening),
    totalDebit: toMoney(totalDebit),
    totalCredit: toMoney(totalCredit),
    closingBalance: toMoney(running),
    rows,
  };
}

export function computeTrialBalance(
  accounts: Account[],
  facts: PostedLineFact[],
  startDate: string,
  endDate: string,
  costCenterId: string | null,
): TrialBalanceReport {
  const agg = new Map<
    string,
    { openD: Decimal; openC: Decimal; perD: Decimal; perC: Decimal }
  >();

  for (const acc of accounts) {
    agg.set(acc.id, {
      openD: new Decimal(0),
      openC: new Decimal(0),
      perD: new Decimal(0),
      perC: new Decimal(0),
    });
  }

  for (const f of facts) {
    if (costCenterId && f.cost_center_id !== costCenterId) continue;
    const bucket = agg.get(f.account_id);
    if (!bucket) continue;
    const d = new Decimal(f.debit);
    const c = new Decimal(f.credit);

    if (f.entry_date < startDate) {
      bucket.openD = bucket.openD.plus(d);
      bucket.openC = bucket.openC.plus(c);
    } else if (f.entry_date <= endDate) {
      bucket.perD = bucket.perD.plus(d);
      bucket.perC = bucket.perC.plus(c);
    }
  }

  const rows: TrialBalanceRow[] = [];
  let sumOpenD = new Decimal(0);
  let sumOpenC = new Decimal(0);
  let sumPerD = new Decimal(0);
  let sumPerC = new Decimal(0);
  let sumCloseD = new Decimal(0);
  let sumCloseC = new Decimal(0);

  const sortedAccounts = [...accounts].sort((a, b) => a.code.localeCompare(b.code));

  for (const acc of sortedAccounts) {
    const b = agg.get(acc.id)!;
    const openNet = b.openD.minus(b.openC);
    const openingDebit = openNet.gt(0) ? openNet : new Decimal(0);
    const openingCredit = openNet.lt(0) ? openNet.abs() : new Decimal(0);

    const closeNet = openNet.plus(b.perD).minus(b.perC);
    const closingDebit = closeNet.gt(0) ? closeNet : new Decimal(0);
    const closingCredit = closeNet.lt(0) ? closeNet.abs() : new Decimal(0);

    if (
      openingDebit.eq(0) &&
      openingCredit.eq(0) &&
      b.perD.eq(0) &&
      b.perC.eq(0) &&
      closingDebit.eq(0) &&
      closingCredit.eq(0)
    ) {
      continue;
    }

    sumOpenD = sumOpenD.plus(openingDebit);
    sumOpenC = sumOpenC.plus(openingCredit);
    sumPerD = sumPerD.plus(b.perD);
    sumPerC = sumPerC.plus(b.perC);
    sumCloseD = sumCloseD.plus(closingDebit);
    sumCloseC = sumCloseC.plus(closingCredit);

    rows.push({
      account_id: acc.id,
      code: acc.code,
      name_ar: acc.name_ar,
      account_type: acc.account_type,
      normal_balance: acc.normal_balance,
      opening_debit: toMoney(openingDebit),
      opening_credit: toMoney(openingCredit),
      period_debit: toMoney(b.perD),
      period_credit: toMoney(b.perC),
      closing_debit: toMoney(closingDebit),
      closing_credit: toMoney(closingCredit),
    });
  }

  return {
    startDate,
    endDate,
    costCenterId,
    rows,
    totals: {
      opening_debit: toMoney(sumOpenD),
      opening_credit: toMoney(sumOpenC),
      period_debit: toMoney(sumPerD),
      period_credit: toMoney(sumPerC),
      closing_debit: toMoney(sumCloseD),
      closing_credit: toMoney(sumCloseC),
    },
  };
}

export function computeIncomeStatement(
  accounts: Account[],
  facts: PostedLineFact[],
  startDate: string,
  endDate: string,
  costCenterId: string | null,
): IncomeStatementReport {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const balances = new Map<string, Decimal>();

  for (const f of facts) {
    if (f.entry_date < startDate || f.entry_date > endDate) continue;
    if (costCenterId && f.cost_center_id !== costCenterId) continue;

    const acc = accountMap.get(f.account_id);
    if (!acc || (acc.account_type !== 'REVENUE' && acc.account_type !== 'EXPENSE')) continue;

    const prev = balances.get(acc.id) ?? new Decimal(0);
    const d = new Decimal(f.debit);
    const c = new Decimal(f.credit);
    // Revenue increases with credit, Expense increases with debit
    const delta = acc.account_type === 'REVENUE' ? c.minus(d) : d.minus(c);
    balances.set(acc.id, prev.plus(delta));
  }

  const revenues: StatementAccountRow[] = [];
  const expenses: StatementAccountRow[] = [];
  let totalRevenue = new Decimal(0);
  let totalExpenses = new Decimal(0);

  for (const acc of [...accounts].sort((a, b) => a.code.localeCompare(b.code))) {
    const bal = balances.get(acc.id);
    if (!bal || bal.eq(0)) continue;

    const row: StatementAccountRow = {
      account_id: acc.id,
      code: acc.code,
      name_ar: acc.name_ar,
      account_type: acc.account_type,
      balance: toMoney(bal),
    };

    if (acc.account_type === 'REVENUE') {
      revenues.push(row);
      totalRevenue = totalRevenue.plus(bal);
    } else if (acc.account_type === 'EXPENSE') {
      expenses.push(row);
      totalExpenses = totalExpenses.plus(bal);
    }
  }

  const netProfit = totalRevenue.minus(totalExpenses);

  return {
    startDate,
    endDate,
    costCenterId,
    revenues,
    expenses,
    totalRevenue: toMoney(totalRevenue),
    totalExpenses: toMoney(totalExpenses),
    netProfit: toMoney(netProfit),
  };
}

export function computeBalanceSheet(
  accounts: Account[],
  facts: PostedLineFact[],
  asOfDate: string,
  costCenterId: string | null,
): BalanceSheetReport {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const balances = new Map<string, Decimal>();
  let totalRev = new Decimal(0);
  let totalExp = new Decimal(0);

  for (const f of facts) {
    if (f.entry_date > asOfDate) continue;
    if (costCenterId && f.cost_center_id !== costCenterId) continue;

    const acc = accountMap.get(f.account_id);
    if (!acc) continue;

    const d = new Decimal(f.debit);
    const c = new Decimal(f.credit);

    if (acc.account_type === 'REVENUE') {
      totalRev = totalRev.plus(c.minus(d));
      continue;
    }
    if (acc.account_type === 'EXPENSE') {
      totalExp = totalExp.plus(d.minus(c));
      continue;
    }

    const prev = balances.get(acc.id) ?? new Decimal(0);
    // Asset is normally Debit; Liability & Equity are normally Credit
    const delta = acc.account_type === 'ASSET' ? d.minus(c) : c.minus(d);
    balances.set(acc.id, prev.plus(delta));
  }

  const assets: StatementAccountRow[] = [];
  const liabilities: StatementAccountRow[] = [];
  const equity: StatementAccountRow[] = [];

  let totalAssets = new Decimal(0);
  let totalLiabilities = new Decimal(0);
  let totalEquityAccounts = new Decimal(0);

  for (const acc of [...accounts].sort((a, b) => a.code.localeCompare(b.code))) {
    const bal = balances.get(acc.id);
    if (!bal || bal.eq(0)) continue;

    const row: StatementAccountRow = {
      account_id: acc.id,
      code: acc.code,
      name_ar: acc.name_ar,
      account_type: acc.account_type,
      balance: toMoney(bal),
    };

    if (acc.account_type === 'ASSET') {
      assets.push(row);
      totalAssets = totalAssets.plus(bal);
    } else if (acc.account_type === 'LIABILITY') {
      liabilities.push(row);
      totalLiabilities = totalLiabilities.plus(bal);
    } else if (acc.account_type === 'EQUITY') {
      equity.push(row);
      totalEquityAccounts = totalEquityAccounts.plus(bal);
    }
  }

  const currentPeriodNetProfit = totalRev.minus(totalExp);
  const totalEquity = totalEquityAccounts.plus(currentPeriodNetProfit);
  const totalLiabilitiesAndEquity = totalLiabilities.plus(totalEquity);

  return {
    asOfDate,
    costCenterId,
    assets,
    liabilities,
    equity,
    currentPeriodNetProfit: toMoney(currentPeriodNetProfit),
    totalAssets: toMoney(totalAssets),
    totalLiabilities: toMoney(totalLiabilities),
    totalEquity: toMoney(totalEquity),
    totalLiabilitiesAndEquity: toMoney(totalLiabilitiesAndEquity),
    isBalanced: toMoney(totalAssets) === toMoney(totalLiabilitiesAndEquity),
  };
}

export function computeCostCenterProfitability(
  costCenters: CostCenter[],
  accounts: Account[],
  facts: PostedLineFact[],
  startDate: string,
  endDate: string,
): CostCenterProfitabilityReport {
  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const directMap = new Map<string, { rev: Decimal; exp: Decimal }>();

  for (const cc of costCenters) {
    directMap.set(cc.id, { rev: new Decimal(0), exp: new Decimal(0) });
  }

  for (const f of facts) {
    if (!f.cost_center_id) continue;
    if (f.entry_date < startDate || f.entry_date > endDate) continue;

    const acc = accountMap.get(f.account_id);
    if (!acc || (acc.account_type !== 'REVENUE' && acc.account_type !== 'EXPENSE')) continue;

    const bucket = directMap.get(f.cost_center_id);
    if (!bucket) continue;

    const d = new Decimal(f.debit);
    const c = new Decimal(f.credit);
    if (acc.account_type === 'REVENUE') {
      bucket.rev = bucket.rev.plus(c.minus(d));
    } else {
      bucket.exp = bucket.exp.plus(d.minus(c));
    }
  }

  // Build parent -> children map for hierarchical rollup without double counting totals
  const childrenMap = new Map<string, string[]>();
  for (const cc of costCenters) {
    if (cc.parent_id) {
      const arr = childrenMap.get(cc.parent_id) ?? [];
      arr.push(cc.id);
      childrenMap.set(cc.parent_id, arr);
    }
  }

  const rollupCache = new Map<string, { rev: Decimal; exp: Decimal }>();
  function getRollup(id: string, visited = new Set<string>()): { rev: Decimal; exp: Decimal } {
    if (rollupCache.has(id)) return rollupCache.get(id)!;
    if (visited.has(id)) return { rev: new Decimal(0), exp: new Decimal(0) };
    visited.add(id);

    const direct = directMap.get(id) ?? { rev: new Decimal(0), exp: new Decimal(0) };
    let rev = direct.rev;
    let exp = direct.exp;

    for (const childId of childrenMap.get(id) ?? []) {
      const childTotals = getRollup(childId, visited);
      rev = rev.plus(childTotals.rev);
      exp = exp.plus(childTotals.exp);
    }

    const res = { rev, exp };
    rollupCache.set(id, res);
    return res;
  }

  let grandRev = new Decimal(0);
  let grandExp = new Decimal(0);

  const rows = [...costCenters]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((cc) => {
      const direct = directMap.get(cc.id)!;
      const total = getRollup(cc.id);
      grandRev = grandRev.plus(direct.rev);
      grandExp = grandExp.plus(direct.exp);

      return {
        cost_center_id: cc.id,
        code: cc.code,
        name_ar: cc.name_ar,
        parent_id: cc.parent_id,
        status: cc.status,
        direct_revenue: toMoney(direct.rev),
        direct_expenses: toMoney(direct.exp),
        direct_net_profit: toMoney(direct.rev.minus(direct.exp)),
        total_revenue: toMoney(total.rev),
        total_expenses: toMoney(total.exp),
        total_net_profit: toMoney(total.rev.minus(total.exp)),
      };
    });

  return {
    startDate,
    endDate,
    rows,
    totals: {
      revenue: toMoney(grandRev),
      expenses: toMoney(grandExp),
      net_profit: toMoney(grandRev.minus(grandExp)),
    },
  };
}
