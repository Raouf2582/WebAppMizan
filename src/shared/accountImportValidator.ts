import type {
  Account,
  AccountImportClassification,
  AccountImportColumnMapping,
  AccountImportFieldDefinition,
  AccountImportFieldDiff,
  AccountImportMappableFieldKey,
  AccountImportMode,
  AccountImportPreviewResult,
  AccountImportPreviewRow,
  AccountType,
  DiscoveredColumnGroup,
  DiscoveredColumnValueItem,
  EntityStatus,
  NormalBalance,
  PostingLevelDiscoveredItem,
  PostingLevelDiscoveryResult,
  PostingLevelInternalTarget,
  PostingLevelValueMappingMap,
  UnifiedFieldValueMappings,
  UnifiedValueDiscoveryResult,
} from './types.ts';

export interface RawImportRowInput {
  excelRowNumber: number;
  cells: string[];
}

export interface AccountUsageInfo {
  hasJournalLines: boolean;
  hasVouchers: boolean;
  hasDraftUsage: boolean;
}

export interface SavedPostingMappingInput {
  normalized_token: string;
  internal_target: PostingLevelInternalTarget;
}

export interface SavedValueMappingInput {
  field_key: AccountImportMappableFieldKey;
  normalized_token: string;
  internal_target: string;
}

export interface ValidateAccountImportOptions {
  fileName: string;
  sheetName: string;
  rows: RawImportRowInput[];
  mapping: AccountImportColumnMapping;
  existingAccounts: Account[];
  accountUsageMap: Map<string, AccountUsageInfo>;
  mode: AccountImportMode;
  createMissingInUpdateMode?: boolean;
  postingValueMappings?: PostingLevelValueMappingMap;
  savedPostingMappings?: SavedPostingMappingInput[];
  fieldValueMappings?: UnifiedFieldValueMappings;
  savedValueMappings?: SavedValueMappingInput[];
  parseWarnings?: string[];
  blankRowsSkipped?: number;
  mergedBannerRowsSkipped?: number;
}

function normalizeArabicDigits(str: string): string {
  return str
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function normalizeTextToken(str: string): string {
  return normalizeArabicDigits(str)
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const MAPPABLE_FIELD_ORDER: AccountImportMappableFieldKey[] = [
  'account_type',
  'normal_balance',
  'is_postable',
  'status',
  'cost_center_required',
];

export const CANONICAL_IMPORT_FIELD_DEFINITIONS: AccountImportFieldDefinition[] = [
  {
    fieldKey: 'account_type',
    fieldLabel: 'نوع الحساب (النوع المحاسبي)',
    required: true,
    defaultWhenBlank: null,
    options: [
      { value: 'ASSET', label: 'الأصول (ASSET)' },
      { value: 'LIABILITY', label: 'الالتزامات / الخصوم (LIABILITY)' },
      { value: 'EQUITY', label: 'حقوق الملكية (EQUITY)' },
      { value: 'REVENUE', label: 'الإيرادات (REVENUE)' },
      { value: 'EXPENSE', label: 'المصروفات (EXPENSE)' },
    ],
  },
  {
    fieldKey: 'normal_balance',
    fieldLabel: 'طبيعة الحساب (مدين / دائن)',
    required: true,
    defaultWhenBlank: null,
    options: [
      { value: 'DEBIT', label: 'مدين (DEBIT)' },
      { value: 'CREDIT', label: 'دائن (CREDIT)' },
    ],
  },
  {
    fieldKey: 'is_postable',
    fieldLabel: 'مستوى الترحيل',
    required: true,
    defaultWhenBlank: null,
    options: [
      { value: 'GROUP', label: 'حساب تجميعي (GROUP) — لا يقبل القيود مباشرة' },
      { value: 'POSTING', label: 'حساب قابل للترحيل (POSTING) — يقبل القيود' },
    ],
  },
  {
    fieldKey: 'status',
    fieldLabel: 'الحالة',
    required: false,
    defaultWhenBlank: 'ACTIVE',
    options: [
      { value: 'ACTIVE', label: 'نشط (ACTIVE)' },
      { value: 'INACTIVE', label: 'غير نشط (INACTIVE)' },
    ],
  },
  {
    fieldKey: 'cost_center_required',
    fieldLabel: 'إلزامية مركز التكلفة',
    required: false,
    defaultWhenBlank: 'OPTIONAL',
    options: [
      { value: 'OPTIONAL', label: 'اختياري (OPTIONAL)' },
      { value: 'REQUIRED', label: 'إلزامي (REQUIRED)' },
    ],
  },
];

export function isValidTargetForField(
  fieldKey: AccountImportMappableFieldKey,
  target: string,
): boolean {
  const def = CANONICAL_IMPORT_FIELD_DEFINITIONS.find((d) => d.fieldKey === fieldKey);
  return def ? def.options.some((o) => o.value === target) : false;
}

export function normalizeAccountTypeValue(raw: string): AccountType | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Compound slash/ampersand labels (e.g. "الخصوم / الالتزامات", "أصول / خصوم") require explicit confirmation
  if (/[/\\&+]/.test(trimmed)) return null;

  const t = normalizeTextToken(trimmed);
  if (!t) return null;

  if (
    ['asset', 'assets', 'اصل', 'اصول', 'الاصول', 'موجودات', 'الموجودات', 'حساب اصول', 'حسابات الاصول'].includes(t)
  ) {
    return 'ASSET';
  }
  if (
    [
      'liability',
      'liabilities',
      'التزام',
      'التزامات',
      'الالتزامات',
      'خصوم',
      'الخصوم',
      'مطلوبات',
      'المطلوبات',
    ].includes(t)
  ) {
    return 'LIABILITY';
  }
  if (
    [
      'equity',
      'owners equity',
      'owner equity',
      'shareholders equity',
      'capital',
      'حقوق ملكيه',
      'حقوق الملكيه',
      'حقوق المساهمين',
      'حقوق الملاك',
      'ملكيه',
      'راس المال',
    ].includes(t)
  ) {
    return 'EQUITY';
  }
  if (
    ['revenue', 'revenues', 'income', 'sales', 'ايراد', 'ايرادات', 'الايرادات', 'مبيعات', 'المبيعات', 'دخل'].includes(t)
  ) {
    return 'REVENUE';
  }
  if (
    [
      'expense',
      'expenses',
      'cost',
      'costs',
      'مصروف',
      'مصروفات',
      'المصروفات',
      'مصاريف',
      'المصاريف',
      'تكاليف',
      'التكاليف',
      'تكلفه',
    ].includes(t)
  ) {
    return 'EXPENSE';
  }
  return null;
}

export function normalizeNormalBalanceValue(raw: string): NormalBalance | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[/\\&+]/.test(trimmed)) return null;

  const t = normalizeTextToken(trimmed);
  if (!t) return null;
  if (['debit', 'dr', 'd', 'مدين', 'طبيعه مدينه', 'رصيد مدين', 'حساب مدين'].includes(t)) {
    return 'DEBIT';
  }
  if (['credit', 'cr', 'c', 'دائن', 'طبيعه دائنه', 'رصيد دائن', 'حساب دائن'].includes(t)) {
    return 'CREDIT';
  }
  return null;
}

export function normalizePostingToken(str: string): string {
  return normalizeArabicDigits(str)
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[()[\]{}_\-/:\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeFieldValueToken(str: string): string {
  return normalizePostingToken(str);
}

const POSTING_EXACT_POSTING = new Set([
  'posting',
  'postable',
  'allow posting',
  'detail',
  'details',
  'leaf',
  'child',
  'sub',
  'sub account',
  'operational',
  'transactional',
  'true',
  '1',
  'yes',
  'فرعي',
  'حساب فرعي',
  'تفصيلي',
  'حساب تفصيلي',
  'قابل للترحيل',
  'حساب قابل للترحيل',
  'يقبل الترحيل',
  'يقبل القيود',
  'فرعي قابل للترحيل',
  'حساب فرعي قابل للترحيل',
  'تشغيلي',
  'نعم',
]);

const POSTING_EXACT_GROUP = new Set([
  'group',
  'header',
  'parent',
  'summary',
  'title',
  'folder',
  'non postable',
  'nonpostable',
  'not postable',
  'false',
  '0',
  'no',
  'رئيسي',
  'حساب رئيسي',
  'تجميعي',
  'حساب تجميعي',
  'حساب رئيسي تجميعي',
  'رئيسي تجميعي',
  'تجميعي رئيسي',
  'غير قابل للترحيل',
  'حساب غير قابل للترحيل',
  'لا يقبل الترحيل',
  'لا يقبل القيود',
  'رئيسي غير قابل للترحيل',
  'حساب رئيسي غير قابل للترحيل',
  'عنوان',
  'مجموعه',
  'لا',
]);

export function autoMatchPostingLevelValue(raw: string): PostingLevelInternalTarget | null {
  const t = normalizePostingToken(raw);
  if (!t) return null;

  if (POSTING_EXACT_GROUP.has(t)) return 'GROUP';
  if (POSTING_EXACT_POSTING.has(t)) return 'POSTING';

  // Rule-based matching only when unambiguous and non-conflicting
  const hasNegation =
    /\b(non|not|no)\b/.test(t) || t.includes('غير ') || t.includes('لا يقبل') || t.includes('بدون ترحيل');
  const hasGroupCue =
    t.includes('تجميعي') ||
    t.includes('رئيسي') ||
    t.includes('غير قابل للترحيل') ||
    t.includes('لا يقبل الترحيل') ||
    /\b(group|header|summary)\b/.test(t);
  const hasPostingCue =
    t.includes('قابل للترحيل') ||
    t.includes('يقبل الترحيل') ||
    t.includes('يقبل القيود') ||
    t.includes('تفصيلي') ||
    t.includes('فرعي') ||
    /\b(postable|posting|leaf|detail)\b/.test(t);

  // Conflicting cues (e.g. "رئيسي/فرعي") must go to manual review rather than guessing
  if (hasGroupCue && (t.includes('فرعي') || t.includes('تفصيلي') || /\b(leaf|detail)\b/.test(t))) {
    return null;
  }

  if (hasGroupCue && (!hasPostingCue || hasNegation)) {
    return 'GROUP';
  }
  if (hasPostingCue && !hasGroupCue && !hasNegation) {
    return 'POSTING';
  }

  return null;
}

export function normalizeIsPostableValue(raw: string): boolean | null {
  const matched = autoMatchPostingLevelValue(raw);
  if (matched === 'POSTING') return true;
  if (matched === 'GROUP') return false;
  return null;
}

export function discoverPostingLevelValues(options: {
  fileName: string;
  sheetName: string;
  rows: RawImportRowInput[];
  postingColumnIndex: number | null | undefined;
  savedMappings?: SavedPostingMappingInput[];
}): PostingLevelDiscoveryResult {
  const { fileName, sheetName, rows, postingColumnIndex, savedMappings = [] } = options;

  const savedByToken = new Map<string, PostingLevelInternalTarget>(
    savedMappings.map((m) => [normalizePostingToken(m.normalized_token), m.internal_target]),
  );

  const blankRowNumbers: number[] = [];
  const buckets = new Map<
    string,
    { rawValue: string; normalizedToken: string; count: number; rowNumbers: number[] }
  >();

  for (const row of rows) {
    const val =
      postingColumnIndex !== null &&
      postingColumnIndex !== undefined &&
      postingColumnIndex >= 0 &&
      postingColumnIndex < row.cells.length
        ? (row.cells[postingColumnIndex] ?? '').trim()
        : '';

    if (!val) {
      blankRowNumbers.push(row.excelRowNumber);
      continue;
    }

    const existing = buckets.get(val);
    if (existing) {
      existing.count += 1;
      existing.rowNumbers.push(row.excelRowNumber);
    } else {
      buckets.set(val, {
        rawValue: val,
        normalizedToken: normalizePostingToken(val),
        count: 1,
        rowNumbers: [row.excelRowNumber],
      });
    }
  }

  const items: PostingLevelDiscoveredItem[] = [];
  for (const bucket of buckets.values()) {
    const savedTarget = bucket.normalizedToken
      ? savedByToken.get(bucket.normalizedToken) ?? null
      : null;

    if (savedTarget) {
      items.push({
        ...bucket,
        matchSource: 'SAVED',
        suggestedTarget: savedTarget,
      });
      continue;
    }

    const autoTarget = autoMatchPostingLevelValue(bucket.rawValue);
    if (autoTarget) {
      items.push({
        ...bucket,
        matchSource: 'AUTO',
        suggestedTarget: autoTarget,
      });
      continue;
    }

    items.push({
      ...bucket,
      matchSource: 'UNMATCHED',
      suggestedTarget: null,
    });
  }

  // Sort UNMATCHED first so user attention goes straight to unresolved values, then SAVED, then AUTO
  const sourceRank = { UNMATCHED: 0, SAVED: 1, AUTO: 2 };
  items.sort((a, b) => {
    const r = sourceRank[a.matchSource] - sourceRank[b.matchSource];
    if (r !== 0) return r;
    if (b.count !== a.count) return b.count - a.count;
    return a.rawValue.localeCompare(b.rawValue);
  });

  const matchedCount = items.filter((i) => i.suggestedTarget !== null).length;
  const unmatchedCount = items.length - matchedCount;

  return {
    fileName,
    sheetName,
    totalRows: rows.length,
    blankCount: blankRowNumbers.length,
    blankRowNumbers,
    items,
    matchedCount,
    unmatchedCount,
  };
}

export function normalizeStatusValue(raw: string): EntityStatus | null {
  const trimmed = raw.trim();
  if (!trimmed || /[/\\&+]/.test(trimmed)) return null;
  const t = normalizeTextToken(trimmed);
  if (!t) return null;
  if (['active', 'enabled', '1', 'true', 'yes', 'نشط', 'فعال', 'مفعل', 'ساري'].includes(t)) {
    return 'ACTIVE';
  }
  if (
    ['inactive', 'disabled', '0', 'false', 'no', 'غير نشط', 'معطل', 'موقوف', 'غير فعال', 'مغلق'].includes(t)
  ) {
    return 'INACTIVE';
  }
  return null;
}

function normalizeBooleanOptional(raw: string): boolean | null {
  const trimmed = raw.trim();
  if (!trimmed || /[/\\&+]/.test(trimmed)) return null;
  const t = normalizeTextToken(trimmed);
  if (!t) return null;
  if (['true', 'yes', '1', 'required', 'mandatory', 'نعم', 'الزامي', 'مطلوب', 'اجباري'].includes(t)) {
    return true;
  }
  if (['false', 'no', '0', 'optional', 'not required', 'لا', 'اختياري', 'غير الزامي', 'غير مطلوب'].includes(t)) {
    return false;
  }
  return null;
}

export function autoMatchFieldValue(
  fieldKey: AccountImportMappableFieldKey,
  raw: string,
): string | null {
  if (fieldKey === 'account_type') return normalizeAccountTypeValue(raw);
  if (fieldKey === 'normal_balance') return normalizeNormalBalanceValue(raw);
  if (fieldKey === 'is_postable') return autoMatchPostingLevelValue(raw);
  if (fieldKey === 'status') return normalizeStatusValue(raw);
  if (fieldKey === 'cost_center_required') {
    const b = normalizeBooleanOptional(raw);
    if (b === true) return 'REQUIRED';
    if (b === false) return 'OPTIONAL';
    return null;
  }
  return null;
}

export function discoverUnifiedImportValues(options: {
  fileName: string;
  sheetName: string;
  rows: RawImportRowInput[];
  columnHeaders?: Record<number, string>;
  mapping: AccountImportColumnMapping;
  fieldDefinitions?: AccountImportFieldDefinition[];
  savedMappings?: SavedValueMappingInput[];
}): UnifiedValueDiscoveryResult {
  const {
    fileName,
    sheetName,
    rows,
    columnHeaders = {},
    mapping,
    fieldDefinitions = CANONICAL_IMPORT_FIELD_DEFINITIONS,
    savedMappings = [],
  } = options;

  const defByField = new Map<AccountImportMappableFieldKey, AccountImportFieldDefinition>(
    fieldDefinitions.map((d) => [d.fieldKey, d]),
  );

  // Strictly scope saved mappings per field_key
  const savedByFieldAndToken = new Map<
    AccountImportMappableFieldKey,
    Map<string, string>
  >();
  for (const m of savedMappings) {
    if (!isValidTargetForField(m.field_key, m.internal_target)) continue;
    let fieldMap = savedByFieldAndToken.get(m.field_key);
    if (!fieldMap) {
      fieldMap = new Map<string, string>();
      savedByFieldAndToken.set(m.field_key, fieldMap);
    }
    fieldMap.set(normalizeFieldValueToken(m.normalized_token), m.internal_target);
  }

  const columns: DiscoveredColumnGroup[] = [];
  let totalUniqueValues = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;

  for (const fieldKey of MAPPABLE_FIELD_ORDER) {
    const def = defByField.get(fieldKey);
    if (!def) continue;

    const colIdx = mapping[fieldKey];
    const isMappedColumn = colIdx !== null && colIdx !== undefined && colIdx >= 0;
    const columnHeader = isMappedColumn ? columnHeaders[colIdx] || def.fieldLabel : '';

    if (!isMappedColumn) {
      continue;
    }

    const blankRowNumbers: number[] = [];
    const buckets = new Map<
      string,
      { rawValue: string; normalizedToken: string; count: number; rowNumbers: number[] }
    >();

    for (const row of rows) {
      const val = colIdx < row.cells.length ? (row.cells[colIdx] ?? '').trim() : '';
      if (!val) {
        blankRowNumbers.push(row.excelRowNumber);
        continue;
      }

      const existing = buckets.get(val);
      if (existing) {
        existing.count += 1;
        existing.rowNumbers.push(row.excelRowNumber);
      } else {
        buckets.set(val, {
          rawValue: val,
          normalizedToken: normalizeFieldValueToken(val),
          count: 1,
          rowNumbers: [row.excelRowNumber],
        });
      }
    }

    const fieldSavedMap = savedByFieldAndToken.get(fieldKey);
    const items: DiscoveredColumnValueItem[] = [];

    for (const bucket of buckets.values()) {
      const savedTarget =
        bucket.normalizedToken && fieldSavedMap
          ? fieldSavedMap.get(bucket.normalizedToken) ?? null
          : null;

      if (savedTarget && isValidTargetForField(fieldKey, savedTarget)) {
        items.push({
          fieldKey,
          fieldLabel: def.fieldLabel,
          columnHeader,
          ...bucket,
          matchSource: 'SAVED',
          suggestedTarget: savedTarget,
        });
        continue;
      }

      const autoTarget = autoMatchFieldValue(fieldKey, bucket.rawValue);
      if (autoTarget && isValidTargetForField(fieldKey, autoTarget)) {
        items.push({
          fieldKey,
          fieldLabel: def.fieldLabel,
          columnHeader,
          ...bucket,
          matchSource: 'AUTO',
          suggestedTarget: autoTarget,
        });
        continue;
      }

      items.push({
        fieldKey,
        fieldLabel: def.fieldLabel,
        columnHeader,
        ...bucket,
        matchSource: 'UNMATCHED',
        suggestedTarget: null,
      });
    }

    const sourceRank = { UNMATCHED: 0, SAVED: 1, AUTO: 2 };
    items.sort((a, b) => {
      const r = sourceRank[a.matchSource] - sourceRank[b.matchSource];
      if (r !== 0) return r;
      if (b.count !== a.count) return b.count - a.count;
      return a.rawValue.localeCompare(b.rawValue);
    });

    const matchedCount = items.filter((i) => i.suggestedTarget !== null).length;
    const unmatchedCount = items.length - matchedCount;

    totalUniqueValues += items.length;
    totalMatched += matchedCount;
    totalUnmatched += unmatchedCount;

    columns.push({
      fieldKey,
      fieldLabel: def.fieldLabel,
      columnHeader,
      required: def.required,
      isMappedColumn,
      totalNonEmptyRows: rows.length - blankRowNumbers.length,
      blankCount: blankRowNumbers.length,
      blankRowNumbers,
      matchedCount,
      unmatchedCount,
      items,
      options: def.options,
    });
  }

  return {
    fileName,
    sheetName,
    totalRows: rows.length,
    columns,
    fieldDefinitions,
    totalUniqueValues,
    totalMatched,
    totalUnmatched,
  };
}

function parseLevelValue(raw: string): { value: number | null; invalid: boolean } {
  const cleaned = normalizeArabicDigits(raw)
    .replace(/^(?:level|lvl|المستوى|مستوى)\s*[:\-]?\s*/i, '')
    .trim();
  if (!cleaned) return { value: null, invalid: false };
  if (!/^\d+$/.test(cleaned)) {
    return { value: null, invalid: true };
  }
  const num = Number(cleaned);
  if (!Number.isInteger(num) || num < 1 || num > 30) {
    return { value: null, invalid: true };
  }
  return { value: num, invalid: false };
}

const ACCOUNT_TYPE_AR: Record<AccountType, string> = {
  ASSET: 'الأصول',
  LIABILITY: 'الالتزامات',
  EQUITY: 'حقوق الملكية',
  REVENUE: 'الإيرادات',
  EXPENSE: 'المصروفات',
};

const NORMAL_BALANCE_AR: Record<NormalBalance, string> = {
  DEBIT: 'مدين',
  CREDIT: 'دائن',
};

const EXPECTED_BALANCE_BY_TYPE: Record<AccountType, NormalBalance> = {
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  REVENUE: 'CREDIT',
};

function getCell(cells: string[], colIdx: number | null | undefined): string {
  if (colIdx === null || colIdx === undefined || colIdx < 0 || colIdx >= cells.length) {
    return '';
  }
  return (cells[colIdx] ?? '').trim();
}

export function validateAndPlanAccountImport(
  options: ValidateAccountImportOptions,
): AccountImportPreviewResult {
  const {
    fileName,
    sheetName,
    rows,
    mapping,
    existingAccounts,
    accountUsageMap,
    mode,
    createMissingInUpdateMode = false,
    postingValueMappings,
    savedPostingMappings = [],
    fieldValueMappings,
    savedValueMappings = [],
    parseWarnings = [],
    blankRowsSkipped = 0,
    mergedBannerRowsSkipped = 0,
  } = options;

  // Build strictly field-scoped saved lookups
  const savedByField = new Map<AccountImportMappableFieldKey, Map<string, string>>();
  for (const m of savedValueMappings) {
    if (!isValidTargetForField(m.field_key, m.internal_target)) continue;
    let map = savedByField.get(m.field_key);
    if (!map) {
      map = new Map<string, string>();
      savedByField.set(m.field_key, map);
    }
    map.set(normalizeFieldValueToken(m.normalized_token), m.internal_target);
  }
  for (const m of savedPostingMappings) {
    let map = savedByField.get('is_postable');
    if (!map) {
      map = new Map<string, string>();
      savedByField.set('is_postable', map);
    }
    const tok = normalizeFieldValueToken(m.normalized_token);
    if (!map.has(tok)) map.set(tok, m.internal_target);
  }

  // Build strictly field-scoped explicit user-confirmed lookups
  const explicitByField = new Map<AccountImportMappableFieldKey, Map<string, string>>();
  const hasExplicitFieldMap = new Set<AccountImportMappableFieldKey>();

  if (fieldValueMappings) {
    for (const fieldKey of MAPPABLE_FIELD_ORDER) {
      const record = fieldValueMappings[fieldKey];
      if (!record) continue;
      hasExplicitFieldMap.add(fieldKey);
      const map = new Map<string, string>();
      for (const [k, v] of Object.entries(record)) {
        if (!isValidTargetForField(fieldKey, v)) continue;
        const trimmed = k.trim();
        if (trimmed) map.set(trimmed, v);
        const tok = normalizeFieldValueToken(k);
        if (tok && !map.has(tok)) map.set(tok, v);
      }
      explicitByField.set(fieldKey, map);
    }
  }

  if (postingValueMappings && !hasExplicitFieldMap.has('is_postable')) {
    hasExplicitFieldMap.add('is_postable');
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(postingValueMappings)) {
      if (!isValidTargetForField('is_postable', v)) continue;
      const trimmed = k.trim();
      if (trimmed) map.set(trimmed, v);
      const tok = normalizeFieldValueToken(k);
      if (tok && !map.has(tok)) map.set(tok, v);
    }
    explicitByField.set('is_postable', map);
  }

  function resolveFieldValue(
    fieldKey: AccountImportMappableFieldKey,
    rawVal: string,
  ): string | null {
    const trimmed = rawVal.trim();
    if (!trimmed) return null;
    const token = normalizeFieldValueToken(trimmed);

    if (hasExplicitFieldMap.has(fieldKey)) {
      const exp = explicitByField.get(fieldKey);
      const explicitTarget = exp?.get(trimmed) ?? (token ? exp?.get(token) : undefined) ?? null;
      if (explicitTarget && isValidTargetForField(fieldKey, explicitTarget)) {
        return explicitTarget;
      }
      const savedTarget = token ? savedByField.get(fieldKey)?.get(token) ?? null : null;
      if (savedTarget && isValidTargetForField(fieldKey, savedTarget)) {
        return savedTarget;
      }
      return autoMatchFieldValue(fieldKey, trimmed);
    }

    const savedTarget = token ? savedByField.get(fieldKey)?.get(token) ?? null : null;
    if (savedTarget && isValidTargetForField(fieldKey, savedTarget)) {
      return savedTarget;
    }

    return autoMatchFieldValue(fieldKey, trimmed);
  }

  const existingById = new Map<string, Account>(existingAccounts.map((a) => [a.id, a]));
  const existingByCode = new Map<string, Account>(
    existingAccounts.map((a) => [a.code.trim(), a]),
  );
  const existingByCodeLower = new Map<string, Account>(
    existingAccounts.map((a) => [a.code.trim().toLowerCase(), a]),
  );

  // Build normalized name lookup for DB accounts (for parent_name fallback resolution)
  const dbByNormalizedName = new Map<string, Account[]>();
  for (const acc of existingAccounts) {
    const k = normalizeTextToken(acc.name_ar);
    const list = dbByNormalizedName.get(k) ?? [];
    list.push(acc);
    dbByNormalizedName.set(k, list);
  }

  // Pass 1: Extract raw fields, normalize scalars, count code duplicates
  interface WorkingRow {
    excelRowNumber: number;
    raw: AccountImportPreviewRow['raw'];
    code: string;
    name_ar: string;
    parent_code: string | null;
    parent_name: string | null;
    specified_level: number | null;
    account_type: AccountType | null;
    normal_balance: NormalBalance | null;
    is_postable: boolean | null;
    status: EntityStatus | null;
    cost_center_required: boolean;
    existsInDb: boolean;
    existingAccount: Account | null;
    errors: string[];
    warnings: string[];
    resolvedParentKind: 'NONE' | 'DB' | 'FILE';
    resolvedParentCode: string | null;
    resolvedParentName: string | null;
    resolvedParentId: string | null;
    computed_level: number | null;
    changes: AccountImportFieldDiff[];
    classification: AccountImportClassification;
    action: AccountImportPreviewRow['action'];
    executionOrder: number | null;
  }

  const workingRows: WorkingRow[] = [];
  const codeOccurrences = new Map<string, number[]>();

  for (const row of rows) {
    const raw = {
      code: getCell(row.cells, mapping.code),
      name_ar: getCell(row.cells, mapping.name_ar),
      parent_code: getCell(row.cells, mapping.parent_code),
      parent_name: getCell(row.cells, mapping.parent_name),
      level: getCell(row.cells, mapping.level),
      account_type: getCell(row.cells, mapping.account_type),
      normal_balance: getCell(row.cells, mapping.normal_balance),
      is_postable: getCell(row.cells, mapping.is_postable),
      status: getCell(row.cells, mapping.status),
      cost_center_required: getCell(row.cells, mapping.cost_center_required),
    };

    const errors: string[] = [];
    const warnings: string[] = [];

    const code = raw.code.trim();
    const name_ar = raw.name_ar.trim();
    const parent_code = raw.parent_code.trim() || null;
    const parent_name = raw.parent_name.trim() || null;

    if (!code) {
      errors.push('رمز الحساب مطلوب ولا يمكن أن يكون فارغاً.');
    } else if (code.length > 30) {
      errors.push('رمز الحساب يتجاوز الحد الأقصى المسموح به (30 حرفاً).');
    }

    if (!name_ar) {
      errors.push('اسم الحساب مطلوب ولا يمكن أن يكون فارغاً.');
    } else if (name_ar.length < 2) {
      errors.push('اسم الحساب يجب أن يكون حرفين على الأقل.');
    } else if (name_ar.length > 150) {
      errors.push('اسم الحساب يتجاوز الحد الأقصى المسموح به (150 حرفاً).');
    }

    const levelParsed = parseLevelValue(raw.level);
    if (levelParsed.invalid) {
      errors.push(`قيمة المستوى "${raw.level}" غير صالحة؛ يجب أن تكون رقماً صحيحاً موجباً.`);
    }

    let account_type: AccountType | null = null;
    if (!raw.account_type) {
      errors.push('نوع الحساب (الأصول/الالتزامات/حقوق الملكية/الإيرادات/المصروفات) مطلوب.');
    } else {
      const resolvedType = resolveFieldValue('account_type', raw.account_type);
      if (resolvedType && isValidTargetForField('account_type', resolvedType)) {
        account_type = resolvedType as AccountType;
      } else {
        errors.push(`نوع الحساب "${raw.account_type}" غير معترف به ويحتاج إلى مطابقة يدوية.`);
      }
    }

    let normal_balance: NormalBalance | null = null;
    if (!raw.normal_balance) {
      errors.push('طبيعة الحساب (مدين / دائن) مطلوبة.');
    } else {
      const resolvedNature = resolveFieldValue('normal_balance', raw.normal_balance);
      if (resolvedNature && isValidTargetForField('normal_balance', resolvedNature)) {
        normal_balance = resolvedNature as NormalBalance;
      } else {
        errors.push(`طبيعة الحساب "${raw.normal_balance}" غير صالحة؛ تحتاج إلى مطابقة مع مدين أو دائن.`);
      }
    }

    let is_postable: boolean | null = null;
    if (!raw.is_postable) {
      errors.push('مستوى الترحيل (حساب تجميعي GROUP / قابل للترحيل POSTING) مطلوب.');
    } else {
      const resolvedPosting = resolveFieldValue('is_postable', raw.is_postable);
      if (resolvedPosting === 'POSTING') {
        is_postable = true;
      } else if (resolvedPosting === 'GROUP') {
        is_postable = false;
      } else {
        errors.push(`قيمة مستوى الترحيل "${raw.is_postable}" غير معروفة وتحتاج إلى مطابقة يدوية.`);
      }
    }

    let status: EntityStatus | null = 'ACTIVE';
    if (raw.status) {
      const resolvedStatus = resolveFieldValue('status', raw.status);
      if (resolvedStatus === 'ACTIVE' || resolvedStatus === 'INACTIVE') {
        status = resolvedStatus;
      } else {
        status = null;
        errors.push(`حالة الحساب "${raw.status}" غير صالحة؛ تحتاج إلى مطابقة مع نشط أو غير نشط.`);
      }
    }

    let cost_center_required = false;
    if (raw.cost_center_required) {
      const resolvedCc = resolveFieldValue('cost_center_required', raw.cost_center_required);
      if (resolvedCc !== 'REQUIRED' && resolvedCc !== 'OPTIONAL') {
        errors.push(`قيمة إلزامية مركز التكلفة "${raw.cost_center_required}" غير صالحة وتحتاج إلى مطابقة.`);
      } else if (is_postable === false && resolvedCc === 'REQUIRED') {
        cost_center_required = false;
        warnings.push('تم ضبط إلزامية مركز التكلفة إلى "اختياري" لأن الحساب رئيسي غير قابل للترحيل.');
      } else {
        cost_center_required = resolvedCc === 'REQUIRED';
      }
    }

    if (account_type && normal_balance && EXPECTED_BALANCE_BY_TYPE[account_type] !== normal_balance) {
      warnings.push(
        `الطبيعة المحاسبية (${NORMAL_BALANCE_AR[normal_balance]}) تختلف عن الطبيعة القياسية لنوع "${ACCOUNT_TYPE_AR[account_type]}"؛ يرجى المراجعة للتأكد مما إذا كان حساباً مقابلاً.`,
      );
    }

    const exactDbMatch = code ? existingByCode.get(code) ?? null : null;
    if (!exactDbMatch && code) {
      const ciMatch = existingByCodeLower.get(code.toLowerCase());
      if (ciMatch) {
        warnings.push(
          `يوجد حساب في قاعدة البيانات برمز مشابه يختلف في حالة الأحرف (${ciMatch.code}).`,
        );
      }
    }

    if (code) {
      const occ = codeOccurrences.get(code) ?? [];
      occ.push(row.excelRowNumber);
      codeOccurrences.set(code, occ);
    }

    workingRows.push({
      excelRowNumber: row.excelRowNumber,
      raw,
      code,
      name_ar,
      parent_code,
      parent_name,
      specified_level: levelParsed.value,
      account_type,
      normal_balance,
      is_postable,
      status,
      cost_center_required,
      existsInDb: Boolean(exactDbMatch),
      existingAccount: exactDbMatch,
      errors,
      warnings,
      resolvedParentKind: 'NONE',
      resolvedParentCode: null,
      resolvedParentName: null,
      resolvedParentId: null,
      computed_level: null,
      changes: [],
      classification: 'VALID',
      action: 'INSERT',
      executionOrder: null,
    });
  }

  // Pass 2: Mark duplicate codes within uploaded file
  const uniqueFileRowByCode = new Map<string, WorkingRow>();
  const fileByNormalizedName = new Map<string, WorkingRow[]>();

  for (const w of workingRows) {
    if (!w.code) continue;
    const occ = codeOccurrences.get(w.code) ?? [];
    if (occ.length > 1) {
      w.errors.push(
        `رمز الحساب "${w.code}" مكرر داخل ملف Excel في الصفوف: ${occ.join('، ')}.`,
      );
    } else {
      uniqueFileRowByCode.set(w.code, w);
      if (w.name_ar) {
        const nk = normalizeTextToken(w.name_ar);
        const list = fileByNormalizedName.get(nk) ?? [];
        list.push(w);
        fileByNormalizedName.set(nk, list);
      }
    }
  }

  // Helper returning effective attributes of an account code in the post-import state
  interface EffectiveNode {
    code: string;
    name_ar: string;
    account_type: AccountType | null;
    normal_balance: NormalBalance | null;
    is_postable: boolean | null;
    status: EntityStatus | null;
    parentCode: string | null;
    source: 'DB' | 'FILE';
    dbAccount: Account | null;
    fileRow: WorkingRow | null;
  }

  function getEffectiveNode(code: string): EffectiveNode | null {
    const dbAcc = existingByCode.get(code) ?? null;
    const fileRow = uniqueFileRowByCode.get(code) ?? null;

    if (mode === 'ADD_NEW') {
      if (dbAcc) {
        const parentDb = dbAcc.parent_id ? existingById.get(dbAcc.parent_id) ?? null : null;
        return {
          code: dbAcc.code,
          name_ar: dbAcc.name_ar,
          account_type: dbAcc.account_type,
          normal_balance: dbAcc.normal_balance,
          is_postable: dbAcc.is_postable,
          status: dbAcc.status,
          parentCode: parentDb?.code ?? null,
          source: 'DB',
          dbAccount: dbAcc,
          fileRow: null,
        };
      }
      if (fileRow) {
        return {
          code: fileRow.code,
          name_ar: fileRow.name_ar,
          account_type: fileRow.account_type,
          normal_balance: fileRow.normal_balance,
          is_postable: fileRow.is_postable,
          status: fileRow.status,
          parentCode: fileRow.resolvedParentCode,
          source: 'FILE',
          dbAccount: null,
          fileRow,
        };
      }
      return null;
    }

    // UPDATE_EXISTING mode: file row overrides DB account if present and valid for update
    if (fileRow) {
      if (dbAcc || createMissingInUpdateMode) {
        return {
          code: fileRow.code,
          name_ar: fileRow.name_ar || dbAcc?.name_ar || '',
          account_type: fileRow.account_type ?? dbAcc?.account_type ?? null,
          normal_balance: fileRow.normal_balance ?? dbAcc?.normal_balance ?? null,
          is_postable: fileRow.is_postable ?? dbAcc?.is_postable ?? null,
          status: fileRow.status ?? dbAcc?.status ?? null,
          parentCode: fileRow.resolvedParentCode,
          source: 'FILE',
          dbAccount: dbAcc,
          fileRow,
        };
      }
    }

    if (dbAcc) {
      const parentDb = dbAcc.parent_id ? existingById.get(dbAcc.parent_id) ?? null : null;
      return {
        code: dbAcc.code,
        name_ar: dbAcc.name_ar,
        account_type: dbAcc.account_type,
        normal_balance: dbAcc.normal_balance,
        is_postable: dbAcc.is_postable,
        status: dbAcc.status,
        parentCode: parentDb?.code ?? null,
        source: 'DB',
        dbAccount: dbAcc,
        fileRow: null,
      };
    }

    return null;
  }

  // Pass 3: Resolve parent_code / parent_name for every row (independent of Excel row order!)
  for (const w of workingRows) {
    if (w.parent_code) {
      if (w.code && w.parent_code === w.code) {
        w.errors.push('لا يمكن أن يكون الحساب أباً لنفسه (علاقة دائرية).');
        continue;
      }

      const pCodeOcc = codeOccurrences.get(w.parent_code);
      if (pCodeOcc && pCodeOcc.length > 1 && !existingByCode.has(w.parent_code)) {
        w.errors.push(
          `رمز الحساب الأب "${w.parent_code}" مكرر داخل ملف Excel ولا يمكن حسمه بأمان.`,
        );
        continue;
      }

      const effParent = getEffectiveNode(w.parent_code);
      if (!effParent) {
        const existsOnlyInSkippedNew =
          mode === 'UPDATE_EXISTING' &&
          !createMissingInUpdateMode &&
          uniqueFileRowByCode.has(w.parent_code) &&
          !existingByCode.has(w.parent_code);
        if (existsOnlyInSkippedNew) {
          w.errors.push(
            `الحساب الأب "${w.parent_code}" غير موجود في قاعدة البيانات ولن يتم إنشاؤه لأن خيار إنشاء الحسابات الجديدة غير مفعّل.`,
          );
        } else {
          w.errors.push(
            `الحساب الأب المحدد برمز "${w.parent_code}" غير موجود في الملف أو في قاعدة البيانات.`,
          );
        }
        continue;
      }

      w.resolvedParentKind = effParent.dbAccount && mode === 'ADD_NEW' ? 'DB' : effParent.source;
      w.resolvedParentCode = effParent.code;
      w.resolvedParentName = effParent.name_ar;
      w.resolvedParentId = effParent.dbAccount?.id ?? null;

      if (
        w.parent_name &&
        effParent.name_ar &&
        normalizeTextToken(w.parent_name) !== normalizeTextToken(effParent.name_ar)
      ) {
        w.warnings.push(
          `اسم الحساب الأب في الملف "${w.parent_name}" يختلف عن اسم الحساب الأب المرجعي "${effParent.name_ar}".`,
        );
      }
    } else if (w.parent_name) {
      // Fallback: resolve by parent_name across DB + File
      const nk = normalizeTextToken(w.parent_name);
      const candidates = new Map<string, { code: string; name_ar: string; id: string | null; kind: 'DB' | 'FILE' }>();

      for (const dbMatch of dbByNormalizedName.get(nk) ?? []) {
        candidates.set(dbMatch.code, {
          code: dbMatch.code,
          name_ar: dbMatch.name_ar,
          id: dbMatch.id,
          kind: 'DB',
        });
      }
      for (const fileMatch of fileByNormalizedName.get(nk) ?? []) {
        if (!candidates.has(fileMatch.code)) {
          if (mode === 'UPDATE_EXISTING' && !createMissingInUpdateMode && !fileMatch.existsInDb) {
            continue;
          }
          candidates.set(fileMatch.code, {
            code: fileMatch.code,
            name_ar: fileMatch.name_ar,
            id: fileMatch.existingAccount?.id ?? null,
            kind: 'FILE',
          });
        }
      }

      if (candidates.size === 0) {
        w.errors.push(`لم يتم العثور على الحساب الأب بالاسم "${w.parent_name}".`);
      } else if (candidates.size > 1) {
        w.errors.push(
          `اسم الحساب الأب "${w.parent_name}" مشترك بين أكثر من حساب؛ يرجى تحديد رمز الحساب الأب.`,
        );
      } else {
        const [only] = [...candidates.values()];
        if (w.code && only.code === w.code) {
          w.errors.push('لا يمكن أن يكون الحساب أباً لنفسه (علاقة دائرية).');
        } else {
          w.resolvedParentKind = only.kind;
          w.resolvedParentCode = only.code;
          w.resolvedParentName = only.name_ar;
          w.resolvedParentId = only.id;
          w.warnings.push(
            `تمت مطابقة الحساب الأب بالاسم فقط (${only.code} — ${only.name_ar})؛ يرجى مراجعة الربط وتحديد رمز الحساب الأب مستقبلاً.`,
          );
        }
      }
    }
  }

  // Pass 4: Cycle detection & hierarchical depth computation over the combined effective graph
  const depthMemo = new Map<string, number | null>();
  const cycleNodes = new Set<string>();

  function computeDepthForCode(startCode: string): number | null {
    if (depthMemo.has(startCode)) return depthMemo.get(startCode)!;
    if (cycleNodes.has(startCode)) return null;

    const path: string[] = [];
    const pathIdx = new Map<string, number>();
    let curr: string | null = startCode;

    while (curr) {
      if (depthMemo.has(curr)) {
        const knownDepth = depthMemo.get(curr)!;
        if (knownDepth === null) {
          for (const c of path) depthMemo.set(c, null);
          return null;
        }
        for (let i = path.length - 1; i >= 0; i--) {
          depthMemo.set(path[i], knownDepth + (path.length - i));
        }
        return depthMemo.get(startCode)!;
      }

      if (pathIdx.has(curr)) {
        const loopStart = pathIdx.get(curr)!;
        const cycleSlice = path.slice(loopStart);
        for (const c of cycleSlice) {
          cycleNodes.add(c);
        }
        for (const c of path) {
          depthMemo.set(c, null);
        }
        return null;
      }

      const eff = getEffectiveNode(curr);
      if (!eff) {
        for (const c of path) depthMemo.set(c, null);
        return null;
      }

      pathIdx.set(curr, path.length);
      path.push(curr);
      curr = eff.parentCode;
    }

    // Reached root (parentCode === null)
    for (let i = path.length - 1; i >= 0; i--) {
      depthMemo.set(path[i], path.length - i);
    }
    return depthMemo.get(startCode)!;
  }

  for (const w of workingRows) {
    if (!w.code || (codeOccurrences.get(w.code)?.length ?? 0) > 1) continue;
    if (w.existsInDb && mode === 'ADD_NEW') {
      // Existing DB account depth
      w.computed_level = computeDepthForCode(w.code);
      continue;
    }
    w.computed_level = computeDepthForCode(w.code);
  }

  for (const w of workingRows) {
    if (w.code && cycleNodes.has(w.code)) {
      w.errors.push(
        `تم اكتشاف علاقة أب دائرية في التسلسل الهرمي تشمل الحساب "${w.code}".`,
      );
    }
    if (w.specified_level !== null && w.computed_level !== null) {
      if (w.specified_level !== w.computed_level) {
        w.errors.push(
          `المستوى المحدد (${w.specified_level}) لا يتطابق مع الموقع الفعلي للحساب في الشجرة (${w.computed_level}).`,
        );
      }
    }
  }

  // Pass 5: Build effective children map (DB + File) to validate parent/child & posting rules
  const effectiveChildrenMap = new Map<string, Set<string>>();
  for (const acc of existingAccounts) {
    const eff = getEffectiveNode(acc.code);
    if (eff && eff.parentCode) {
      const set = effectiveChildrenMap.get(eff.parentCode) ?? new Set<string>();
      set.add(eff.code);
      effectiveChildrenMap.set(eff.parentCode, set);
    }
  }
  for (const w of workingRows) {
    if (!w.code || !w.resolvedParentCode) continue;
    if (w.existsInDb && mode === 'ADD_NEW') continue;
    if (!w.existsInDb && mode === 'UPDATE_EXISTING' && !createMissingInUpdateMode) continue;
    const set = effectiveChildrenMap.get(w.resolvedParentCode) ?? new Set<string>();
    set.add(w.code);
    effectiveChildrenMap.set(w.resolvedParentCode, set);
  }

  for (const w of workingRows) {
    // Skip hierarchy/update validation if row is an untouched EXISTING account in ADD_NEW mode
    if (w.existsInDb && mode === 'ADD_NEW') {
      continue;
    }
    if (!w.existsInDb && mode === 'UPDATE_EXISTING' && !createMissingInUpdateMode) {
      continue;
    }

    // Validate against resolved parent
    if (w.resolvedParentCode) {
      const effParent = getEffectiveNode(w.resolvedParentCode);
      if (effParent) {
        if (effParent.is_postable === true) {
          w.errors.push(
            `الحساب الأب (${effParent.code} - ${effParent.name_ar}) مصنف كحساب فرعي قابل للترحيل؛ يجب أن يكون الحساب الأب حساباً رئيسياً غير قابل للترحيل.`,
          );
        }
        if (w.account_type && effParent.account_type && w.account_type !== effParent.account_type) {
          w.errors.push(
            `نوع الحساب (${ACCOUNT_TYPE_AR[w.account_type]}) لا يتطابق مع نوع الحساب الأب (${ACCOUNT_TYPE_AR[effParent.account_type]}).`,
          );
        }
        if (w.status === 'ACTIVE' && effParent.status === 'INACTIVE') {
          w.errors.push(
            `لا يمكن إضافة أو تفعيل حساب فرعي نشط تحت حساب أب غير نشط (${effParent.code}).`,
          );
        }
      }
    }

    // Validate own is_postable against effective children
    if (w.code && w.is_postable === true) {
      const children = effectiveChildrenMap.get(w.code);
      if (children && children.size > 0) {
        w.errors.push(
          `لا يمكن تعيين الحساب "${w.code}" كقابل للترحيل لأن لديه حسابات فرعية (${[...children].slice(0, 4).join('، ')}).`,
        );
      }
    }

    // Validate UPDATE_EXISTING critical protections against DB history & usage
    if (w.existsInDb && w.existingAccount && mode === 'UPDATE_EXISTING') {
      const dbAcc = w.existingAccount;
      const usage = accountUsageMap.get(dbAcc.id) ?? {
        hasJournalLines: false,
        hasVouchers: false,
        hasDraftUsage: false,
      };
      const hasTransactions = usage.hasJournalLines || usage.hasVouchers;

      if (hasTransactions) {
        if (w.account_type && w.account_type !== dbAcc.account_type) {
          w.errors.push(
            'لا يمكن تغيير نوع الحساب لوجود قيود أو سندات محاسبية تاريخية مرتبطة به.',
          );
        }
        if (w.normal_balance && w.normal_balance !== dbAcc.normal_balance) {
          w.errors.push(
            'لا يمكن تغيير الطبيعة المحاسبية لحساب مرتبط بقيود أو سندات محاسبية قائمة.',
          );
        }
        if (dbAcc.is_postable && w.is_postable === false) {
          w.errors.push(
            'لا يمكن تحويل حساب عليه حركات مالية إلى حساب رئيسي غير قابل للترحيل.',
          );
        }
      }

      if (dbAcc.status === 'ACTIVE' && w.status === 'INACTIVE') {
        if (usage.hasDraftUsage) {
          w.errors.push(
            'لا يمكن تعطيل حساب مستخدم في قيود يومية أو سندات بحالة مسودة.',
          );
        }
        const children = effectiveChildrenMap.get(w.code);
        if (children && children.size > 0) {
          for (const childCode of children) {
            const effChild = getEffectiveNode(childCode);
            if (effChild && effChild.status === 'ACTIVE') {
              w.errors.push(
                `لا يمكن تعطيل حساب رئيسي لديه حسابات فرعية نشطة (مثل: ${childCode}).`,
              );
              break;
            }
          }
        }
      }

      // Compute exact field changes for confirmation preview
      const diffs: AccountImportFieldDiff[] = [];
      if (w.name_ar && w.name_ar !== dbAcc.name_ar) {
        diffs.push({
          field: 'name_ar',
          label: 'اسم الحساب',
          oldValue: dbAcc.name_ar,
          newValue: w.name_ar,
        });
      }
      if (w.account_type && w.account_type !== dbAcc.account_type) {
        diffs.push({
          field: 'account_type',
          label: 'نوع الحساب',
          oldValue: ACCOUNT_TYPE_AR[dbAcc.account_type],
          newValue: ACCOUNT_TYPE_AR[w.account_type],
        });
      }
      if (w.normal_balance && w.normal_balance !== dbAcc.normal_balance) {
        diffs.push({
          field: 'normal_balance',
          label: 'الطبيعة',
          oldValue: NORMAL_BALANCE_AR[dbAcc.normal_balance],
          newValue: NORMAL_BALANCE_AR[w.normal_balance],
        });
      }
      const oldParentCode = dbAcc.parent_id ? existingById.get(dbAcc.parent_id)?.code ?? null : null;
      const newParentCode = w.resolvedParentCode;
      if (oldParentCode !== newParentCode) {
        diffs.push({
          field: 'parent_id',
          label: 'الحساب الأب',
          oldValue: oldParentCode ?? 'بدون (حساب رئيسي)',
          newValue: newParentCode ?? 'بدون (حساب رئيسي)',
        });
      }
      if (w.is_postable !== null && w.is_postable !== dbAcc.is_postable) {
        diffs.push({
          field: 'is_postable',
          label: 'مستوى الترحيل',
          oldValue: dbAcc.is_postable ? 'فرعي (قابل للترحيل)' : 'رئيسي (غير قابل للترحيل)',
          newValue: w.is_postable ? 'فرعي (قابل للترحيل)' : 'رئيسي (غير قابل للترحيل)',
        });
      }
      if (w.status && w.status !== dbAcc.status) {
        diffs.push({
          field: 'status',
          label: 'الحالة',
          oldValue: dbAcc.status === 'ACTIVE' ? 'نشط' : 'غير نشط',
          newValue: w.status === 'ACTIVE' ? 'نشط' : 'غير نشط',
        });
      }
      if (
        mapping.cost_center_required !== null &&
        mapping.cost_center_required !== undefined &&
        w.cost_center_required !== dbAcc.cost_center_required
      ) {
        diffs.push({
          field: 'cost_center_required',
          label: 'مركز التكلفة',
          oldValue: dbAcc.cost_center_required ? 'إلزامي' : 'اختياري',
          newValue: w.cost_center_required ? 'إلزامي' : 'اختياري',
        });
      }
      w.changes = diffs;
    }
  }

  // Pass 6: Dependency propagation — if a parent row in the file has errors and is NOT already in DB,
  // children referencing that parent row cannot be created and must be marked INVALID as well.
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of workingRows) {
      if (w.errors.length > 0) continue;
      if (!w.resolvedParentCode) continue;
      if (w.existsInDb && mode === 'ADD_NEW') continue;

      const parentFileRow = uniqueFileRowByCode.get(w.resolvedParentCode);
      const parentInDb = existingByCode.has(w.resolvedParentCode);
      if (parentFileRow && parentFileRow.errors.length > 0) {
        if (!parentInDb || mode === 'UPDATE_EXISTING') {
          w.errors.push(
            `الحساب الأب "${w.resolvedParentCode}" يحتوي على أخطاء تمنع اعتماده؛ لذا لا يمكن استيراد هذا الحساب التابع له قبل تصحيح الأب.`,
          );
          changed = true;
        }
      }
    }
  }

  // Pass 7: Final Classification & Topological Execution Order
  const insertQueue: WorkingRow[] = [];

  for (const w of workingRows) {
    if (w.errors.length > 0) {
      w.classification = 'INVALID';
      w.action = 'ERROR';
      continue;
    }

    if (w.existsInDb) {
      if (mode === 'ADD_NEW') {
        w.classification = 'EXISTING';
        w.action = 'SKIP';
        w.warnings.push(
          'الحساب موجود مسبقاً في قاعدة البيانات؛ لن يتم تعديله في وضع إضافة الحسابات الجديدة.',
        );
      } else {
        w.classification = w.warnings.length > 0 ? 'REQUIRES_REVIEW' : 'EXISTING';
        w.action = w.changes.length > 0 ? 'UPDATE' : 'SKIP';
        if (w.changes.length === 0) {
          w.warnings.push('بيانات الحساب مطابقة لما هو مسجل في قاعدة البيانات ولا توجد تغييرات.');
        }
      }
    } else {
      if (mode === 'UPDATE_EXISTING' && !createMissingInUpdateMode) {
        w.classification = 'REQUIRES_REVIEW';
        w.action = 'SKIP';
        w.warnings.push(
          'الحساب غير موجود في قاعدة البيانات؛ سيتم تخطيه لأن وضع التحديث مقتصر على الحسابات القائمة فقط.',
        );
      } else {
        w.classification = w.warnings.length > 0 ? 'REQUIRES_REVIEW' : 'VALID';
        w.action = 'INSERT';
        insertQueue.push(w);
      }
    }
  }

  // Topological sort for inserts: ascending by computed_level, then excelRowNumber
  insertQueue.sort((a, b) => {
    const la = a.computed_level ?? 999;
    const lb = b.computed_level ?? 999;
    if (la !== lb) return la - lb;
    return a.excelRowNumber - b.excelRowNumber;
  });

  insertQueue.forEach((w, idx) => {
    w.executionOrder = idx + 1;
  });

  const previewRows: AccountImportPreviewRow[] = workingRows.map((w) => ({
    excelRowNumber: w.excelRowNumber,
    raw: w.raw,
    normalized: {
      code: w.code,
      name_ar: w.name_ar,
      parent_code: w.parent_code,
      parent_name: w.parent_name,
      resolved_parent_id: w.resolvedParentId,
      resolved_parent_code: w.resolvedParentCode,
      resolved_parent_name: w.resolvedParentName,
      specified_level: w.specified_level,
      computed_level: w.computed_level,
      account_type: w.account_type,
      normal_balance: w.normal_balance,
      is_postable: w.is_postable,
      status: w.status,
      cost_center_required: w.cost_center_required,
    },
    classification: w.classification,
    action: w.action,
    existsInDb: w.existsInDb,
    existingAccountId: w.existingAccount?.id ?? null,
    errors: w.errors,
    warnings: w.warnings,
    changes: w.changes,
    executionOrder: w.executionOrder,
  }));

  const summary = {
    totalRows: previewRows.length,
    validCount: previewRows.filter((r) => r.classification === 'VALID').length,
    invalidCount: previewRows.filter((r) => r.classification === 'INVALID').length,
    existingCount: previewRows.filter((r) => r.classification === 'EXISTING').length,
    reviewCount: previewRows.filter((r) => r.classification === 'REQUIRES_REVIEW').length,
    insertableCount: previewRows.filter((r) => r.action === 'INSERT').length,
    updatableCount: previewRows.filter((r) => r.action === 'UPDATE').length,
    unchangedExistingCount: previewRows.filter(
      (r) => r.existsInDb && r.action === 'SKIP' && mode === 'UPDATE_EXISTING',
    ).length,
    skippableCount: previewRows.filter((r) => r.action === 'SKIP').length,
  };

  return {
    fileName,
    sheetName,
    mode,
    createMissingInUpdateMode,
    parseWarnings,
    blankRowsSkipped,
    mergedBannerRowsSkipped,
    summary,
    rows: previewRows,
  };
}
