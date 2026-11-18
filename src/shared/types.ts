export type UserRole = 'ADMIN' | 'USER';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type EntityStatus = 'ACTIVE' | 'INACTIVE';
export type PeriodStatus = 'OPEN' | 'CLOSED';
export type JournalStatus = 'DRAFT' | 'POSTED';
export type JournalSourceType = 'MANUAL' | 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER';
export type VoucherType = 'RECEIPT' | 'PAYMENT';
export type PaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'CARD';

export interface UserProfile {
  id: string;
  full_name: string;
  username: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  code: string;
  name_ar: string;
  account_type: AccountType;
  normal_balance: NormalBalance;
  parent_id: string | null;
  is_postable: boolean;
  status: EntityStatus;
  cost_center_required: boolean;
  created_at: string;
  updated_at: string;
}

export interface CostCenter {
  id: string;
  code: string;
  name_ar: string;
  description: string | null;
  parent_id: string | null;
  status: EntityStatus;
  created_at: string;
  updated_at: string;
}

export interface AccountingPeriod {
  id: string;
  name_ar: string;
  start_date: string;
  end_date: string;
  status: PeriodStatus;
  closed_at: string | null;
  closed_by: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface JournalLine {
  id?: string;
  journal_entry_id?: string;
  line_order?: number;
  account_id: string;
  cost_center_id: string | null;
  debit: number;
  credit: number;
  description: string | null;
  account?: Pick<Account, 'id' | 'code' | 'name_ar' | 'account_type' | 'normal_balance'>;
  cost_center?: Pick<CostCenter, 'id' | 'code' | 'name_ar'> | null;
}

export interface JournalEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  period_id: string;
  description: string;
  reference_number: string | null;
  cost_center_id: string | null;
  status: JournalStatus;
  source_type: JournalSourceType;
  source_voucher_id: string | null;
  reversed_entry_id?: string | null;
  total_debit: number;
  total_credit: number;
  created_by: string;
  posted_by: string | null;
  created_at: string;
  updated_at: string;
  posted_at: string | null;
  creator?: { id: string; full_name: string } | null;
  poster?: { id: string; full_name: string } | null;
  period?: { id: string; name_ar: string; status: PeriodStatus } | null;
  cost_center?: Pick<CostCenter, 'id' | 'code' | 'name_ar'> | null;
  reversed_entry?: { id: string; entry_number: string; entry_date: string } | null;
  reversal_entry?: { id: string; entry_number: string; entry_date: string; status: JournalStatus } | null;
  source_voucher?: {
    id: string;
    voucher_number: string;
    voucher_type: VoucherType;
    voucher_date: string;
    party_name: string;
    amount: number;
    status: JournalStatus;
  } | null;
  lines?: JournalLine[];
}

export interface Voucher {
  id: string;
  voucher_type: VoucherType;
  voucher_number: string;
  voucher_date: string;
  period_id: string;
  payment_method: PaymentMethod;
  cash_bank_account_id: string;
  counter_account_id: string;
  party_name: string;
  amount: number;
  description: string;
  reference_number: string | null;
  cost_center_id: string | null;
  status: JournalStatus;
  journal_entry_id: string | null;
  created_by: string;
  posted_by: string | null;
  created_at: string;
  updated_at: string;
  posted_at: string | null;
  cash_bank_account?: Pick<Account, 'id' | 'code' | 'name_ar'>;
  counter_account?: Pick<Account, 'id' | 'code' | 'name_ar'>;
  cost_center?: Pick<CostCenter, 'id' | 'code' | 'name_ar'> | null;
  journal_entry?: { id: string; entry_number: string; status: JournalStatus } | null;
  creator?: { id: string; full_name: string } | null;
}

export interface LedgerTransactionRow {
  line_id: string;
  entry_id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  line_description: string | null;
  reference_number: string | null;
  cost_center_name: string | null;
  debit: number;
  credit: number;
  running_balance: number;
}

export interface AccountLedgerReport {
  account: Account;
  startDate: string;
  endDate: string;
  costCenterId: string | null;
  openingBalance: number;
  totalDebit: number;
  totalCredit: number;
  closingBalance: number;
  rows: LedgerTransactionRow[];
}

export interface TrialBalanceRow {
  account_id: string;
  code: string;
  name_ar: string;
  account_type: AccountType;
  normal_balance: NormalBalance;
  opening_debit: number;
  opening_credit: number;
  period_debit: number;
  period_credit: number;
  closing_debit: number;
  closing_credit: number;
}

export interface TrialBalanceReport {
  startDate: string;
  endDate: string;
  costCenterId: string | null;
  rows: TrialBalanceRow[];
  totals: {
    opening_debit: number;
    opening_credit: number;
    period_debit: number;
    period_credit: number;
    closing_debit: number;
    closing_credit: number;
  };
}

export interface CostCenterProfitabilityRow {
  cost_center_id: string;
  code: string;
  name_ar: string;
  parent_id: string | null;
  status: EntityStatus;
  direct_revenue: number;
  direct_expenses: number;
  direct_net_profit: number;
  total_revenue: number;
  total_expenses: number;
  total_net_profit: number;
}

export interface CostCenterProfitabilityReport {
  startDate: string;
  endDate: string;
  rows: CostCenterProfitabilityRow[];
  totals: {
    revenue: number;
    expenses: number;
    net_profit: number;
  };
}

export interface StatementAccountRow {
  account_id: string;
  code: string;
  name_ar: string;
  account_type: AccountType;
  balance: number;
}

export interface IncomeStatementReport {
  startDate: string;
  endDate: string;
  costCenterId: string | null;
  revenues: StatementAccountRow[];
  expenses: StatementAccountRow[];
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
}

export interface BalanceSheetReport {
  asOfDate: string;
  costCenterId: string | null;
  assets: StatementAccountRow[];
  liabilities: StatementAccountRow[];
  equity: StatementAccountRow[];
  currentPeriodNetProfit: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
  isBalanced: boolean;
}

export interface DashboardSummary {
  totalAccounts: number;
  activeAccounts: number;
  totalCostCenters: number;
  totalJournalEntries: number;
  draftJournalEntries: number;
  postedJournalEntries: number;
  totalDebitMovements: number;
  totalCreditMovements: number;
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  recentJournals: JournalEntry[];
  recentReceipts: Voucher[];
  recentPayments: Voucher[];
}
