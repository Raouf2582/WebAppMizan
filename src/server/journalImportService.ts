import Decimal from 'decimal.js';
import * as XLSX from 'xlsx';
import { validateDoubleEntryLines } from '../shared/accounting.ts';
import type {
  Account,
  AccountingPeriod,
  CostCenter,
  JournalImportBatch,
  JournalImportBatchDetailItem,
  JournalImportBatchDetailsResponse,
  JournalImportBatchLinkedEntry,
  JournalImportBatchStatus,
  JournalImportColumnMapping,
  JournalImportDeletionAuditLog,
  JournalImportDeletionMode,
  JournalImportExecuteResult,
  JournalImportPreviewEntry,
  JournalImportPreviewLine,
  JournalImportPreviewResult,
} from '../shared/types.ts';
import { validateAndDecodeWorkbook } from './accountImportParser.ts';
import { dbQuery, withTransaction } from './db.ts';
import { AppError } from './errors.ts';
import {
  normalizeExcelDateString,
  parseJournalImportSheetFromWorkbook,
} from './journalImportParser.ts';
import { fetchAllAccounts, fetchAllCostCenters } from './reports.ts';

interface InternalPlannedEntry extends JournalImportPreviewEntry {
  resolvedCostCenterId: string | null;
  resolvedLines: Array<{
    account_id: string;
    cost_center_id: string | null;
    debit: number;
    credit: number;
    description: string | null;
  }>;
}

function parseMoneyCell(raw: string): { value: number; valid: boolean } {
  const cleaned = raw.replace(/,/g, '').replace(/\s+/g, '').trim();
  if (!cleaned) return { value: 0, valid: true };
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { value: 0, valid: false };
  }
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) {
    return { value: 0, valid: false };
  }
  return { value: new Decimal(num).toDecimalPlaces(2).toNumber(), valid: true };
}

function getCell(cells: string[], idx: number | null | undefined): string {
  if (idx === null || idx === undefined || idx < 0 || idx >= cells.length) return '';
  return (cells[idx] ?? '').trim();
}

export function generateJournalImportTemplateBuffer(): {
  buffer: Buffer;
  filename: string;
} {
  const headers = [
    'رقم المجموعة / القيد',
    'تاريخ القيد',
    'البيان العام',
    'رمز مركز التكلفة',
    'الرقم المرجعي',
    'رمز الحساب',
    'مدين',
    'دائن',
    'بيان السطر',
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(h.length + 6, 18) }));
  XLSX.utils.book_append_sheet(wb, ws, 'القيود_اليومية');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return { buffer, filename: 'journal_entries_import_template.xlsx' };
}

async function fetchPeriods(): Promise<AccountingPeriod[]> {
  const { rows } = await dbQuery<AccountingPeriod>(
    'SELECT * FROM public.accounting_periods ORDER BY start_date ASC',
  );
  return rows;
}

async function buildJournalImportPlan(options: {
  fileName: string;
  fileBase64: string;
  sheetNames: string[];
  mappingsBySheet: Record<string, JournalImportColumnMapping>;
}): Promise<{
  preview: JournalImportPreviewResult;
  plannedEntries: InternalPlannedEntry[];
}> {
  const cleanName = options.fileName.trim();
  const { workbook } = validateAndDecodeWorkbook(cleanName, options.fileBase64);

  const [accounts, costCenters, periods] = await Promise.all([
    fetchAllAccounts(),
    fetchAllCostCenters(),
    fetchPeriods(),
  ]);

  const accountById = new Map<string, Account>(accounts.map((a) => [a.id, a]));
  const accountByCode = new Map<string, Account>(
    accounts.map((a) => [a.code.trim().toUpperCase(), a]),
  );
  const ccById = new Map<string, CostCenter>(costCenters.map((c) => [c.id, c]));
  const ccByCode = new Map<string, CostCenter>(
    costCenters.map((c) => [c.code.trim().toUpperCase(), c]),
  );

  let totalRows = 0;
  const plannedEntries: InternalPlannedEntry[] = [];

  for (const sheetName of options.sheetNames) {
    const parsed = parseJournalImportSheetFromWorkbook(workbook, sheetName);
    const mapping = options.mappingsBySheet[sheetName] || parsed.detectedMapping;

    if (
      mapping.entry_date === undefined ||
      mapping.entry_date === null ||
      mapping.account_code === undefined ||
      mapping.account_code === null ||
      mapping.debit === undefined ||
      mapping.debit === null ||
      mapping.credit === undefined ||
      mapping.credit === null
    ) {
      throw new AppError(
        400,
        `في ورقة "${sheetName}": يجب ربط الأعمدة الأساسية (تاريخ القيد، رمز الحساب، مدين، دائن) على الأقل.`,
        'MISSING_COLUMN_MAPPING',
      );
    }

    totalRows += parsed.rows.length;

    const groups = new Map<
      string,
      {
        groupKey: string;
        rows: Array<{
          excelRowNumber: number;
          rawDate: string;
          description: string;
          referenceNumber: string;
          costCenterCode: string;
          accountCode: string;
          rawDebit: string;
          rawCredit: string;
          lineDescription: string;
        }>;
      }
    >();

    for (const row of parsed.rows) {
      const explicitGroup = getCell(row.cells, mapping.entry_group);
      const rawDate = getCell(row.cells, mapping.entry_date);
      const desc = getCell(row.cells, mapping.description);
      const refNo = getCell(row.cells, mapping.reference_number);
      const ccCode = getCell(row.cells, mapping.cost_center_code);
      const accCode = getCell(row.cells, mapping.account_code);
      const rawDebit = getCell(row.cells, mapping.debit);
      const rawCredit = getCell(row.cells, mapping.credit);
      const lineDesc = getCell(row.cells, mapping.line_description);

      const groupKey = explicitGroup
        ? `${sheetName}::${explicitGroup}`
        : `${sheetName}::${rawDate}::${refNo}::${desc}`;

      let bucket = groups.get(groupKey);
      if (!bucket) {
        bucket = { groupKey: explicitGroup || `${sheetName} #${groups.size + 1}`, rows: [] };
        groups.set(groupKey, bucket);
      }
      bucket.rows.push({
        excelRowNumber: row.excelRowNumber,
        rawDate,
        description: desc,
        referenceNumber: refNo,
        costCenterCode: ccCode,
        accountCode: accCode,
        rawDebit,
        rawCredit,
        lineDescription: lineDesc,
      });
    }

    for (const bucket of groups.values()) {
      const errors: string[] = [];
      const rowNumbers = bucket.rows.map((r) => r.excelRowNumber);

      const firstDateRaw = bucket.rows.find((r) => r.rawDate)?.rawDate || '';
      const entryDate = normalizeExcelDateString(firstDateRaw) || '';
      if (!entryDate) {
        errors.push(`تاريخ القيد غير صالح أو مفقود ("${firstDateRaw || '-'}").`);
      }

      // Verify consistent dates across rows of same group
      for (const r of bucket.rows) {
        if (r.rawDate) {
          const norm = normalizeExcelDateString(r.rawDate);
          if (norm && entryDate && norm !== entryDate) {
            errors.push(`الصف ${r.excelRowNumber}: اختلاف تاريخ القيد داخل نفس المجموعة.`);
          }
        }
      }

      // Check open accounting period
      if (entryDate) {
        const period = periods.find(
          (p) => entryDate >= p.start_date && entryDate <= p.end_date,
        );
        if (!period) {
          errors.push(`لا توجد فترة محاسبية تغطي التاريخ ${entryDate}.`);
        } else if (period.status !== 'OPEN') {
          errors.push(`الفترة المحاسبية للتاريخ ${entryDate} (${period.name_ar}) مغلقة.`);
        }
      }

      const description =
        bucket.rows.find((r) => r.description)?.description ||
        `قيد مستورد (${bucket.groupKey})`;
      if (description.trim().length < 2) {
        errors.push('البيان العام للقيد يجب أن يحتوي على حرفين على الأقل.');
      }

      const referenceNumber = bucket.rows.find((r) => r.referenceNumber)?.referenceNumber || null;

      // Header-level cost center consistency
      const nonEmptyCostCenters = [
        ...new Set(bucket.rows.map((r) => r.costCenterCode.toUpperCase()).filter(Boolean)),
      ];
      let resolvedCostCenterId: string | null = null;
      let costCenterCode: string | null = null;
      let costCenterName: string | null = null;

      if (nonEmptyCostCenters.length > 1) {
        errors.push('تم تحديد أكثر من مركز تكلفة داخل نفس القيد؛ يجب توحيد مركز التكلفة على مستوى رأس القيد.');
      } else if (nonEmptyCostCenters.length === 1) {
        costCenterCode = nonEmptyCostCenters[0];
        const cc = ccByCode.get(costCenterCode);
        if (!cc) {
          errors.push(`مركز التكلفة "${costCenterCode}" غير موجود في النظام.`);
        } else if (cc.status !== 'ACTIVE') {
          errors.push(`مركز التكلفة "${costCenterCode}" غير نشط.`);
        } else {
          resolvedCostCenterId = cc.id;
          costCenterName = cc.name_ar;
        }
      }

      const previewLines: JournalImportPreviewLine[] = [];
      const resolvedLines: InternalPlannedEntry['resolvedLines'] = [];
      let totalDebit = new Decimal(0);
      let totalCredit = new Decimal(0);

      for (const r of bucket.rows) {
        const debitParsed = parseMoneyCell(r.rawDebit);
        const creditParsed = parseMoneyCell(r.rawCredit);

        if (!debitParsed.valid) {
          errors.push(`الصف ${r.excelRowNumber}: قيمة المدين "${r.rawDebit}" غير صالحة.`);
        }
        if (!creditParsed.valid) {
          errors.push(`الصف ${r.excelRowNumber}: قيمة الدائن "${r.rawCredit}" غير صالحة.`);
        }

        const acc = r.accountCode ? accountByCode.get(r.accountCode.toUpperCase()) : undefined;
        if (!r.accountCode) {
          errors.push(`الصف ${r.excelRowNumber}: رمز الحساب مفقود.`);
        } else if (!acc) {
          errors.push(`الصف ${r.excelRowNumber}: رمز الحساب "${r.accountCode}" غير موجود في شجرة الحسابات.`);
        }

        totalDebit = totalDebit.plus(debitParsed.value);
        totalCredit = totalCredit.plus(creditParsed.value);

        previewLines.push({
          excelRowNumber: r.excelRowNumber,
          accountCode: r.accountCode,
          accountName: acc ? acc.name_ar : null,
          debit: debitParsed.value,
          credit: creditParsed.value,
          description: r.lineDescription || null,
        });

        if (acc && debitParsed.valid && creditParsed.valid) {
          resolvedLines.push({
            account_id: acc.id,
            cost_center_id: resolvedCostCenterId,
            debit: debitParsed.value,
            credit: creditParsed.value,
            description: r.lineDescription || null,
          });
        }
      }

      if (errors.length === 0) {
        const doubleEntryCheck = validateDoubleEntryLines(
          resolvedLines,
          accountById,
          ccById,
        );
        if (!doubleEntryCheck.valid && doubleEntryCheck.error) {
          errors.push(doubleEntryCheck.error);
        }
      } else if (resolvedLines.length >= 2) {
        const doubleEntryCheck = validateDoubleEntryLines(
          resolvedLines,
          accountById,
          ccById,
        );
        if (!doubleEntryCheck.valid && doubleEntryCheck.error && !errors.includes(doubleEntryCheck.error)) {
          errors.push(doubleEntryCheck.error);
        }
      }

      plannedEntries.push({
        groupKey: bucket.groupKey,
        sheetName,
        excelRowNumbers: rowNumbers,
        entryDate,
        description,
        referenceNumber,
        costCenterCode,
        costCenterName,
        totalDebit: totalDebit.toDecimalPlaces(2).toNumber(),
        totalCredit: totalCredit.toDecimalPlaces(2).toNumber(),
        valid: errors.length === 0,
        errors,
        lines: previewLines,
        resolvedCostCenterId,
        resolvedLines,
      });
    }
  }

  const validEntriesCount = plannedEntries.filter((e) => e.valid).length;
  const rejectedEntriesCount = plannedEntries.length - validEntriesCount;

  return {
    preview: {
      fileName: cleanName,
      sheetNames: options.sheetNames,
      importedRows: totalRows,
      detectedEntriesCount: plannedEntries.length,
      validEntriesCount,
      rejectedEntriesCount,
      entries: plannedEntries.map(
        ({ resolvedCostCenterId: _cc, resolvedLines: _rl, ...publicEntry }) => publicEntry,
      ),
    },
    plannedEntries,
  };
}

export async function previewJournalImport(options: {
  fileName: string;
  fileBase64: string;
  sheetNames: string[];
  mappingsBySheet: Record<string, JournalImportColumnMapping>;
}): Promise<JournalImportPreviewResult> {
  const { preview } = await buildJournalImportPlan(options);
  return preview;
}

export async function executeJournalImport(options: {
  fileName: string;
  fileBase64: string;
  sheetNames: string[];
  mappingsBySheet: Record<string, JournalImportColumnMapping>;
  skipRejectedEntries: boolean;
  actorId: string;
}): Promise<JournalImportExecuteResult> {
  const { preview, plannedEntries } = await buildJournalImportPlan(options);

  if (plannedEntries.length === 0) {
    throw new AppError(
      400,
      'لم يتم اكتشاف أي قيود محاسبية في أوراق العمل المختارة.',
      'NO_JOURNAL_ENTRIES_DETECTED',
    );
  }

  if (!options.skipRejectedEntries && preview.rejectedEntriesCount > 0) {
    throw new AppError(
      400,
      `يوجد ${preview.rejectedEntriesCount} قيداً مرفوضاً. يرجى تصحيح الملف أو اختيار تخطي القيود المرفوضة.`,
      'REJECTED_JOURNAL_ENTRIES_EXIST',
    );
  }

  return withTransaction(async (client) => {
    const batchSeqRes = await client.query<{ batch_number: string }>(
      `SELECT public.next_document_number('journal_import', 'JIMP') AS batch_number`,
    );
    const batchNumber = batchSeqRes.rows[0].batch_number;

    const batchInsertRes = await client.query<{ id: string }>(
      `INSERT INTO public.journal_import_batches (
         batch_number, file_name, sheet_names, imported_rows,
         detected_entries_count, drafts_created_count, rejected_entries_count,
         status, generated_entry_numbers, details, performed_by
       ) VALUES ($1, $2, $3::TEXT[], $4, $5, 0, 0, 'COMPLETED', '{}'::TEXT[], '[]'::jsonb, $6)
       RETURNING id`,
      [
        batchNumber,
        preview.fileName,
        preview.sheetNames,
        preview.importedRows,
        preview.detectedEntriesCount,
        options.actorId,
      ],
    );
    const batchId = batchInsertRes.rows[0].id;

    const generatedEntryNumbers: string[] = [];
    const detailItems: JournalImportBatchDetailItem[] = [];
    let draftsCreatedCount = 0;
    let rejectedCount = 0;

    for (const entry of plannedEntries) {
      if (!entry.valid) {
        rejectedCount += 1;
        detailItems.push({
          groupKey: entry.groupKey,
          sheetName: entry.sheetName,
          excelRowNumbers: entry.excelRowNumbers,
          outcome: 'REJECTED',
          entryNumber: null,
          entryDate: entry.entryDate,
          description: entry.description,
          totalDebit: entry.totalDebit,
          totalCredit: entry.totalCredit,
          messages: entry.errors,
        });
        continue;
      }

      const rpcRes = await client.query<{ entry_id: string }>(
        `SELECT public.create_journal_entry_with_lines($1::DATE, $2::TEXT, $3::TEXT, $4::UUID, $5::JSONB, $6::UUID) AS entry_id`,
        [
          entry.entryDate,
          entry.description,
          entry.referenceNumber,
          options.actorId,
          JSON.stringify(entry.resolvedLines),
          entry.resolvedCostCenterId,
        ],
      );
      const createdEntryId = rpcRes.rows[0].entry_id;

      await client.query(
        `UPDATE public.journal_entries SET import_batch_id = $1 WHERE id = $2`,
        [batchId, createdEntryId],
      );

      const numRes = await client.query<{ entry_number: string }>(
        `SELECT entry_number FROM public.journal_entries WHERE id = $1`,
        [createdEntryId],
      );
      const entryNumber = numRes.rows[0].entry_number;

      generatedEntryNumbers.push(entryNumber);
      draftsCreatedCount += 1;
      detailItems.push({
        groupKey: entry.groupKey,
        sheetName: entry.sheetName,
        excelRowNumbers: entry.excelRowNumbers,
        outcome: 'CREATED',
        entryNumber,
        entryDate: entry.entryDate,
        description: entry.description,
        totalDebit: entry.totalDebit,
        totalCredit: entry.totalCredit,
        messages: ['تم إنشاء القيد كمسودة بنجاح'],
      });
    }

    const finalStatus: JournalImportBatchStatus =
      draftsCreatedCount === 0
        ? 'FAILED'
        : rejectedCount > 0
          ? 'COMPLETED_WITH_SKIPS'
          : 'COMPLETED';

    await client.query(
      `UPDATE public.journal_import_batches
       SET drafts_created_count = $1,
           rejected_entries_count = $2,
           status = $3,
           generated_entry_numbers = $4::TEXT[],
           details = $5::jsonb,
           error_message = $6
       WHERE id = $7`,
      [
        draftsCreatedCount,
        rejectedCount,
        finalStatus,
        generatedEntryNumbers,
        JSON.stringify(detailItems),
        finalStatus === 'FAILED' ? 'تم رفض جميع القيود المكتشفة لعدم استيفاء شروط التحقق المحاسبية.' : null,
        batchId,
      ],
    );

    const { rows: batchRows } = await client.query<JournalImportBatch>(
      `SELECT
         jib.*,
         jsonb_build_object('id', p.id, 'full_name', p.full_name, 'username', p.username) AS performer
       FROM public.journal_import_batches jib
       JOIN public.profiles p ON p.id = jib.performed_by
       WHERE jib.id = $1`,
      [batchId],
    );

    return {
      batch: batchRows[0],
      draftsCreatedCount,
      rejectedEntriesCount: rejectedCount,
      generatedEntryNumbers,
    };
  }, options.actorId);
}

export async function fetchJournalImportHistory(filters?: {
  search?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}): Promise<JournalImportBatch[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters?.search?.trim()) {
    conditions.push(`(jib.batch_number ILIKE $${idx} OR jib.file_name ILIKE $${idx})`);
    params.push(`%${filters.search.trim()}%`);
    idx++;
  }
  if (
    filters?.status === 'COMPLETED' ||
    filters?.status === 'COMPLETED_WITH_SKIPS' ||
    filters?.status === 'FAILED'
  ) {
    conditions.push(`jib.status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters?.startDate) {
    conditions.push(`(jib.created_at AT TIME ZONE 'UTC')::DATE >= $${idx++}::DATE`);
    params.push(filters.startDate);
  }
  if (filters?.endDate) {
    conditions.push(`(jib.created_at AT TIME ZONE 'UTC')::DATE <= $${idx++}::DATE`);
    params.push(filters.endDate);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await dbQuery<JournalImportBatch>(
    `SELECT
       jib.*,
       jsonb_build_object('id', p.id, 'full_name', p.full_name, 'username', p.username) AS performer,
       COALESCE(stats.live_total_entries, 0)::INT AS live_total_entries,
       COALESCE(stats.live_draft_entries, 0)::INT AS live_draft_entries,
       COALESCE(stats.live_posted_entries, 0)::INT AS live_posted_entries,
       COALESCE(stats.live_blocked_entries, 0)::INT AS live_blocked_entries,
       (COALESCE(stats.live_blocked_entries, 0) = 0) AS can_delete_with_entries,
       stats.delete_block_reason
     FROM public.journal_import_batches jib
     JOIN public.profiles p ON p.id = jib.performed_by
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*)::INT AS live_total_entries,
         COUNT(*) FILTER (WHERE je.status = 'DRAFT')::INT AS live_draft_entries,
         COUNT(*) FILTER (WHERE je.status = 'POSTED')::INT AS live_posted_entries,
         COUNT(*) FILTER (
           WHERE je.status <> 'DRAFT'
              OR ap.status = 'CLOSED'
              OR je.source_type <> 'MANUAL'
              OR je.source_voucher_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM public.vouchers v WHERE v.journal_entry_id = je.id)
              OR EXISTS (SELECT 1 FROM public.journal_entries rev WHERE rev.reversed_entry_id = je.id)
         )::INT AS live_blocked_entries,
         string_agg(
           CASE
             WHEN je.status <> 'DRAFT' THEN format('القيد %s مرحّل', je.entry_number)
             WHEN ap.status = 'CLOSED' THEN format('القيد %s في فترة مغلقة', je.entry_number)
             WHEN je.source_type <> 'MANUAL' OR je.source_voucher_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.vouchers v WHERE v.journal_entry_id = je.id)
               THEN format('القيد %s مرتبط بسند', je.entry_number)
             WHEN EXISTS (SELECT 1 FROM public.journal_entries rev WHERE rev.reversed_entry_id = je.id)
               THEN format('القيد %s مرتبط بقيد عكسي', je.entry_number)
             ELSE NULL
           END,
           '؛ '
         ) AS delete_block_reason
       FROM public.journal_entries je
       JOIN public.accounting_periods ap ON ap.id = je.period_id
       WHERE je.import_batch_id = jib.id
     ) stats ON true
     ${whereSql}
     ORDER BY jib.created_at DESC`,
    params,
  );

  return rows;
}

export async function fetchJournalImportBatchDetails(
  batchId: string,
): Promise<JournalImportBatchDetailsResponse> {
  const { rows: batchRows } = await dbQuery<JournalImportBatch>(
    `SELECT
       jib.*,
       jsonb_build_object('id', p.id, 'full_name', p.full_name, 'username', p.username) AS performer
     FROM public.journal_import_batches jib
     JOIN public.profiles p ON p.id = jib.performed_by
     WHERE jib.id = $1
     LIMIT 1`,
    [batchId],
  );
  const batch = batchRows[0];
  if (!batch) {
    throw new AppError(404, 'سجل دفعة الاستيراد غير موجود.', 'NOT_FOUND');
  }

  const { rows: linkedRows } = await dbQuery<{
    id: string;
    entry_number: string;
    entry_date: string;
    description: string;
    reference_number: string | null;
    status: 'DRAFT' | 'POSTED';
    total_debit: number;
    total_credit: number;
    cost_center: { id: string; code: string; name_ar: string } | null;
    period_status: 'OPEN' | 'CLOSED';
    source_type: string;
    source_voucher_id: string | null;
    has_voucher_link: boolean;
    has_reversal_link: boolean;
  }>(
    `SELECT
       je.id,
       je.entry_number,
       je.entry_date,
       je.description,
       je.reference_number,
       je.status,
       je.total_debit,
       je.total_credit,
       CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center,
       ap.status AS period_status,
       je.source_type,
       je.source_voucher_id,
       EXISTS (SELECT 1 FROM public.vouchers v WHERE v.journal_entry_id = je.id) AS has_voucher_link,
       EXISTS (SELECT 1 FROM public.journal_entries rev WHERE rev.reversed_entry_id = je.id) AS has_reversal_link
     FROM public.journal_entries je
     JOIN public.accounting_periods ap ON ap.id = je.period_id
     LEFT JOIN public.cost_centers cc ON cc.id = je.cost_center_id
     WHERE je.import_batch_id = $1
     ORDER BY je.entry_number ASC`,
    [batchId],
  );

  const linkedEntries: JournalImportBatchLinkedEntry[] = linkedRows.map((row) => {
    let blockReason: string | null = null;
    if (row.status !== 'DRAFT') {
      blockReason = 'القيد مرحّل بالفعل ولا يمكن حذفه ضمن دفعة الاستيراد.';
    } else if (row.period_status === 'CLOSED') {
      blockReason = 'القيد ينتمي إلى فترة محاسبية مغلقة.';
    } else if (row.source_type !== 'MANUAL' || row.source_voucher_id || row.has_voucher_link) {
      blockReason = 'القيد مرتبط بسند قبض أو صرف.';
    } else if (row.has_reversal_link) {
      blockReason = 'القيد مرتبط بقيد عكسي.';
    }
    return {
      id: row.id,
      entry_number: row.entry_number,
      entry_date: row.entry_date,
      description: row.description,
      reference_number: row.reference_number,
      status: row.status,
      total_debit: row.total_debit,
      total_credit: row.total_credit,
      cost_center: row.cost_center,
      eligible_for_delete: blockReason === null,
      block_reason: blockReason,
    };
  });

  const liveDrafts = linkedEntries.filter((e) => e.status === 'DRAFT').length;
  const livePosted = linkedEntries.filter((e) => e.status === 'POSTED').length;
  const blockers = linkedEntries.filter((e) => !e.eligible_for_delete);

  return {
    batch: {
      ...batch,
      live_total_entries: linkedEntries.length,
      live_draft_entries: liveDrafts,
      live_posted_entries: livePosted,
      live_blocked_entries: blockers.length,
      can_delete_with_entries: blockers.length === 0,
      delete_block_reason:
        blockers.length > 0
          ? blockers.map((b) => `${b.entry_number}: ${b.block_reason}`).join(' | ')
          : null,
    },
    linkedEntries,
  };
}

export async function deleteJournalImportBatch(options: {
  batchId: string;
  actorId: string;
  mode: JournalImportDeletionMode;
}): Promise<{
  deleted: true;
  batchId: string;
  batchNumber: string;
  fileName: string;
  mode: JournalImportDeletionMode;
  affectedEntriesCount: number;
  affectedEntryNumbers: string[];
}> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      batch_id: string;
      batch_number: string;
      file_name: string;
      deletion_type: JournalImportDeletionMode;
      affected_entries_count: number;
      affected_entry_numbers: string[];
    }>(
      `SELECT * FROM public.delete_journal_import_batch_atomic($1::UUID, $2::UUID, $3::TEXT)`,
      [options.batchId, options.actorId, options.mode],
    );
    const out = rows[0];
    return {
      deleted: true,
      batchId: out.batch_id,
      batchNumber: out.batch_number,
      fileName: out.file_name,
      mode: out.deletion_type,
      affectedEntriesCount: out.affected_entries_count,
      affectedEntryNumbers: out.affected_entry_numbers ?? [],
    };
  }, options.actorId);
}

export async function fetchJournalImportDeletionAuditLogs(): Promise<JournalImportDeletionAuditLog[]> {
  const { rows } = await dbQuery<JournalImportDeletionAuditLog>(
    `SELECT
       a.*,
       jsonb_build_object('id', p.id, 'full_name', p.full_name, 'username', p.username) AS admin
     FROM public.journal_import_deletion_audit_logs a
     JOIN public.profiles p ON p.id = a.admin_user_id
     ORDER BY a.created_at DESC`,
  );
  return rows;
}
