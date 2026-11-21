import * as XLSX from 'xlsx';
import type {
  AccountImportDetectedColumn,
  JournalImportColumnMapping,
  JournalImportFieldKey,
  JournalImportInspectResult,
  JournalImportInspectSheet,
} from '../shared/types.ts';
import {
  normalizeHeaderText,
  validateAndDecodeWorkbook,
} from './accountImportParser.ts';
import { AppError } from './errors.ts';

export interface ParsedJournalSheetRow {
  excelRowNumber: number;
  cells: string[];
}

export interface ParsedJournalSheet {
  sheetName: string;
  headerRowNumber: number;
  dataStartRowNumber: number;
  columns: AccountImportDetectedColumn[];
  detectedMapping: JournalImportColumnMapping;
  rows: ParsedJournalSheetRow[];
  parseWarnings: string[];
}

const JOURNAL_FIELD_SYNONYMS: Record<JournalImportFieldKey, string[]> = {
  entry_group: [
    'entry group',
    'group',
    'group no',
    'entry no',
    'entry number',
    'journal no',
    'journal id',
    'voucher no',
    'رقم القيد',
    'رقم المجموعه',
    'رقم المجموعة',
    'المجموعه',
    'المجموعة',
    'تسلسل القيد',
    'رمز القيد',
  ],
  entry_date: [
    'date',
    'entry date',
    'posting date',
    'transaction date',
    'journal date',
    'التاريخ',
    'تاريخ القيد',
    'تاريخ الحركه',
    'تاريخ الحركة',
  ],
  description: [
    'description',
    'memo',
    'narration',
    'journal description',
    'header description',
    'البيان',
    'البيان العام',
    'الوصف',
    'شرح القيد',
  ],
  reference_number: [
    'reference',
    'ref',
    'reference number',
    'ref no',
    'document no',
    'المرجع',
    'الرقم المرجعي',
    'رقم المرجع',
    'رقم المستند',
  ],
  cost_center_code: [
    'cost center',
    'cost center code',
    'cost_center_code',
    'cc',
    'cc code',
    'مركز التكلفه',
    'مركز التكلفة',
    'رمز مركز التكلفه',
    'رمز مركز التكلفة',
    'كود مركز التكلفة',
  ],
  account_code: [
    'account',
    'account code',
    'account_code',
    'acct code',
    'account no',
    'gl account',
    'الحساب',
    'رمز الحساب',
    'رقم الحساب',
    'كود الحساب',
  ],
  debit: ['debit', 'dr', 'debit amount', 'مدين', 'المبلغ المدين', 'المدين'],
  credit: ['credit', 'cr', 'credit amount', 'دائن', 'المبلغ الدائن', 'الدائن'],
  line_description: [
    'line description',
    'line memo',
    'line note',
    'note',
    'details',
    'بيان السطر',
    'ملاحظة السطر',
    'ملاحظه السطر',
    'ملاحظات',
    'تفاصيل السطر',
  ],
};

const NORMALIZED_JOURNAL_SYNONYMS: Record<JournalImportFieldKey, Set<string>> = Object.fromEntries(
  (Object.keys(JOURNAL_FIELD_SYNONYMS) as JournalImportFieldKey[]).map((key) => [
    key,
    new Set(JOURNAL_FIELD_SYNONYMS[key].map((s) => normalizeHeaderText(s))),
  ]),
) as Record<JournalImportFieldKey, Set<string>>;

function normalizeArabicDigits(str: string): string {
  return str
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function cellToTrimmedString(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const y = val.getUTCFullYear();
    const m = String(val.getUTCMonth() + 1).padStart(2, '0');
    const d = String(val.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return normalizeArabicDigits(String(val)).trim();
}

export function normalizeExcelDateString(raw: string): string | null {
  const s = normalizeArabicDigits(raw).trim();
  if (!s) return null;

  // ISO YYYY-MM-DD
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // YYYY/MM/DD
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split('/').map(Number);
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3]);
    if (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // Excel serial number (e.g. 45658)
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (num >= 20000 && num <= 80000) {
      const serialEpochMs = Date.UTC(1899, 11, 30);
      const dt = new Date(serialEpochMs + Math.floor(num) * 86400000);
      if (!Number.isNaN(dt.getTime())) {
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const d = String(dt.getUTCDate()).padStart(2, '0');
        return `${String(y).padStart(4, '0')}-${m}-${d}`;
      }
    }
  }

  return null;
}

export function detectJournalColumnMapping(headers: string[]): JournalImportColumnMapping {
  const mapping: JournalImportColumnMapping = {};
  const used = new Set<number>();

  headers.forEach((h, idx) => {
    const norm = normalizeHeaderText(h);
    if (!norm) return;
    for (const field of Object.keys(NORMALIZED_JOURNAL_SYNONYMS) as JournalImportFieldKey[]) {
      if (mapping[field] === undefined && NORMALIZED_JOURNAL_SYNONYMS[field].has(norm)) {
        mapping[field] = idx;
        used.add(idx);
        break;
      }
    }
  });

  const ordered: JournalImportFieldKey[] = [
    'entry_group',
    'entry_date',
    'line_description',
    'description',
    'reference_number',
    'cost_center_code',
    'account_code',
    'debit',
    'credit',
  ];

  headers.forEach((h, idx) => {
    if (used.has(idx)) return;
    const norm = normalizeHeaderText(h);
    if (!norm) return;
    for (const field of ordered) {
      if (mapping[field] !== undefined) continue;
      for (const syn of NORMALIZED_JOURNAL_SYNONYMS[field]) {
        if (syn.length >= 4 && norm.includes(syn)) {
          mapping[field] = idx;
          used.add(idx);
          break;
        }
      }
      if (used.has(idx)) break;
    }
  });

  return mapping;
}

export function parseJournalImportSheetFromWorkbook(
  workbook: XLSX.WorkBook,
  sheetName: string,
): ParsedJournalSheet {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new AppError(400, `ورقة العمل "${sheetName}" غير موجودة في الملف.`, 'SHEET_NOT_FOUND');
  }

  const rawAoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: true,
    blankrows: false,
  }) as unknown[][];

  if (!rawAoa || rawAoa.length === 0) {
    return {
      sheetName,
      headerRowNumber: 1,
      dataStartRowNumber: 2,
      columns: [],
      detectedMapping: {},
      rows: [],
      parseWarnings: [`ورقة العمل "${sheetName}" فارغة.`],
    };
  }

  // Locate header row among top 10 rows based on journal synonym match count
  let headerIdx = 0;
  let bestScore = -1;
  const maxScan = Math.min(10, rawAoa.length);
  for (let r = 0; r < maxScan; r++) {
    const row = rawAoa[r] || [];
    const cells = row.map((v) => cellToTrimmedString(v));
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length < 3) continue;
    let score = 0;
    for (const c of nonEmpty) {
      const norm = normalizeHeaderText(c);
      for (const field of Object.keys(NORMALIZED_JOURNAL_SYNONYMS) as JournalImportFieldKey[]) {
        if (NORMALIZED_JOURNAL_SYNONYMS[field].has(norm)) {
          score += 3;
          break;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      headerIdx = r;
    }
  }

  const headerRow = (rawAoa[headerIdx] || []).map((v) => cellToTrimmedString(v));
  const maxCol = Math.max(headerRow.length, 1);
  const headers = Array.from({ length: maxCol }, (_, i) => headerRow[i] || `عمود ${i + 1}`);
  const detectedMapping = detectJournalColumnMapping(headers);

  const rows: ParsedJournalSheetRow[] = [];
  for (let r = headerIdx + 1; r < rawAoa.length; r++) {
    const raw = rawAoa[r] || [];
    const cells = Array.from({ length: maxCol }, (_, c) => cellToTrimmedString(raw[c]));
    if (cells.every((c) => c === '')) continue;
    rows.push({
      excelRowNumber: r + 1,
      cells,
    });
  }

  const columns: AccountImportDetectedColumn[] = headers.map((header, idx) => ({
    index: idx,
    header,
    sampleValues: rows
      .map((row) => row.cells[idx] || '')
      .filter(Boolean)
      .slice(0, 3),
  }));

  return {
    sheetName,
    headerRowNumber: headerIdx + 1,
    dataStartRowNumber: headerIdx + 2,
    columns,
    detectedMapping,
    rows,
    parseWarnings: [],
  };
}

export function inspectJournalImportWorkbook(
  fileName: string,
  fileBase64: string,
): JournalImportInspectResult {
  const cleanName = fileName.trim();
  const { workbook } = validateAndDecodeWorkbook(cleanName, fileBase64);
  const sheets: JournalImportInspectSheet[] = workbook.SheetNames.map((name) => {
    const parsed = parseJournalImportSheetFromWorkbook(workbook, name);
    return {
      sheetName: parsed.sheetName,
      headerRowNumber: parsed.headerRowNumber,
      dataStartRowNumber: parsed.dataStartRowNumber,
      totalRawDataRows: parsed.rows.length,
      columns: parsed.columns,
      detectedMapping: parsed.detectedMapping,
      parseWarnings: parsed.parseWarnings,
    };
  });

  return {
    fileName: cleanName,
    sheetNames: workbook.SheetNames,
    sheets,
  };
}
