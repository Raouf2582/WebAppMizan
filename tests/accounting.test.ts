import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { generateReportWorkbookBuffer } from '../src/server/reports.ts';
import {
  computeAccountLedger,
  computeBalanceSheet,
  computeCostCenterProfitability,
  computeIncomeStatement,
  computeTrialBalance,
  validateDoubleEntryLines,
  type PostedLineFact,
} from '../src/shared/accounting.ts';
import type { Account, CostCenter } from '../src/shared/types.ts';
import {
  createUserSchema,
  deleteJournalSchema,
  journalEntrySchema,
  reverseJournalSchema,
  setupAdminSchema,
  updateUserSchema,
  voucherSchema,
} from '../src/shared/validation.ts';

const ts = '2026-01-01T00:00:00Z';

const testAccounts: Account[] = [
  {
    id: 'acc-group-assets',
    code: '1000',
    name_ar: 'الأصول',
    account_type: 'ASSET',
    normal_balance: 'DEBIT',
    parent_id: null,
    is_postable: false,
    status: 'ACTIVE',
    cost_center_required: false,
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'acc-cash',
    code: '1101',
    name_ar: 'الصندوق الرئيسي',
    account_type: 'ASSET',
    normal_balance: 'DEBIT',
    parent_id: 'acc-group-assets',
    is_postable: true,
    status: 'ACTIVE',
    cost_center_required: false,
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'acc-ap',
    code: '2101',
    name_ar: 'الموردون',
    account_type: 'LIABILITY',
    normal_balance: 'CREDIT',
    parent_id: null,
    is_postable: true,
    status: 'ACTIVE',
    cost_center_required: false,
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'acc-capital',
    code: '3101',
    name_ar: 'رأس المال',
    account_type: 'EQUITY',
    normal_balance: 'CREDIT',
    parent_id: null,
    is_postable: true,
    status: 'ACTIVE',
    cost_center_required: false,
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'acc-sales',
    code: '4101',
    name_ar: 'إيرادات المبيعات',
    account_type: 'REVENUE',
    normal_balance: 'CREDIT',
    parent_id: null,
    is_postable: true,
    status: 'ACTIVE',
    cost_center_required: true,
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'acc-rent',
    code: '5101',
    name_ar: 'مصروف الإيجار',
    account_type: 'EXPENSE',
    normal_balance: 'DEBIT',
    parent_id: null,
    is_postable: true,
    status: 'ACTIVE',
    cost_center_required: true,
    created_at: ts,
    updated_at: ts,
  },
];

const testCostCenters: CostCenter[] = [
  {
    id: 'cc-hq',
    code: 'CC-01',
    name_ar: 'المركز الرئيسي',
    description: null,
    parent_id: null,
    status: 'ACTIVE',
    created_at: ts,
    updated_at: ts,
  },
  {
    id: 'cc-branch',
    code: 'CC-01-01',
    name_ar: 'فرع المبيعات',
    description: null,
    parent_id: 'cc-hq',
    status: 'ACTIVE',
    created_at: ts,
    updated_at: ts,
  },
];

const accountMap = new Map(testAccounts.map((a) => [a.id, a]));
const ccMap = new Map(testCostCenters.map((c) => [c.id, c]));

test('Double-entry validation accepts balanced entries and rejects unbalanced/invalid entries', () => {
  const valid = validateDoubleEntryLines(
    [
      { account_id: 'acc-cash', debit: 1000.55, credit: 0 },
      { account_id: 'acc-capital', debit: 0, credit: 1000.55 },
    ],
    accountMap,
    ccMap,
  );
  assert.equal(valid.valid, true);
  assert.equal(valid.totalDebit, 1000.55);

  // Unbalanced
  const unbalanced = validateDoubleEntryLines(
    [
      { account_id: 'acc-cash', debit: 1000, credit: 0 },
      { account_id: 'acc-capital', debit: 0, credit: 999.99 },
    ],
    accountMap,
    ccMap,
  );
  assert.equal(unbalanced.valid, false);

  // Group non-postable account rejected
  const groupAcc = validateDoubleEntryLines(
    [
      { account_id: 'acc-group-assets', debit: 500, credit: 0 },
      { account_id: 'acc-capital', debit: 0, credit: 500 },
    ],
    accountMap,
    ccMap,
  );
  assert.equal(groupAcc.valid, false);

  // Required cost center enforced
  const missingCc = validateDoubleEntryLines(
    [
      { account_id: 'acc-cash', debit: 500, credit: 0 },
      { account_id: 'acc-sales', debit: 0, credit: 500, cost_center_id: null },
    ],
    accountMap,
    ccMap,
  );
  assert.equal(missingCc.valid, false);
});

test('Financial reports (Ledger, Trial Balance, Income Statement, Balance Sheet, Cost Center Profitability) compute exact balances', () => {
  const facts: PostedLineFact[] = [
    // Opening capital injection: 2026-01-01
    {
      line_id: 'l1',
      entry_id: 'e1',
      entry_number: 'JE-000001',
      entry_date: '2026-01-01',
      entry_description: 'إيداع رأس المال',
      reference_number: null,
      account_id: 'acc-cash',
      cost_center_id: null,
      cost_center_name: null,
      debit: 10000,
      credit: 0,
      line_description: null,
    },
    {
      line_id: 'l2',
      entry_id: 'e1',
      entry_number: 'JE-000001',
      entry_date: '2026-01-01',
      entry_description: 'إيداع رأس المال',
      reference_number: null,
      account_id: 'acc-capital',
      cost_center_id: null,
      cost_center_name: null,
      debit: 0,
      credit: 10000,
      line_description: null,
    },
    // Revenue in branch CC: 2026-02-10
    {
      line_id: 'l3',
      entry_id: 'e2',
      entry_number: 'JE-000002',
      entry_date: '2026-02-10',
      entry_description: 'مبيعات نقدية',
      reference_number: null,
      account_id: 'acc-cash',
      cost_center_id: 'cc-branch',
      cost_center_name: 'فرع المبيعات',
      debit: 2500.75,
      credit: 0,
      line_description: null,
    },
    {
      line_id: 'l4',
      entry_id: 'e2',
      entry_number: 'JE-000002',
      entry_date: '2026-02-10',
      entry_description: 'مبيعات نقدية',
      reference_number: null,
      account_id: 'acc-sales',
      cost_center_id: 'cc-branch',
      cost_center_name: 'فرع المبيعات',
      debit: 0,
      credit: 2500.75,
      line_description: null,
    },
    // Rent expense on credit (AP) in HQ CC: 2026-02-15
    {
      line_id: 'l5',
      entry_id: 'e3',
      entry_number: 'JE-000003',
      entry_date: '2026-02-15',
      entry_description: 'استحقاق إيجار',
      reference_number: null,
      account_id: 'acc-rent',
      cost_center_id: 'cc-hq',
      cost_center_name: 'المركز الرئيسي',
      debit: 800.25,
      credit: 0,
      line_description: null,
    },
    {
      line_id: 'l6',
      entry_id: 'e3',
      entry_number: 'JE-000003',
      entry_date: '2026-02-15',
      entry_description: 'استحقاق إيجار',
      reference_number: null,
      account_id: 'acc-ap',
      cost_center_id: 'cc-hq',
      cost_center_name: 'المركز الرئيسي',
      debit: 0,
      credit: 800.25,
      line_description: null,
    },
  ];

  // Ledger for Cash in Feb 2026 (opening should be 10000, closing 12500.75)
  const cashLedger = computeAccountLedger(
    accountMap.get('acc-cash')!,
    facts,
    '2026-02-01',
    '2026-02-28',
    null,
  );
  assert.equal(cashLedger.openingBalance, 10000);
  assert.equal(cashLedger.totalDebit, 2500.75);
  assert.equal(cashLedger.closingBalance, 12500.75);

  // Trial balance must balance on opening, period, and closing
  const tb = computeTrialBalance(testAccounts, facts, '2026-02-01', '2026-02-28', null);
  assert.equal(tb.totals.opening_debit, tb.totals.opening_credit);
  assert.equal(tb.totals.period_debit, tb.totals.period_credit);
  assert.equal(tb.totals.closing_debit, tb.totals.closing_credit);

  // Income statement
  const is = computeIncomeStatement(testAccounts, facts, '2026-01-01', '2026-02-28', null);
  assert.equal(is.totalRevenue, 2500.75);
  assert.equal(is.totalExpenses, 800.25);
  assert.equal(is.netProfit, 1700.5);

  // Balance Sheet equation: Assets (12500.75) == Liabilities (800.25) + Equity (10000 + 1700.50)
  const bs = computeBalanceSheet(testAccounts, facts, '2026-02-28', null);
  assert.equal(bs.totalAssets, 12500.75);
  assert.equal(bs.totalLiabilities, 800.25);
  assert.equal(bs.totalEquity, 11700.5);
  assert.equal(bs.isBalanced, true);

  // Cost center profitability hierarchical rollup
  const ccReport = computeCostCenterProfitability(
    testCostCenters,
    testAccounts,
    facts,
    '2026-01-01',
    '2026-12-31',
  );
  const hqRow = ccReport.rows.find((r) => r.cost_center_id === 'cc-hq')!;
  assert.equal(hqRow.direct_expenses, 800.25);
  assert.equal(hqRow.total_revenue, 2500.75);
  assert.equal(hqRow.total_net_profit, 1700.5);
  // Totals do not double-count parent+child
  assert.equal(ccReport.totals.net_profit, 1700.5);

  // Real XLSX generation verification
  const { buffer } = generateReportWorkbookBuffer('trial-balance', tb);
  const wb = XLSX.read(buffer, { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('ميزان المراجعة'));
});

test('Zod schemas reject invalid journal and voucher payloads', () => {
  const badVoucher = voucherSchema.safeParse({
    voucher_type: 'RECEIPT',
    voucher_date: '2026-02-01',
    payment_method: 'CASH',
    cash_bank_account_id: '11111111-1111-1111-1111-111111111111',
    counter_account_id: '11111111-1111-1111-1111-111111111111',
    party_name: 'عميل',
    amount: 100,
    description: 'دفعة',
  });
  assert.equal(badVoucher.success, false);

  const badJournal = journalEntrySchema.safeParse({
    entry_date: '2026-02-01',
    description: 'قيد',
    lines: [
      {
        account_id: '11111111-1111-1111-1111-111111111111',
        debit: 100,
        credit: 50,
      },
    ],
  });
  assert.equal(badJournal.success, false);
});

test('Header-level cost_center_id validates and propagates across all debit and credit lines', () => {
  const ccUuid = '22222222-2222-4222-8222-222222222222';
  const parsed = journalEntrySchema.safeParse({
    entry_date: '2026-02-10',
    description: 'قيد مبيعات على مستوى الرأس',
    cost_center_id: ccUuid,
    lines: [
      { account_id: '11111111-1111-4111-8111-111111111111', debit: 500, credit: 0 },
      { account_id: '33333333-3333-4333-8333-333333333333', debit: 0, credit: 500 },
    ],
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.cost_center_id, ccUuid);

  const headerCc = 'cc-branch';
  const linesWithoutPerLineCc = [
    { account_id: 'acc-cash', debit: 500, credit: 0 },
    { account_id: 'acc-sales', debit: 0, credit: 500 },
  ];

  // Propagating header cost center passes validation for accounts requiring cost center
  const normalized = linesWithoutPerLineCc.map((l) => ({ ...l, cost_center_id: headerCc }));
  const validWithHeader = validateDoubleEntryLines(normalized, accountMap, ccMap);
  assert.equal(validWithHeader.valid, true);

  // Without header cost center, line for acc-sales (cost_center_required: true) is rejected
  const normalizedWithoutHeader = linesWithoutPerLineCc.map((l) => ({ ...l, cost_center_id: null }));
  const invalidWithoutHeader = validateDoubleEntryLines(normalizedWithoutHeader, accountMap, ccMap);
  assert.equal(invalidWithoutHeader.valid, false);
});

test('Username-only auth schemas require username without email and enforce only 6-char minimum password', () => {
  const validPasswords = ['123456', 'abcdef', 'abc123', 'ABCDEF', '123abc', 'longerpassword99'];
  for (const pwd of validPasswords) {
    assert.equal(
      setupAdminSchema.safeParse({ full_name: 'مدير النظام', username: 'admin1', password: pwd }).success,
      true,
    );
    assert.equal(
      createUserSchema.safeParse({ full_name: 'محاسب', username: 'user_1', password: pwd, role: 'USER' }).success,
      true,
    );
    assert.equal(updateUserSchema.safeParse({ password: pwd }).success, true);
  }

  for (const shortPwd of ['', '1', '12345', 'abcde']) {
    assert.equal(
      setupAdminSchema.safeParse({ full_name: 'مدير النظام', username: 'admin1', password: shortPwd }).success,
      false,
    );
    assert.equal(
      createUserSchema.safeParse({ full_name: 'محاسب', username: 'user_1', password: shortPwd, role: 'USER' }).success,
      false,
    );
    assert.equal(updateUserSchema.safeParse({ password: shortPwd }).success, false);
  }

  // Rejects whitespace or <2 chars in username
  assert.equal(
    createUserSchema.safeParse({ full_name: 'محاسب', username: 'a', password: '123456', role: 'USER' }).success,
    false,
  );
  assert.equal(
    createUserSchema.safeParse({ full_name: 'محاسب', username: 'user 1', password: '123456', role: 'USER' }).success,
    false,
  );

  // Edit user with username and omitted password succeeds; invalid username fails
  assert.equal(
    updateUserSchema.safeParse({
      full_name: 'محاسب أول',
      username: 'senior_acc',
      role: 'ADMIN',
      is_active: true,
    }).success,
    true,
  );
  assert.equal(
    updateUserSchema.safeParse({ username: 'bad user' }).success,
    false,
  );
});

test('Reversal schema validates entry_date and reversed lines preserve cost center and flip debit/credit cleanly', () => {
  assert.equal(reverseJournalSchema.safeParse({ entry_date: '2026-11-18' }).success, true);
  assert.equal(reverseJournalSchema.safeParse({ entry_date: '18-11-2026' }).success, false);
  assert.equal(reverseJournalSchema.safeParse({}).success, false);

  const originalLines = [
    { account_id: 'acc-cash', cost_center_id: 'cc-branch', debit: 1250.5, credit: 0 },
    { account_id: 'acc-sales', cost_center_id: 'cc-branch', debit: 0, credit: 1250.5 },
  ];

  const reversedLines = originalLines.map((l) => ({
    account_id: l.account_id,
    cost_center_id: l.cost_center_id,
    debit: l.credit,
    credit: l.debit,
  }));

  const check = validateDoubleEntryLines(reversedLines, accountMap, ccMap);
  assert.equal(check.valid, true);
  assert.equal(check.totalDebit, 1250.5);
  assert.equal(check.totalCredit, 1250.5);
  assert.equal(reversedLines[0].credit, 1250.5);
  assert.equal(reversedLines[1].debit, 1250.5);
});

test('deleteJournalSchema defaults to KEEP_DRAFT and rejects invalid voucher actions', () => {
  const def = deleteJournalSchema.safeParse({});
  assert.equal(def.success, true);
  assert.equal(def.data?.voucher_action, 'KEEP_DRAFT');

  assert.equal(deleteJournalSchema.safeParse({ voucher_action: 'DELETE_VOUCHER' }).success, true);
  assert.equal(deleteJournalSchema.safeParse({ voucher_action: 'KEEP_DRAFT' }).success, true);
  assert.equal(deleteJournalSchema.safeParse({ voucher_action: 'INVALID' }).success, false);
});





