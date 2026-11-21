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
  import_batch_id?: string | null;
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
  import_batch?: { id: string; batch_number: string; file_name: string } | null;
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

export type AccountImportMode = 'ADD_NEW' | 'UPDATE_EXISTING';

export type AccountImportFieldKey =
  | 'code'
  | 'name_ar'
  | 'parent_code'
  | 'parent_name'
  | 'level'
  | 'account_type'
  | 'normal_balance'
  | 'is_postable'
  | 'status'
  | 'cost_center_required';

export type AccountImportColumnMapping = Partial<Record<AccountImportFieldKey, number | null>>;

export type AccountImportClassification =
  | 'VALID'
  | 'INVALID'
  | 'EXISTING'
  | 'REQUIRES_REVIEW';

export interface AccountImportDetectedColumn {
  index: number;
  header: string;
  sampleValues: string[];
}

export interface AccountImportInspectResult {
  fileName: string;
  sheetNames: string[];
  selectedSheet: string;
  headerRowNumber: number;
  dataStartRowNumber: number;
  totalRawDataRows: number;
  columns: AccountImportDetectedColumn[];
  detectedMapping: AccountImportColumnMapping;
  parseWarnings: string[];
  blankRowsSkipped: number;
  mergedBannerRowsSkipped: number;
}

export interface AccountImportFieldDiff {
  field: string;
  label: string;
  oldValue: string;
  newValue: string;
}

export interface AccountImportNormalizedData {
  code: string;
  name_ar: string;
  parent_code: string | null;
  parent_name: string | null;
  resolved_parent_id: string | null;
  resolved_parent_code: string | null;
  resolved_parent_name: string | null;
  specified_level: number | null;
  computed_level: number | null;
  account_type: AccountType | null;
  normal_balance: NormalBalance | null;
  is_postable: boolean | null;
  status: EntityStatus | null;
  cost_center_required: boolean;
}

export interface AccountImportPreviewRow {
  excelRowNumber: number;
  raw: {
    code: string;
    name_ar: string;
    parent_code: string;
    parent_name: string;
    level: string;
    account_type: string;
    normal_balance: string;
    is_postable: string;
    status: string;
    cost_center_required: string;
  };
  normalized: AccountImportNormalizedData;
  classification: AccountImportClassification;
  action: 'INSERT' | 'UPDATE' | 'SKIP' | 'ERROR';
  existsInDb: boolean;
  existingAccountId: string | null;
  errors: string[];
  warnings: string[];
  changes: AccountImportFieldDiff[];
  executionOrder: number | null;
}

export interface AccountImportSummaryCounts {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  existingCount: number;
  reviewCount: number;
  insertableCount: number;
  updatableCount: number;
  unchangedExistingCount: number;
  skippableCount: number;
}

export interface AccountImportPreviewResult {
  fileName: string;
  sheetName: string;
  mode: AccountImportMode;
  createMissingInUpdateMode: boolean;
  parseWarnings: string[];
  blankRowsSkipped: number;
  mergedBannerRowsSkipped: number;
  summary: AccountImportSummaryCounts;
  rows: AccountImportPreviewRow[];
}

export type AccountImportOperationStatus = 'COMPLETED' | 'COMPLETED_WITH_SKIPS' | 'FAILED';

export interface AccountImportLogDetailItem {
  excelRowNumber: number;
  code: string;
  name_ar: string;
  classification: AccountImportClassification;
  outcome: 'IMPORTED' | 'UPDATED' | 'SKIPPED' | 'ERROR';
  messages: string[];
  changes?: AccountImportFieldDiff[];
}

export interface AccountImportLog {
  id: string;
  operation_number: string;
  file_name: string;
  sheet_name: string;
  import_mode: AccountImportMode;
  total_rows: number;
  imported_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  review_count: number;
  status: AccountImportOperationStatus;
  error_message: string | null;
  details: AccountImportLogDetailItem[];
  performed_by: string;
  performer?: { id: string; full_name: string; username: string } | null;
  created_at: string;
}

export interface AccountImportExecuteResult {
  log: AccountImportLog;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
}

export type PostingLevelInternalTarget = 'GROUP' | 'POSTING';

export type PostingLevelMatchSource = 'SAVED' | 'AUTO' | 'UNMATCHED';

export interface PostingLevelDiscoveredItem {
  rawValue: string;
  normalizedToken: string;
  count: number;
  rowNumbers: number[];
  matchSource: PostingLevelMatchSource;
  suggestedTarget: PostingLevelInternalTarget | null;
}

export interface PostingLevelDiscoveryResult {
  fileName: string;
  sheetName: string;
  totalRows: number;
  blankCount: number;
  blankRowNumbers: number[];
  items: PostingLevelDiscoveredItem[];
  matchedCount: number;
  unmatchedCount: number;
}

export type PostingLevelValueMappingMap = Record<string, PostingLevelInternalTarget>;

export interface SavedPostingLevelMapping {
  id: string;
  source_value: string;
  normalized_token: string;
  internal_target: PostingLevelInternalTarget;
  updated_by: string;
  updater?: { id: string; full_name: string } | null;
  created_at: string;
  updated_at: string;
}

export type AccountImportMappableFieldKey =
  | 'account_type'
  | 'normal_balance'
  | 'is_postable'
  | 'status'
  | 'cost_center_required';

export interface AccountImportFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface AccountImportFieldDefinition {
  fieldKey: AccountImportMappableFieldKey;
  fieldLabel: string;
  required: boolean;
  defaultWhenBlank: string | null;
  options: AccountImportFieldOption[];
}

export interface DiscoveredColumnValueItem {
  fieldKey: AccountImportMappableFieldKey;
  fieldLabel: string;
  columnHeader: string;
  rawValue: string;
  normalizedToken: string;
  count: number;
  rowNumbers: number[];
  matchSource: PostingLevelMatchSource;
  suggestedTarget: string | null;
}

export interface DiscoveredColumnGroup {
  fieldKey: AccountImportMappableFieldKey;
  fieldLabel: string;
  columnHeader: string;
  required: boolean;
  isMappedColumn: boolean;
  totalNonEmptyRows: number;
  blankCount: number;
  blankRowNumbers: number[];
  matchedCount: number;
  unmatchedCount: number;
  items: DiscoveredColumnValueItem[];
  options: AccountImportFieldOption[];
}

export interface UnifiedValueDiscoveryResult {
  fileName: string;
  sheetName: string;
  totalRows: number;
  columns: DiscoveredColumnGroup[];
  fieldDefinitions: AccountImportFieldDefinition[];
  totalUniqueValues: number;
  totalMatched: number;
  totalUnmatched: number;
}

export type UnifiedFieldValueMappings = Partial<
  Record<AccountImportMappableFieldKey, Record<string, string>>
>;

export interface SavedImportValueMapping {
  id: string;
  field_key: AccountImportMappableFieldKey;
  source_value: string;
  normalized_token: string;
  internal_target: string;
  updated_by: string;
  updater?: { id: string; full_name: string } | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// EXCEL JOURNAL IMPORT & HISTORY MANAGEMENT TYPES
// ============================================================================

export type JournalImportFieldKey =
  | 'entry_group'
  | 'entry_date'
  | 'description'
  | 'reference_number'
  | 'cost_center_code'
  | 'account_code'
  | 'debit'
  | 'credit'
  | 'line_description';

export type JournalImportColumnMapping = Partial<Record<JournalImportFieldKey, number | null>>;

export interface JournalImportInspectSheet {
  sheetName: string;
  headerRowNumber: number;
  dataStartRowNumber: number;
  totalRawDataRows: number;
  columns: AccountImportDetectedColumn[];
  detectedMapping: JournalImportColumnMapping;
  parseWarnings: string[];
}

export interface JournalImportInspectResult {
  fileName: string;
  sheetNames: string[];
  sheets: JournalImportInspectSheet[];
}

export interface JournalImportPreviewLine {
  excelRowNumber: number;
  accountCode: string;
  accountName: string | null;
  debit: number;
  credit: number;
  description: string | null;
}

export interface JournalImportPreviewEntry {
  groupKey: string;
  sheetName: string;
  excelRowNumbers: number[];
  entryDate: string;
  description: string;
  referenceNumber: string | null;
  costCenterCode: string | null;
  costCenterName: string | null;
  totalDebit: number;
  totalCredit: number;
  valid: boolean;
  errors: string[];
  lines: JournalImportPreviewLine[];
}

export interface JournalImportPreviewResult {
  fileName: string;
  sheetNames: string[];
  importedRows: number;
  detectedEntriesCount: number;
  validEntriesCount: number;
  rejectedEntriesCount: number;
  entries: JournalImportPreviewEntry[];
}

export type JournalImportBatchStatus = 'COMPLETED' | 'COMPLETED_WITH_SKIPS' | 'FAILED';

export type JournalImportDeletionMode = 'DELETE_BATCH_AND_ENTRIES' | 'DELETE_HISTORY_ONLY';

export interface JournalImportBatchDetailItem {
  groupKey: string;
  sheetName: string;
  excelRowNumbers: number[];
  outcome: 'CREATED' | 'REJECTED';
  entryNumber: string | null;
  entryDate: string;
  description: string;
  totalDebit: number;
  totalCredit: number;
  messages: string[];
}

export interface JournalImportBatch {
  id: string;
  batch_number: string;
  file_name: string;
  sheet_names: string[];
  imported_rows: number;
  detected_entries_count: number;
  drafts_created_count: number;
  rejected_entries_count: number;
  status: JournalImportBatchStatus;
  generated_entry_numbers: string[];
  error_message: string | null;
  details: JournalImportBatchDetailItem[];
  performed_by: string;
  performer?: { id: string; full_name: string; username: string } | null;
  created_at: string;
  live_total_entries?: number;
  live_draft_entries?: number;
  live_posted_entries?: number;
  live_blocked_entries?: number;
  can_delete_with_entries?: boolean;
  delete_block_reason?: string | null;
}

export interface JournalImportBatchLinkedEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  reference_number: string | null;
  status: JournalStatus;
  total_debit: number;
  total_credit: number;
  cost_center: Pick<CostCenter, 'id' | 'code' | 'name_ar'> | null;
  eligible_for_delete: boolean;
  block_reason: string | null;
}

export interface JournalImportBatchDetailsResponse {
  batch: JournalImportBatch;
  linkedEntries: JournalImportBatchLinkedEntry[];
}

export interface JournalImportExecuteResult {
  batch: JournalImportBatch;
  draftsCreatedCount: number;
  rejectedEntriesCount: number;
  generatedEntryNumbers: string[];
}

export interface JournalImportDeletionAuditLog {
  id: string;
  batch_id: string;
  batch_number: string;
  file_name: string;
  deletion_type: JournalImportDeletionMode;
  affected_entries_count: number;
  affected_entry_numbers: string[];
  admin_user_id: string;
  admin?: { id: string; full_name: string; username: string } | null;
  created_at: string;
}

// ============================================================================
// BULK JOURNAL POSTING TYPES
// ============================================================================

export type BulkJournalPostMode = 'SELECTED' | 'ALL_DRAFTS';

export type BulkJournalPostOutcome = 'POSTED' | 'FAILED' | 'SKIPPED';

export interface BulkJournalPostFilter {
  search?: string;
  startDate?: string;
  endDate?: string;
}

export interface BulkJournalPostPreviewEntry {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  total_debit: number;
  total_credit: number;
  status: JournalStatus;
}

export interface BulkJournalPostPreviewResponse {
  mode: BulkJournalPostMode;
  totalTargeted: number;
  eligibleDraftCount: number;
  alreadyPostedCount: number;
  entries: BulkJournalPostPreviewEntry[];
}

export interface BulkJournalPostItemResult {
  entry_id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  total_debit: number;
  outcome: BulkJournalPostOutcome;
  reason: string;
}

export interface BulkJournalPostSummary {
  auditLogId: string;
  operationNumber: string;
  mode: BulkJournalPostMode;
  totalSelected: number;
  postedCount: number;
  failedCount: number;
  skippedCount: number;
  results: BulkJournalPostItemResult[];
  createdAt: string;
}

export interface BulkJournalPostAuditLog {
  id: string;
  operation_number: string;
  mode: BulkJournalPostMode;
  total_targeted: number;
  posted_count: number;
  failed_count: number;
  skipped_count: number;
  filter_snapshot: BulkJournalPostFilter | null;
  results: BulkJournalPostItemResult[];
  admin_user_id: string;
  admin?: { id: string; full_name: string; username: string } | null;
  created_at: string;
}

