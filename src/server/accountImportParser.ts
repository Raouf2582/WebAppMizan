import * as XLSX from 'xlsx';
import type {
  AccountImportColumnMapping,
  AccountImportDetectedColumn,
  AccountImportFieldKey,
} from '../shared/types.ts';
import { AppError } from './errors.ts';

export interface ParsedExcelRow {
  excelRowNumber: number; // 1-based row number in Excel
  cells: string[]; // indexed by column index 0..N-1
}

export interface ParsedExcelSheetResult {
  fileName: string;
  sheetNames: string[];
  selectedSheet: string;
  headerRowNumber: number; // 1-based
  dataStartRowNumber: number; // 1-based
  columns: AccountImportDetectedColumn[];
  detectedMapping: AccountImportColumnMapping;
  rows: ParsedExcelRow[];
  parseWarnings: string[];
  blankRowsSkipped: number;
  mergedBannerRowsSkipped: number;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const FIELD_HEADER_SYNONYMS: Record<AccountImportFieldKey, string[]> = {
  code: [
    'code',
    'account code',
    'account_code',
    'acct code',
    'account no',
    'account number',
    'رمز الحساب',
    'كود الحساب',
    'رقم الحساب',
    'الرمز',
    'كود',
    'رمز',
  ],
  name_ar: [
    'name',
    'account name',
    'account_name',
    'name ar',
    'name_ar',
    'arabic name',
    'account title',
    'اسم الحساب',
    'اسم الحساب بالعربيه',
    'اسم الحساب بالعربية',
    'الاسم',
    'بيان الحساب',
  ],
  parent_code: [
    'parent code',
    'parent_code',
    'parent account code',
    'parent_account_code',
    'parent account no',
    'parent no',
    'parent id',
    'parent account - code',
    'parent - code',
    'رمز الحساب الاب',
    'رمز الحساب الأب',
    'كود الحساب الاب',
    'كود الحساب الأب',
    'رقم الحساب الاب',
    'رقم الحساب الأب',
    'رمز الاب',
    'رمز الأب',
    'كود الاب',
    'كود الأب',
    'الحساب الاب',
    'الحساب الأب',
    'رمز الحساب الرئيسي',
    'الحساب الاب - الرمز',
    'الحساب الأب - الرمز',
    'الحساب الاب - رمز الحساب',
    'الحساب الأب - رمز الحساب',
  ],
  parent_name: [
    'parent name',
    'parent_name',
    'parent account name',
    'parent_account_name',
    'parent title',
    'parent account - name',
    'parent - name',
    'اسم الحساب الاب',
    'اسم الحساب الأب',
    'اسم الاب',
    'اسم الأب',
    'اسم الحساب الرئيسي',
    'الحساب الاب - الاسم',
    'الحساب الأب - الاسم',
    'الحساب الاب - اسم الحساب',
    'الحساب الأب - اسم الحساب',
  ],
  level: [
    'level',
    'account level',
    'account_level',
    'hierarchy level',
    'depth',
    'المستوي',
    'المستوى',
    'مستوي الحساب',
    'مستوى الحساب',
    'المستوي الهرمي',
    'المستوى الهرمي',
    'الرتبه',
    'الرتبة',
  ],
  account_type: [
    'account type',
    'account_type',
    'accounting type',
    'accounting_type',
    'type',
    'classification',
    'category',
    'نوع الحساب',
    'النوع المحاسبي',
    'التصنيف المحاسبي',
    'التصنيف',
    'النوع',
    'الفئه',
    'الفئة',
  ],
  normal_balance: [
    'nature',
    'account nature',
    'normal balance',
    'normal_balance',
    'balance nature',
    'balance side',
    'side',
    'طبيعه الحساب',
    'طبيعة الحساب',
    'الطبيعه',
    'الطبيعة',
    'الرصيد الطبيعي',
    'الطبيعه المحاسبيه',
    'الطبيعة المحاسبية',
  ],
  is_postable: [
    'posting level',
    'posting_level',
    'is postable',
    'is_postable',
    'postable',
    'allow posting',
    'posting',
    'مستوي الترحيل',
    'مستوى الترحيل',
    'قابل للترحيل',
    'يقبل الترحيل',
    'التصنيف الترحيلي',
    'نوع الترحيل',
    'ترحيل',
  ],
  status: [
    'status',
    'account status',
    'state',
    'active',
    'الحاله',
    'الحالة',
    'حاله الحساب',
    'حالة الحساب',
    'التفعيل',
  ],
  cost_center_required: [
    'cost center required',
    'cost_center_required',
    'require cost center',
    'cost center',
    'الزاميه مركز التكلفه',
    'إلزامية مركز التكلفة',
    'مركز التكلفه الزامي',
    'مركز التكلفة إلزامي',
    'يتطلب مركز تكلفه',
    'يتطلب مركز تكلفة',
    'مركز التكلفه',
    'مركز التكلفة',
  ],
};

export function normalizeHeaderText(input: string): string {
  return input
    .trim()
    .toLowerCase()
    // Strip Arabic diacritics & tatweel
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    // Normalize Alef / Teh Marbuta / Alef Maksura
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    // Replace separators with spaces
    .replace(/[_/\\:()[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALIZED_SYNONYMS: Record<AccountImportFieldKey, Set<string>> = Object.fromEntries(
  (Object.keys(FIELD_HEADER_SYNONYMS) as AccountImportFieldKey[]).map((key) => [
    key,
    new Set(FIELD_HEADER_SYNONYMS[key].map((s) => normalizeHeaderText(s))),
  ]),
) as Record<AccountImportFieldKey, Set<string>>;

function matchHeaderToField(header: string): AccountImportFieldKey | null {
  const norm = normalizeHeaderText(header);
  if (!norm) return null;

  // Exact normalized match first
  for (const field of Object.keys(NORMALIZED_SYNONYMS) as AccountImportFieldKey[]) {
    if (NORMALIZED_SYNONYMS[field].has(norm)) {
      return field;
    }
  }

  // Fallback substring match for longer descriptive headers (ordered carefully so parent_* wins over code/name)
  const orderedFields: AccountImportFieldKey[] = [
    'parent_code',
    'parent_name',
    'cost_center_required',
    'normal_balance',
    'is_postable',
    'account_type',
    'level',
    'status',
    'code',
    'name_ar',
  ];

  for (const field of orderedFields) {
    for (const syn of NORMALIZED_SYNONYMS[field]) {
      if (syn.length >= 4 && (norm === syn || norm.includes(syn))) {
        return field;
      }
    }
  }

  return null;
}

export function detectColumnMapping(headers: string[]): AccountImportColumnMapping {
  const mapping: AccountImportColumnMapping = {};
  const usedIndices = new Set<number>();

  // Pass 1: exact matches
  headers.forEach((header, idx) => {
    const norm = normalizeHeaderText(header);
    if (!norm) return;
    for (const field of Object.keys(NORMALIZED_SYNONYMS) as AccountImportFieldKey[]) {
      if (mapping[field] === undefined && NORMALIZED_SYNONYMS[field].has(norm)) {
        mapping[field] = idx;
        usedIndices.add(idx);
        break;
      }
    }
  });

  // Pass 2: partial matches for unmapped fields
  headers.forEach((header, idx) => {
    if (usedIndices.has(idx)) return;
    const matched = matchHeaderToField(header);
    if (matched && mapping[matched] === undefined) {
      mapping[matched] = idx;
      usedIndices.add(idx);
    }
  });

  return mapping;
}

function readCellText(ws: XLSX.WorkSheet, r: number, c: number): string {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr] as XLSX.CellObject | undefined;
  if (!cell || cell.v === undefined || cell.v === null) return '';

  if (cell.t === 'n' && typeof cell.v === 'number') {
    // Preserve integer codes without thousands separators like "1,101"
    if (Number.isInteger(cell.v)) {
      return String(cell.v);
    }
    return String(cell.v);
  }
  if (cell.t === 'b') {
    return cell.v ? 'TRUE' : 'FALSE';
  }
  if (typeof cell.w === 'string' && cell.w.trim().length > 0 && cell.t === 's') {
    return cell.w.trim();
  }
  return String(cell.v).trim();
}

export function validateAndDecodeWorkbook(
  fileName: string,
  fileBase64: string,
): { workbook: XLSX.WorkBook; sheetNames: string[] } {
  const cleanName = (fileName || '').trim();
  const lower = cleanName.toLowerCase();
  if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
    throw new AppError(
      400,
      'صيغة الملف غير مدعومة. يرجى رفع ملف Excel بصيغة .xlsx أو .xls فقط.',
      'UNSUPPORTED_FILE_TYPE',
    );
  }

  if (!fileBase64 || typeof fileBase64 !== 'string') {
    throw new AppError(400, 'محتوى الملف فارغ أو غير صالح.', 'EMPTY_FILE');
  }

  // Strip optional data URI prefix
  const base64Payload = fileBase64.includes(',') ? fileBase64.split(',').pop() || '' : fileBase64;
  const buffer = Buffer.from(base64Payload, 'base64');

  if (buffer.length === 0) {
    throw new AppError(400, 'الملف المرفق فارغ.', 'EMPTY_FILE');
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new AppError(
      400,
      'حجم الملف يتجاوز الحد الأقصى المسموح به (10 ميجابايت).',
      'FILE_TOO_LARGE',
    );
  }

  // Check magic bytes for ZIP (.xlsx -> PK) or OLE2 (.xls -> D0 CF 11 E0)
  const isZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isOle2 =
    buffer.length >= 4 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0;

  if (!isZip && !isOle2) {
    throw new AppError(
      400,
      'الملف المرفق تالف أو لا يطابق بنية ملفات Excel (.xlsx / .xls).',
      'CORRUPTED_EXCEL_FILE',
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellDates: false,
      cellNF: false,
      cellText: true,
    });
  } catch {
    throw new AppError(
      400,
      'تعذر قراءة ملف Excel. قد يكون الملف تالفاً أو محمياً بكلمة مرور.',
      'CORRUPTED_EXCEL_FILE',
    );
  }

  const sheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
  if (sheetNames.length === 0) {
    throw new AppError(400, 'ملف Excel لا يحتوي على أي أوراق عمل.', 'EMPTY_WORKBOOK');
  }

  return { workbook, sheetNames };
}

export function parseAccountImportSheet(
  fileName: string,
  fileBase64: string,
  requestedSheetName?: string,
): ParsedExcelSheetResult {
  const { workbook, sheetNames } = validateAndDecodeWorkbook(fileName, fileBase64);
  const selectedSheet =
    requestedSheetName && sheetNames.includes(requestedSheetName)
      ? requestedSheetName
      : sheetNames[0];

  if (requestedSheetName && !sheetNames.includes(requestedSheetName)) {
    throw new AppError(
      400,
      `ورقة العمل المحددة "${requestedSheetName}" غير موجودة في الملف.`,
      'SHEET_NOT_FOUND',
    );
  }

  const ws = workbook.Sheets[selectedSheet];
  if (!ws || !ws['!ref']) {
    throw new AppError(400, `ورقة العمل "${selectedSheet}" فارغة ولا تحتوي على بيانات.`, 'EMPTY_SHEET');
  }

  const range = XLSX.utils.decode_range(ws['!ref']);
  const totalCols = Math.min(range.e.c + 1, 60); // guard extreme trailing phantom columns
  const maxRow = range.e.r;

  const merges: XLSX.Range[] = Array.isArray(ws['!merges']) ? ws['!merges'] : [];
  const parseWarnings: string[] = [];

  // Helper: check if cell (r, c) is covered by a merge (and not the top-left origin)
  function findMergeAt(r: number, c: number): XLSX.Range | undefined {
    return merges.find((m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c);
  }

  function isBannerRow(r: number): boolean {
    const rowMerges = merges.filter((m) => m.s.r <= r && m.e.r >= r && m.e.c - m.s.c >= 2);
    if (rowMerges.length === 0) return false;
    let nonEmpty = 0;
    for (let c = 0; c < totalCols; c++) {
      if (readCellText(ws, r, c)) nonEmpty++;
    }
    return nonEmpty <= 1;
  }

  // Evaluate single-row and 2-row composite header candidates within first 20 rows
  let bestScore = -1;
  let bestIsTwoRow = false;
  let bestHeaderStartRow = 0;
  let bestHeaders: string[] = [];

  const scanLimit = Math.min(maxRow, 20);
  for (let r = 0; r <= scanLimit; r++) {
    if (isBannerRow(r)) continue;

    // Single-row headers at r
    const singleHeaders: string[] = [];
    for (let c = 0; c < totalCols; c++) {
      const m = findMergeAt(r, c);
      if (m && (m.s.r !== r || m.s.c !== c)) {
        // Horizontal merge in header without subheader below: leave secondary blank unless composite
        singleHeaders.push('');
      } else {
        singleHeaders.push(readCellText(ws, r, c));
      }
    }
    const singleNonEmpty = singleHeaders.filter((h) => h.length > 0).length;
    if (singleNonEmpty >= 2) {
      const singleMapping = detectColumnMapping(singleHeaders);
      const singleScore = Object.keys(singleMapping).length * 10 + (singleMapping.code !== undefined ? 5 : 0) + (singleMapping.name_ar !== undefined ? 5 : 0);
      if (singleScore > bestScore) {
        bestScore = singleScore;
        bestIsTwoRow = false;
        bestHeaderStartRow = r;
        bestHeaders = singleHeaders;
      }
    }

    // 2-row partially merged header at (r, r + 1)
    if (r + 1 <= scanLimit && !isBannerRow(r + 1)) {
      const hasVerticalOrGroupMerge = merges.some(
        (m) =>
          (m.s.r === r && m.e.r === r + 1) ||
          (m.s.r === r && m.e.r === r && m.e.c > m.s.c && m.e.c - m.s.c <= 3),
      );
      if (hasVerticalOrGroupMerge) {
        const twoRowHeaders: string[] = [];
        for (let c = 0; c < totalCols; c++) {
          const mTop = findMergeAt(r, c);
          const topVal = mTop ? readCellText(ws, mTop.s.r, mTop.s.c) : readCellText(ws, r, c);
          const mBot = findMergeAt(r + 1, c);
          const botVal =
            mBot && mBot.s.r === r && mBot.e.r === r + 1
              ? '' // vertically merged from row r
              : readCellText(ws, r + 1, c);

          if (topVal && botVal && topVal !== botVal) {
            twoRowHeaders.push(`${topVal} - ${botVal}`);
          } else {
            twoRowHeaders.push(botVal || topVal);
          }
        }
        const twoNonEmpty = twoRowHeaders.filter((h) => h.length > 0).length;
        if (twoNonEmpty >= 2) {
          const twoMapping = detectColumnMapping(twoRowHeaders);
          const twoScore =
            Object.keys(twoMapping).length * 10 +
            (twoMapping.code !== undefined ? 5 : 0) +
            (twoMapping.name_ar !== undefined ? 5 : 0);
          if (twoScore > bestScore) {
            bestScore = twoScore;
            bestIsTwoRow = true;
            bestHeaderStartRow = r;
            bestHeaders = twoRowHeaders;
          }
        }
      }
    }
  }

  // Fallback if no synonym matched: pick first row with >= 2 non-empty cells
  if (bestScore < 0) {
    for (let r = 0; r <= scanLimit; r++) {
      if (isBannerRow(r)) continue;
      const rowVals = Array.from({ length: totalCols }, (_, c) => readCellText(ws, r, c));
      if (rowVals.filter((v) => v.length > 0).length >= 2) {
        bestHeaderStartRow = r;
        bestIsTwoRow = false;
        bestHeaders = rowVals;
        break;
      }
    }
  }

  if (bestHeaders.length === 0) {
    throw new AppError(
      400,
      `تعذر اكتشاف صف العناوين في ورقة العمل "${selectedSheet}". تأكد من وجود جدول حسابات واضح.`,
      'NO_HEADER_FOUND',
    );
  }

  const headerEndRow = bestIsTwoRow ? bestHeaderStartRow + 1 : bestHeaderStartRow;
  const dataStartRow = headerEndRow + 1;

  // Trim trailing completely empty columns
  let activeColCount = bestHeaders.length;
  while (activeColCount > 0) {
    const c = activeColCount - 1;
    let hasAny = bestHeaders[c].length > 0;
    if (!hasAny) {
      for (let r = dataStartRow; r <= maxRow; r++) {
        if (readCellText(ws, r, c).length > 0) {
          hasAny = true;
          break;
        }
      }
    }
    if (hasAny) break;
    activeColCount--;
  }

  if (activeColCount === 0) {
    throw new AppError(400, `ورقة العمل "${selectedSheet}" لا تحتوي على أعمدة صالحة.`, 'EMPTY_SHEET');
  }

  const trimmedHeaders = bestHeaders.slice(0, activeColCount).map((h, i) => h || `عمود ${i + 1}`);
  if (bestIsTwoRow) {
    parseWarnings.push(
      `تم اكتشاف ترويسة مركبة من صفين (الصف ${bestHeaderStartRow + 1} و ${headerEndRow + 1}) ومعالجة الخلايا المدمجة بأمان.`,
    );
  }

  const rows: ParsedExcelRow[] = [];
  let blankRowsSkipped = 0;
  let mergedBannerRowsSkipped = 0;
  const verticalMergeRowsNoted = new Set<number>();
  const horizontalMergeRowsNoted = new Set<number>();

  for (let r = dataStartRow; r <= maxRow; r++) {
    // Check if row is a wide horizontal merged section divider / totals banner
    const wideHorizontalMerge = merges.find(
      (m) => m.s.r <= r && m.e.r >= r && m.e.c - m.s.c >= 2,
    );

    const rowCells: string[] = [];
    let nonEmptyCount = 0;
    for (let c = 0; c < activeColCount; c++) {
      const m = findMergeAt(r, c);
      if (m) {
        // Never duplicate merged cell values into secondary cells
        if (m.s.r === r && m.s.c === c) {
          const val = readCellText(ws, r, c);
          rowCells.push(val);
          if (val) nonEmptyCount++;
          if (m.e.r > m.s.r && !wideHorizontalMerge) {
            verticalMergeRowsNoted.add(r + 1);
          } else if (m.e.c > m.s.c && m.e.c - m.s.c < 2) {
            horizontalMergeRowsNoted.add(r + 1);
          }
        } else {
          rowCells.push('');
          if (m.e.r > m.s.r && !wideHorizontalMerge) {
            verticalMergeRowsNoted.add(r + 1);
          }
        }
      } else {
        const val = readCellText(ws, r, c);
        rowCells.push(val);
        if (val) nonEmptyCount++;
      }
    }

    if (nonEmptyCount === 0) {
      blankRowsSkipped++;
      continue;
    }

    if (wideHorizontalMerge && nonEmptyCount <= 1) {
      mergedBannerRowsSkipped++;
      continue;
    }

    rows.push({
      excelRowNumber: r + 1,
      cells: rowCells,
    });
  }

  if (mergedBannerRowsSkipped > 0) {
    parseWarnings.push(
      `تم تخطي ${mergedBannerRowsSkipped} صف عنوان/ملخص مدمج أفقياً دون قراءته كحسابات.`,
    );
  }
  if (verticalMergeRowsNoted.size > 0) {
    const sample = [...verticalMergeRowsNoted].slice(0, 6).join('، ');
    parseWarnings.push(
      `تحتوي الصفوف (${sample}${verticalMergeRowsNoted.size > 6 ? '...' : ''}) على خلايا مدمجة عمودياً؛ تم منع تكرار البيانات تلقائياً ويجب مراجعة أي قيم ناقصة.`,
    );
  }
  if (horizontalMergeRowsNoted.size > 0) {
    const sample = [...horizontalMergeRowsNoted].slice(0, 6).join('، ');
    parseWarnings.push(
      `تم رصد خلايا مدمجة أفقياً في الصفوف (${sample}${horizontalMergeRowsNoted.size > 6 ? '...' : ''})؛ تم الحفاظ على القيمة في العمود الأول فقط دون تكرار.`,
    );
  }

  const columns: AccountImportDetectedColumn[] = trimmedHeaders.map((header, idx) => ({
    index: idx,
    header,
    sampleValues: rows
      .slice(0, 3)
      .map((row) => row.cells[idx] || '')
      .filter((v) => v.length > 0),
  }));

  const detectedMapping = detectColumnMapping(trimmedHeaders);

  return {
    fileName,
    sheetNames,
    selectedSheet,
    headerRowNumber: bestHeaderStartRow + 1,
    dataStartRowNumber: dataStartRow + 1,
    columns,
    detectedMapping,
    rows,
    parseWarnings,
    blankRowsSkipped,
    mergedBannerRowsSkipped,
  };
}
