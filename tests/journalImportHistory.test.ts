import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import {
  detectJournalColumnMapping,
  inspectJournalImportWorkbook,
  normalizeExcelDateString,
  parseJournalImportSheetFromWorkbook,
} from '../src/server/journalImportParser.ts';
import { generateJournalImportTemplateBuffer } from '../src/server/journalImportService.ts';
import {
  deleteJournalImportBatchSchema,
  executeJournalImportSchema,
  previewJournalImportSchema,
} from '../src/shared/validation.ts';

test('deleteJournalImportBatchSchema enforces explicit confirmation and valid deletion modes', () => {
  const missingConfirm = deleteJournalImportBatchSchema.safeParse({
    mode: 'DELETE_HISTORY_ONLY',
  });
  assert.equal(missingConfirm.success, false);

  const falseConfirm = deleteJournalImportBatchSchema.safeParse({
    mode: 'DELETE_BATCH_AND_ENTRIES',
    confirm: false,
  });
  assert.equal(falseConfirm.success, false);

  const invalidMode = deleteJournalImportBatchSchema.safeParse({
    mode: 'CASCADE_ALL',
    confirm: true,
  });
  assert.equal(invalidMode.success, false);

  const validHistoryOnly = deleteJournalImportBatchSchema.safeParse({
    mode: 'DELETE_HISTORY_ONLY',
    confirm: true,
  });
  assert.equal(validHistoryOnly.success, true);

  const validBatchAndEntries = deleteJournalImportBatchSchema.safeParse({
    mode: 'DELETE_BATCH_AND_ENTRIES',
    confirm: true,
  });
  assert.equal(validBatchAndEntries.success, true);
});

test('previewJournalImportSchema and executeJournalImportSchema require sheet selection', () => {
  const emptySheets = previewJournalImportSchema.safeParse({
    fileName: 'journals.xlsx',
    fileBase64: 'AAAA',
    sheetNames: [],
    mappingsBySheet: {},
  });
  assert.equal(emptySheets.success, false);

  const validExecute = executeJournalImportSchema.safeParse({
    fileName: 'journals.xlsx',
    fileBase64: 'AAAA',
    sheetNames: ['القيود'],
    mappingsBySheet: {
      القيود: {
        entry_group: 0,
        entry_date: 1,
        description: 2,
        account_code: 3,
        debit: 4,
        credit: 5,
      },
    },
    skipRejectedEntries: true,
  });
  assert.equal(validExecute.success, true);
});

test('normalizeExcelDateString handles ISO, DMY, slash, Arabic digits, and Excel serials', () => {
  assert.equal(normalizeExcelDateString('2026-03-15'), '2026-03-15');
  assert.equal(normalizeExcelDateString('2026/3/5'), '2026-03-05');
  assert.equal(normalizeExcelDateString('15/03/2026'), '2026-03-15');
  assert.equal(normalizeExcelDateString('١٥/٠٣/٢٠٢٦'), '2026-03-15');
  assert.equal(normalizeExcelDateString('45658'), '2025-01-01');
  assert.equal(normalizeExcelDateString('not-a-date'), null);
});

test('detectJournalColumnMapping matches Arabic and English headers accurately', () => {
  const mappingAr = detectJournalColumnMapping([
    'رقم القيد',
    'تاريخ القيد',
    'البيان',
    'الرقم المرجعي',
    'رمز مركز التكلفة',
    'رمز الحساب',
    'مدين',
    'دائن',
    'ملاحظة السطر',
  ]);

  assert.equal(mappingAr.entry_group, 0);
  assert.equal(mappingAr.entry_date, 1);
  assert.equal(mappingAr.description, 2);
  assert.equal(mappingAr.reference_number, 3);
  assert.equal(mappingAr.cost_center_code, 4);
  assert.equal(mappingAr.account_code, 5);
  assert.equal(mappingAr.debit, 6);
  assert.equal(mappingAr.credit, 7);
  assert.equal(mappingAr.line_description, 8);

  const mappingEn = detectJournalColumnMapping([
    'Entry Group',
    'Date',
    'Description',
    'Account Code',
    'Debit',
    'Credit',
  ]);
  assert.equal(mappingEn.entry_group, 0);
  assert.equal(mappingEn.entry_date, 1);
  assert.equal(mappingEn.description, 2);
  assert.equal(mappingEn.account_code, 3);
  assert.equal(mappingEn.debit, 4);
  assert.equal(mappingEn.credit, 5);
});

test('inspectJournalImportWorkbook supports multi-sheet Excel workbooks and skips blank rows', () => {
  const wb = XLSX.utils.book_new();
  const sheet1 = XLSX.utils.aoa_to_sheet([
    ['رقم القيد', 'تاريخ القيد', 'البيان', 'رمز الحساب', 'مدين', 'دائن'],
    ['G-1', '2026-05-01', 'قيد مبيعات', '1010', 500, 0],
    ['G-1', '2026-05-01', 'قيد مبيعات', '4010', 0, 500],
    ['', '', '', '', '', ''],
  ]);
  const sheet2 = XLSX.utils.aoa_to_sheet([
    ['Entry Group', 'Entry Date', 'Description', 'Account Code', 'Debit', 'Credit'],
    ['G-2', '2026-05-02', 'Cash receipt', '1010', 250, 0],
    ['G-2', '2026-05-02', 'Cash receipt', '4010', 0, 250],
  ]);

  XLSX.utils.book_append_sheet(wb, sheet1, 'قيود مايو');
  XLSX.utils.book_append_sheet(wb, sheet2, 'May Sheet 2');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const inspection = inspectJournalImportWorkbook('multi_sheet_journals.xlsx', buf.toString('base64'));

  assert.equal(inspection.fileName, 'multi_sheet_journals.xlsx');
  assert.deepEqual(inspection.sheetNames, ['قيود مايو', 'May Sheet 2']);
  assert.equal(inspection.sheets.length, 2);
  assert.equal(inspection.sheets[0].totalRawDataRows, 2);
  assert.equal(inspection.sheets[1].totalRawDataRows, 2);
  assert.equal(inspection.sheets[0].detectedMapping.account_code, 3);
  assert.equal(inspection.sheets[1].detectedMapping.account_code, 3);

  const parsedSheet1 = parseJournalImportSheetFromWorkbook(wb, 'قيود مايو');
  assert.equal(parsedSheet1.rows.length, 2);
});

test('generateJournalImportTemplateBuffer produces a valid readable XLSX template', () => {
  const { buffer, filename } = generateJournalImportTemplateBuffer();
  assert.ok(filename.endsWith('.xlsx'));
  assert.ok(buffer.length > 0);
  const wb = XLSX.read(buffer, { type: 'buffer' });
  assert.ok(wb.SheetNames.length >= 1);
});
