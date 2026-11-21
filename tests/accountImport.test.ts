import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  parseAccountImportSheet,
  validateAndDecodeWorkbook,
} from '../src/server/accountImportParser.ts';
import { generateAccountsImportTemplateBuffer } from '../src/server/accountImportService.ts';
import {
  type AccountUsageInfo,
  discoverPostingLevelValues,
  discoverUnifiedImportValues,
  normalizeFieldValueToken,
  normalizePostingToken,
  validateAndPlanAccountImport,
} from '../src/shared/accountImportValidator.ts';
import type { Account } from '../src/shared/types.ts';

const ts = '2026-01-01T00:00:00Z';

function makeWorkbookBase64(
  sheets: Array<{
    name: string;
    aoa: Array<Array<string | number | boolean>>;
    merges?: XLSX.Range[];
  }>,
  bookType: 'xlsx' | 'biff8' = 'xlsx',
): string {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.aoa);
    if (s.merges) {
      ws['!merges'] = s.merges;
    }
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType }) as Buffer;
  return buf.toString('base64');
}

const existingDbAccounts: Account[] = [
  {
    id: 'db-acc-1000',
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
    id: 'db-acc-1101',
    code: '1101',
    name_ar: 'الصندوق الرئيسي',
    account_type: 'ASSET',
    normal_balance: 'DEBIT',
    parent_id: 'db-acc-1000',
    is_postable: true,
    status: 'ACTIVE',
    cost_center_required: false,
    created_at: ts,
    updated_at: ts,
  },
];

test('Scenario 1, 2, 3: New Chart of Accounts with out-of-order parent/child & XLSX/XLS support', () => {
  // Child 1101 appears BEFORE parent 1100 and grandparent 1000; columns in custom English/Arabic order
  const aoa = [
    ['Account Name', 'Status', 'Posting Level', 'Nature', 'Accounting Type', 'Level', 'Parent Account Code', 'Account Code'],
    ['الصندوق الرئيسي', 'نشط', 'فرعي', 'مدين', 'الأصول', 3, '1100', '1101'],
    ['الأصول المتداولة', 'Active', 'Group', 'Debit', 'Asset', 2, '1000', '1100'],
    ['الأصول', 'نشط', 'رئيسي', 'مدين', 'الأصول', 1, '', '1000'],
  ];

  for (const format of ['xlsx', 'biff8'] as const) {
    const ext = format === 'xlsx' ? 'coa.xlsx' : 'coa.xls';
    const b64 = makeWorkbookBase64([{ name: 'COA', aoa }], format);
    const parsed = parseAccountImportSheet(ext, b64, 'COA');
    assert.equal(parsed.rows.length, 3);

    const preview = validateAndPlanAccountImport({
      fileName: ext,
      sheetName: 'COA',
      rows: parsed.rows,
      mapping: parsed.detectedMapping,
      existingAccounts: [],
      accountUsageMap: new Map(),
      mode: 'ADD_NEW',
    });

    assert.equal(preview.summary.invalidCount, 0);
    assert.equal(preview.summary.validCount, 3);
    assert.equal(preview.summary.insertableCount, 3);

    const orderedCodes = preview.rows
      .filter((r) => r.action === 'INSERT')
      .sort((a, b) => (a.executionOrder ?? 0) - (b.executionOrder ?? 0))
      .map((r) => r.normalized.code);
    assert.deepEqual(orderedCodes, ['1000', '1100', '1101']);
  }
});

test('Scenario 4 & 6: Parent already exists in DB and existing accounts handled per mode', () => {
  const aoa = [
    ['رمز الحساب', 'اسم الحساب', 'رمز الحساب الأب', 'المستوى', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل', 'الحالة'],
    ['1000', 'الأصول', '', 1, 'الأصول', 'مدين', 'رئيسي', 'نشط'],
    ['1102', 'البنك الأهلي', '1000', 2, 'الأصول', 'مدين', 'فرعي', 'نشط'],
  ];
  const b64 = makeWorkbookBase64([{ name: 'Sheet1', aoa }]);
  const parsed = parseAccountImportSheet('accounts.xlsx', b64);

  const previewAdd = validateAndPlanAccountImport({
    fileName: 'accounts.xlsx',
    sheetName: 'Sheet1',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: existingDbAccounts,
    accountUsageMap: new Map(),
    mode: 'ADD_NEW',
  });

  const row1000 = previewAdd.rows.find((r) => r.normalized.code === '1000')!;
  const row1102 = previewAdd.rows.find((r) => r.normalized.code === '1102')!;
  assert.equal(row1000.classification, 'EXISTING');
  assert.equal(row1000.action, 'SKIP');
  assert.equal(row1102.classification, 'VALID');
  assert.equal(row1102.action, 'INSERT');
  assert.equal(row1102.normalized.resolved_parent_id, 'db-acc-1000');
});

test('Scenario 5, 7, 8, 9, 10: Duplicates, missing parent, invalid level, invalid type/nature, invalid posting level', () => {
  const aoa = [
    ['رمز الحساب', 'اسم الحساب', 'رمز الحساب الأب', 'المستوى', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل'],
    ['2000', 'الالتزامات', '', 1, 'الالتزامات', 'دائن', 'رئيسي'],
    ['2000', 'التزام مكرر', '', 1, 'الالتزامات', 'دائن', 'رئيسي'], // duplicate code
    ['2100', 'موردون', '9999', 2, 'الالتزامات', 'دائن', 'فرعي'], // missing parent
    ['2200', 'قروض', '1000', 3, 'الالتزامات', 'دائن', 'فرعي'], // level mismatch (actual 2) + type mismatch with ASSET 1000
    ['2300', 'حساب بنوع خاطئ', '', 1, 'INVALID_TYPE', 'SIDEWAYS', 'MAYBE'], // invalid type, nature, posting
    ['2400', 'فرع تحت قابل للترحيل', '1101', 3, 'الأصول', 'مدين', 'فرعي'], // parent 1101 is postable
  ];
  const b64 = makeWorkbookBase64([{ name: 'Errors', aoa }]);
  const parsed = parseAccountImportSheet('errors.xlsx', b64);

  const preview = validateAndPlanAccountImport({
    fileName: 'errors.xlsx',
    sheetName: 'Errors',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: existingDbAccounts,
    accountUsageMap: new Map(),
    mode: 'ADD_NEW',
  });

  assert.equal(preview.summary.invalidCount, 6);
  assert.equal(preview.summary.insertableCount, 0);
  assert.ok(preview.rows[0].errors.some((e) => e.includes('مكرر')));
  assert.ok(preview.rows[2].errors.some((e) => e.includes('غير موجود')));
  assert.ok(preview.rows[3].errors.some((e) => e.includes('المستوى المحدد')));
  assert.ok(preview.rows[3].errors.some((e) => e.includes('نوع الحساب')));
  assert.ok(preview.rows[4].errors.length >= 3);
  assert.ok(preview.rows[5].errors.some((e) => e.includes('قابل للترحيل')));
});

test('Scenario 11: Circular parent-child relationship detection (self and multi-node cycles)', () => {
  const aoa = [
    ['رمز الحساب', 'اسم الحساب', 'رمز الحساب الأب', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل'],
    ['3001', 'حساب أ', '3002', 'حقوق الملكية', 'دائن', 'رئيسي'],
    ['3002', 'حساب ب', '3001', 'حقوق الملكية', 'دائن', 'رئيسي'],
    ['3003', 'حساب ج', '3003', 'حقوق الملكية', 'دائن', 'رئيسي'],
  ];
  const b64 = makeWorkbookBase64([{ name: 'Cycles', aoa }]);
  const parsed = parseAccountImportSheet('cycles.xlsx', b64);

  const preview = validateAndPlanAccountImport({
    fileName: 'cycles.xlsx',
    sheetName: 'Cycles',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: [],
    accountUsageMap: new Map(),
    mode: 'ADD_NEW',
  });

  assert.equal(preview.summary.invalidCount, 3);
  assert.ok(preview.rows[0].errors.some((e) => e.includes('دائرية')));
  assert.ok(preview.rows[1].errors.some((e) => e.includes('دائرية')));
  assert.ok(preview.rows[2].errors.some((e) => e.includes('لنفسه')));
});

test('Scenario 12 & 13: Update Existing Mode computes diffs and blocks unsafe updates on accounts with transactions or active children', () => {
  const aoa = [
    ['رمز الحساب', 'اسم الحساب', 'رمز الحساب الأب', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل', 'الحالة'],
    // Deactivating parent 1000 while child 1101 remains ACTIVE -> blocked
    ['1000', 'الأصول المحدثة', '', 'الأصول', 'مدين', 'رئيسي', 'غير نشط'],
    // Changing account_type of 1101 which has journal lines -> blocked
    ['1101', 'الصندوق المعدل', '1000', 'المصروفات', 'مدين', 'فرعي', 'نشط'],
  ];
  const b64 = makeWorkbookBase64([{ name: 'Updates', aoa }]);
  const parsed = parseAccountImportSheet('updates.xlsx', b64);

  const usageMap = new Map<string, AccountUsageInfo>([
    ['db-acc-1101', { hasJournalLines: true, hasVouchers: false, hasDraftUsage: false }],
  ]);

  const blockedPreview = validateAndPlanAccountImport({
    fileName: 'updates.xlsx',
    sheetName: 'Updates',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: existingDbAccounts,
    accountUsageMap: usageMap,
    mode: 'UPDATE_EXISTING',
  });

  assert.equal(blockedPreview.summary.invalidCount, 2);
  assert.ok(blockedPreview.rows[0].errors.some((e) => e.includes('حسابات فرعية نشطة')));
  assert.ok(blockedPreview.rows[1].errors.some((e) => e.includes('نوع الحساب')));

  // Safe rename update on 1101
  const safeAoa = [
    ['رمز الحساب', 'اسم الحساب', 'رمز الحساب الأب', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل', 'الحالة'],
    ['1101', 'الصندوق النقدي الرئيسي', '1000', 'الأصول', 'مدين', 'فرعي', 'نشط'],
  ];
  const safeB64 = makeWorkbookBase64([{ name: 'Updates', aoa: safeAoa }]);
  const safeParsed = parseAccountImportSheet('safe_updates.xlsx', safeB64);
  const safePreview = validateAndPlanAccountImport({
    fileName: 'safe_updates.xlsx',
    sheetName: 'Updates',
    rows: safeParsed.rows,
    mapping: safeParsed.detectedMapping,
    existingAccounts: existingDbAccounts,
    accountUsageMap: usageMap,
    mode: 'UPDATE_EXISTING',
  });

  assert.equal(safePreview.summary.invalidCount, 0);
  assert.equal(safePreview.summary.updatableCount, 1);
  assert.equal(safePreview.rows[0].changes.length, 1);
  assert.equal(safePreview.rows[0].changes[0].oldValue, 'الصندوق الرئيسي');
  assert.equal(safePreview.rows[0].changes[0].newValue, 'الصندوق النقدي الرئيسي');
});

test('Scenario 14: Handles merged banner rows, partially merged 2-row composite headers, empty rows, and vertical merges without duplicating data', () => {
  const aoa: Array<Array<string | number>> = [
    ['دليل الحسابات الموحد للشركة', '', '', '', '', '', ''], // Row 1: merged title banner A1:G1
    ['', '', '', '', '', '', ''], // Row 2: blank
    ['رمز الحساب', 'اسم الحساب', 'الحساب الأب', '', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل'], // Row 3: composite top
    ['', '', 'الرمز', 'الاسم', '', '', ''], // Row 4: subheaders for parent + vertical merges for rest
    ['1000', 'الأصول', '', '', 'الأصول', 'مدين', 'رئيسي'], // Row 5
    ['', '', '', '', '', '', ''], // Row 6: empty row
    ['قسم الأصول المتداولة', '', '', '', '', '', ''], // Row 7: merged section banner A7:G7
    ['1101', 'الصندوق', '1000', 'الأصول', 'الأصول', 'مدين', 'فرعي'], // Row 8
  ];
  const merges: XLSX.Range[] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
    { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } },
    { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } },
    { s: { r: 2, c: 2 }, e: { r: 2, c: 3 } },
    { s: { r: 2, c: 4 }, e: { r: 3, c: 4 } },
    { s: { r: 2, c: 5 }, e: { r: 3, c: 5 } },
    { s: { r: 2, c: 6 }, e: { r: 3, c: 6 } },
    { s: { r: 6, c: 0 }, e: { r: 6, c: 6 } },
  ];

  const b64 = makeWorkbookBase64([{ name: 'MergedCOA', aoa, merges }]);
  const parsed = parseAccountImportSheet('merged.xlsx', b64);

  assert.equal(parsed.headerRowNumber, 3);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.blankRowsSkipped, 1);
  assert.equal(parsed.mergedBannerRowsSkipped, 1);
  assert.equal(parsed.detectedMapping.parent_code, 2);
  assert.equal(parsed.detectedMapping.parent_name, 3);

  const preview = validateAndPlanAccountImport({
    fileName: 'merged.xlsx',
    sheetName: 'MergedCOA',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: [],
    accountUsageMap: new Map(),
    mode: 'ADD_NEW',
  });
  assert.equal(preview.summary.validCount, 2);
});

test('Scenario 15: Rejects unsupported extensions and corrupted Excel files cleanly', () => {
  assert.throws(
    () => validateAndDecodeWorkbook('accounts.csv', Buffer.from('a,b').toString('base64')),
    /صيغة الملف غير مدعومة/,
  );
  assert.throws(
    () => validateAndDecodeWorkbook('corrupted.xlsx', Buffer.from('NOT_AN_EXCEL_FILE').toString('base64')),
    /تالف|لا يطابق/,
  );
  assert.throws(
    () => validateAndDecodeWorkbook('empty.xlsx', ''),
    /فارغ/,
  );

  // Template generator produces valid headers-only xlsx with 0 data rows
  const { buffer, filename } = generateAccountsImportTemplateBuffer();
  assert.equal(filename, 'chart_of_accounts_import_template.xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
  assert.equal(rows.length, 1); // headers only, zero sample/mock records
});

test('Scenario 16: Smart posting-level value discovery deduplicates, tracks blanks, auto-matches safely, and prioritizes saved mappings', () => {
  const aoa = [
    ['رمز الحساب', 'اسم الحساب', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل'],
    ['1000', 'الأصول', 'الأصول', 'مدين', 'حساب رئيسي (تجميعي)'], // Row 2 -> AUTO GROUP
    ['1100', 'الأصول المتداولة', 'الأصول', 'مدين', 'حساب رئيسي (تجميعي)'], // Row 3 -> duplicate
    ['1101', 'الصندوق', 'الأصول', 'مدين', 'قابل للترحيل'], // Row 4 -> AUTO POSTING
    ['1102', 'البنك', 'الأصول', 'مدين', 'تحليلي'], // Row 5 -> UNMATCHED (unless saved)
    ['1103', 'العهد', 'الأصول', 'مدين', 'تحليلي'], // Row 6 -> duplicate UNMATCHED
    ['1104', 'ذمم', 'الأصول', 'مدين', 'رئيسي/فرعي'], // Row 7 -> conflicting cue -> UNMATCHED (never guessed)
    ['1105', 'حساب بدون مستوى', 'الأصول', 'مدين', ''], // Row 8 -> blank cell
  ];
  const b64 = makeWorkbookBase64([{ name: 'Discovery', aoa }]);
  const parsed = parseAccountImportSheet('discovery.xlsx', b64, 'Discovery');

  const discovery = discoverPostingLevelValues({
    fileName: 'discovery.xlsx',
    sheetName: 'Discovery',
    rows: parsed.rows,
    postingColumnIndex: parsed.detectedMapping.is_postable,
    savedMappings: [],
  });

  assert.equal(discovery.totalRows, 7);
  assert.equal(discovery.blankCount, 1);
  assert.deepEqual(discovery.blankRowNumbers, [8]);
  assert.equal(discovery.items.length, 4); // 4 unique non-empty values
  assert.equal(discovery.matchedCount, 2);
  assert.equal(discovery.unmatchedCount, 2);

  const groupAuto = discovery.items.find((i) => i.rawValue === 'حساب رئيسي (تجميعي)')!;
  assert.equal(groupAuto.count, 2);
  assert.deepEqual(groupAuto.rowNumbers, [2, 3]);
  assert.equal(groupAuto.matchSource, 'AUTO');
  assert.equal(groupAuto.suggestedTarget, 'GROUP');

  const postingAuto = discovery.items.find((i) => i.rawValue === 'قابل للترحيل')!;
  assert.equal(postingAuto.matchSource, 'AUTO');
  assert.equal(postingAuto.suggestedTarget, 'POSTING');

  const analytical = discovery.items.find((i) => i.rawValue === 'تحليلي')!;
  assert.equal(analytical.count, 2);
  assert.deepEqual(analytical.rowNumbers, [5, 6]);
  assert.equal(analytical.matchSource, 'UNMATCHED');
  assert.equal(analytical.suggestedTarget, null);

  const conflicting = discovery.items.find((i) => i.rawValue === 'رئيسي/فرعي')!;
  assert.equal(conflicting.matchSource, 'UNMATCHED');
  assert.equal(conflicting.suggestedTarget, null);

  // Now simulate saved mappings reusing previous decisions and overriding auto if configured
  const discoveryWithSaved = discoverPostingLevelValues({
    fileName: 'discovery.xlsx',
    sheetName: 'Discovery',
    rows: parsed.rows,
    postingColumnIndex: parsed.detectedMapping.is_postable,
    savedMappings: [
      { normalized_token: normalizePostingToken('تحليلي'), internal_target: 'POSTING' },
    ],
  });

  const savedAnalytical = discoveryWithSaved.items.find((i) => i.rawValue === 'تحليلي')!;
  assert.equal(savedAnalytical.matchSource, 'SAVED');
  assert.equal(savedAnalytical.suggestedTarget, 'POSTING');
  assert.equal(discoveryWithSaved.matchedCount, 3);
  assert.equal(discoveryWithSaved.unmatchedCount, 1);
});

test('Scenario 17: Manual postingValueMappings apply uniformly across duplicate rows and respect hierarchy/transaction guards', () => {
  const aoa = [
    ['رمز الحساب', 'اسم الحساب', 'رمز الحساب الأب', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل'],
    ['5000', 'المصروفات', '', 'المصروفات', 'مدين', 'تصنيف أ'], // custom unknown -> GROUP
    ['5100', 'مصروفات تشغيلية', '5000', 'المصروفات', 'مدين', 'تصنيف أ'], // duplicate custom -> GROUP
    ['5101', 'رواتب', '5100', 'المصروفات', 'مدين', 'تحليلي'], // custom unknown -> POSTING
    ['5102', 'إيجارات', '5100', 'المصروفات', 'مدين', 'تحليلي'], // duplicate custom -> POSTING
  ];
  const b64 = makeWorkbookBase64([{ name: 'Custom', aoa }]);
  const parsed = parseAccountImportSheet('custom.xlsx', b64, 'Custom');

  // Without manual mappings, all 4 rows fail posting-level resolution
  const unmappedPreview = validateAndPlanAccountImport({
    fileName: 'custom.xlsx',
    sheetName: 'Custom',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: [],
    accountUsageMap: new Map(),
    mode: 'ADD_NEW',
  });
  assert.equal(unmappedPreview.summary.invalidCount, 4);

  // With user-confirmed mappings, all 4 resolve cleanly and respect parent/child hierarchy
  const mappedPreview = validateAndPlanAccountImport({
    fileName: 'custom.xlsx',
    sheetName: 'Custom',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: [],
    accountUsageMap: new Map(),
    mode: 'ADD_NEW',
    postingValueMappings: {
      'تصنيف أ': 'GROUP',
      تحليلي: 'POSTING',
    },
  });
  assert.equal(mappedPreview.summary.invalidCount, 0);
  assert.equal(mappedPreview.summary.insertableCount, 4);
  assert.equal(mappedPreview.rows[0].normalized.is_postable, false);
  assert.equal(mappedPreview.rows[1].normalized.is_postable, false);
  assert.equal(mappedPreview.rows[2].normalized.is_postable, true);
  assert.equal(mappedPreview.rows[3].normalized.is_postable, true);

  // Verify transaction guard: cannot remap existing POSTING account with journal lines to GROUP
  const updateAoa = [
    ['رمز الحساب', 'اسم الحساب', 'رمز الحساب الأب', 'نوع الحساب', 'طبيعة الحساب', 'مستوى الترحيل'],
    ['1101', 'الصندوق الرئيسي', '1000', 'الأصول', 'مدين', 'تصنيف أ'],
  ];
  const updateB64 = makeWorkbookBase64([{ name: 'Update', aoa: updateAoa }]);
  const updateParsed = parseAccountImportSheet('update_posting.xlsx', updateB64, 'Update');
  const blockedUpdate = validateAndPlanAccountImport({
    fileName: 'update_posting.xlsx',
    sheetName: 'Update',
    rows: updateParsed.rows,
    mapping: updateParsed.detectedMapping,
    existingAccounts: existingDbAccounts,
    accountUsageMap: new Map([
      ['db-acc-1101', { hasJournalLines: true, hasVouchers: false, hasDraftUsage: false }],
    ]),
    mode: 'UPDATE_EXISTING',
    postingValueMappings: {
      'تصنيف أ': 'GROUP',
    },
  });
  assert.equal(blockedUpdate.summary.invalidCount, 1);
  assert.ok(blockedUpdate.rows[0].errors.some((e) => e.includes('غير قابل للترحيل')));
});

test('Scenario 18: Unified multi-field discovery auto-matches clear synonyms, blocks ambiguous compound values, and isolates saved mappings per field_key', () => {
  const aoa = [
    ['رمز الحساب', 'اسم الحساب', 'النوع المحاسبي', 'طبيعة الحساب', 'مستوى الترحيل', 'الحالة', 'مركز التكلفة'],
    ['1000', 'الأصول', 'الموجودات', 'مدين', 'رئيسي', 'فعال', 'إلزامي'], // all AUTO
    ['2000', 'الالتزامات', 'الخصوم / الالتزامات', 'دائن', 'حساب رئيسي (تجميعي)', 'موقوف', 'اختياري'], // account_type compound -> UNMATCHED
    ['2100', 'موردون', 'المطلوبات', 'مدين/دائن', 'تحليلي', 'مؤقت', 'حسب القسم'], // normal_balance compound, posting/status/cc custom -> UNMATCHED
    ['2101', 'دائنون متنوعون', 'نوع خاص', 'نوع خاص', 'تحليلي', 'نوع خاص', ''], // 'نوع خاص' saved ONLY for account_type -> must NOT leak to normal_balance or status
  ];
  const b64 = makeWorkbookBase64([{ name: 'Unified', aoa }]);
  const parsed = parseAccountImportSheet('unified.xlsx', b64, 'Unified');

  const discovery = discoverUnifiedImportValues({
    fileName: 'unified.xlsx',
    sheetName: 'Unified',
    rows: parsed.rows,
    columnHeaders: Object.fromEntries(parsed.columns.map((c) => [c.index, c.header])),
    mapping: parsed.detectedMapping,
    savedMappings: [
      {
        field_key: 'account_type',
        normalized_token: normalizeFieldValueToken('نوع خاص'),
        internal_target: 'EXPENSE',
      },
    ],
  });

  assert.equal(discovery.columns.length, 5);

  const typeCol = discovery.columns.find((c) => c.fieldKey === 'account_type')!;
  assert.equal(typeCol.items.find((i) => i.rawValue === 'الموجودات')?.suggestedTarget, 'ASSET');
  assert.equal(typeCol.items.find((i) => i.rawValue === 'المطلوبات')?.suggestedTarget, 'LIABILITY');
  assert.equal(typeCol.items.find((i) => i.rawValue === 'الخصوم / الالتزامات')?.matchSource, 'UNMATCHED');
  assert.equal(typeCol.items.find((i) => i.rawValue === 'الخصوم / الالتزامات')?.suggestedTarget, null);
  assert.equal(typeCol.items.find((i) => i.rawValue === 'نوع خاص')?.matchSource, 'SAVED');
  assert.equal(typeCol.items.find((i) => i.rawValue === 'نوع خاص')?.suggestedTarget, 'EXPENSE');

  const natureCol = discovery.columns.find((c) => c.fieldKey === 'normal_balance')!;
  assert.equal(natureCol.items.find((i) => i.rawValue === 'مدين')?.suggestedTarget, 'DEBIT');
  assert.equal(natureCol.items.find((i) => i.rawValue === 'دائن')?.suggestedTarget, 'CREDIT');
  assert.equal(natureCol.items.find((i) => i.rawValue === 'مدين/دائن')?.matchSource, 'UNMATCHED');
  // Strict field isolation: 'نوع خاص' saved under account_type must remain UNMATCHED in normal_balance
  assert.equal(natureCol.items.find((i) => i.rawValue === 'نوع خاص')?.matchSource, 'UNMATCHED');

  const postingCol = discovery.columns.find((c) => c.fieldKey === 'is_postable')!;
  assert.equal(postingCol.items.find((i) => i.rawValue === 'تحليلي')?.count, 2);
  assert.equal(postingCol.items.find((i) => i.rawValue === 'تحليلي')?.matchSource, 'UNMATCHED');

  const statusCol = discovery.columns.find((c) => c.fieldKey === 'status')!;
  assert.equal(statusCol.items.find((i) => i.rawValue === 'فعال')?.suggestedTarget, 'ACTIVE');
  assert.equal(statusCol.items.find((i) => i.rawValue === 'موقوف')?.suggestedTarget, 'INACTIVE');
  assert.equal(statusCol.items.find((i) => i.rawValue === 'مؤقت')?.matchSource, 'UNMATCHED');
  // Strict field isolation: 'نوع خاص' must remain UNMATCHED in status as well
  assert.equal(statusCol.items.find((i) => i.rawValue === 'نوع خاص')?.matchSource, 'UNMATCHED');

  const ccCol = discovery.columns.find((c) => c.fieldKey === 'cost_center_required')!;
  assert.equal(ccCol.blankCount, 1);
  assert.deepEqual(ccCol.blankRowNumbers, [5]);
  assert.equal(ccCol.items.find((i) => i.rawValue === 'إلزامي')?.suggestedTarget, 'REQUIRED');
  assert.equal(ccCol.items.find((i) => i.rawValue === 'اختياري')?.suggestedTarget, 'OPTIONAL');
  assert.equal(ccCol.items.find((i) => i.rawValue === 'حسب القسم')?.matchSource, 'UNMATCHED');
});

test('Scenario 19: Unified fieldValueMappings apply uniformly across duplicate rows per column and fail cleanly when unmapped', () => {
  const aoa = [
    ['رمز الحساب', 'اسم الحساب', 'رمز الحساب الأب', 'النوع المحاسبي', 'طبيعة الحساب', 'مستوى الترحيل', 'الحالة', 'مركز التكلفة'],
    ['2000', 'الالتزامات', '', 'الخصوم / الالتزامات', 'دائن مخصص', 'تجميعي', 'نشط', ''],
    ['2100', 'ذمم دائنة', '2000', 'الخصوم / الالتزامات', 'دائن مخصص', 'تحليلي', 'معلق مؤقتاً', 'حسب القسم'],
    ['2101', 'موردون محليون', '2000', 'الخصوم / الالتزامات', 'دائن مخصص', 'تحليلي', 'معلق مؤقتاً', 'حسب القسم'],
  ];
  const b64 = makeWorkbookBase64([{ name: 'UnifiedApply', aoa }]);
  const parsed = parseAccountImportSheet('unified_apply.xlsx', b64, 'UnifiedApply');

  // Unmapped -> all rows fail due to unresolved 'الخصوم / الالتزامات' & 'دائن مخصص'
  const unmapped = validateAndPlanAccountImport({
    fileName: 'unified_apply.xlsx',
    sheetName: 'UnifiedApply',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: [],
    accountUsageMap: new Map(),
    mode: 'ADD_NEW',
  });
  assert.equal(unmapped.summary.invalidCount, 3);

  // Mapped uniformly across all 5 discrete fields
  const mapped = validateAndPlanAccountImport({
    fileName: 'unified_apply.xlsx',
    sheetName: 'UnifiedApply',
    rows: parsed.rows,
    mapping: parsed.detectedMapping,
    existingAccounts: [],
    accountUsageMap: new Map(),
    mode: 'ADD_NEW',
    fieldValueMappings: {
      account_type: { 'الخصوم / الالتزامات': 'LIABILITY' },
      normal_balance: { 'دائن مخصص': 'CREDIT' },
      is_postable: { تحليلي: 'POSTING' },
      status: { 'معلق مؤقتاً': 'INACTIVE' },
      cost_center_required: { 'حسب القسم': 'REQUIRED' },
    },
  });

  assert.equal(mapped.summary.invalidCount, 0);
  assert.equal(mapped.summary.insertableCount, 3);

  assert.equal(mapped.rows[0].normalized.account_type, 'LIABILITY');
  assert.equal(mapped.rows[0].normalized.normal_balance, 'CREDIT');
  assert.equal(mapped.rows[0].normalized.is_postable, false);
  assert.equal(mapped.rows[0].normalized.status, 'ACTIVE');
  assert.equal(mapped.rows[0].normalized.cost_center_required, false);

  assert.equal(mapped.rows[1].normalized.account_type, 'LIABILITY');
  assert.equal(mapped.rows[1].normalized.normal_balance, 'CREDIT');
  assert.equal(mapped.rows[1].normalized.is_postable, true);
  assert.equal(mapped.rows[1].normalized.status, 'INACTIVE');
  assert.equal(mapped.rows[1].normalized.cost_center_required, true);

  assert.equal(mapped.rows[2].normalized.account_type, 'LIABILITY');
  assert.equal(mapped.rows[2].normalized.status, 'INACTIVE');
  assert.equal(mapped.rows[2].normalized.cost_center_required, true);
});

