import { dbQuery, withTransaction } from './db.ts';
import { AppError, mapDatabaseError } from './errors.ts';
import type {
  BulkJournalPostAuditLog,
  BulkJournalPostFilter,
  BulkJournalPostItemResult,
  BulkJournalPostMode,
  BulkJournalPostPreviewEntry,
  BulkJournalPostPreviewResponse,
  BulkJournalPostSummary,
  JournalStatus,
} from '../shared/types.ts';

export interface BulkPostProgressEvent {
  type: 'progress';
  processed: number;
  total: number;
  postedCount: number;
  failedCount: number;
  skippedCount: number;
  currentEntryNumber: string;
}

function buildAllDraftsFilterSql(filters?: BulkJournalPostFilter): {
  whereSql: string;
  params: unknown[];
} {
  const conditions: string[] = [`je.status = 'DRAFT'`];
  const params: unknown[] = [];
  let idx = 1;

  const search = filters?.search?.trim() || '';
  if (search) {
    conditions.push(
      `(je.entry_number ILIKE $${idx} OR je.description ILIKE $${idx} OR COALESCE(je.reference_number, '') ILIKE $${idx})`,
    );
    params.push(`%${search}%`);
    idx++;
  }
  if (filters?.startDate) {
    conditions.push(`je.entry_date >= $${idx++}::DATE`);
    params.push(filters.startDate);
  }
  if (filters?.endDate) {
    conditions.push(`je.entry_date <= $${idx++}::DATE`);
    params.push(filters.endDate);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

export async function previewBulkJournalPosting(options: {
  mode: BulkJournalPostMode;
  entryIds?: string[];
  filters?: BulkJournalPostFilter;
}): Promise<BulkJournalPostPreviewResponse> {
  if (options.mode === 'SELECTED') {
    const uniqueIds = Array.from(new Set(options.entryIds || []));
    if (uniqueIds.length === 0) {
      throw new AppError(400, 'يجب تحديد قيد مسودة واحد على الأقل.', 'VALIDATION_ERROR');
    }

    const { rows } = await dbQuery<BulkJournalPostPreviewEntry>(
      `SELECT id, entry_number, entry_date::TEXT AS entry_date, description, total_debit::FLOAT8 AS total_debit, total_credit::FLOAT8 AS total_credit, status
       FROM public.journal_entries
       WHERE id = ANY($1::UUID[])
       ORDER BY entry_date ASC, entry_number ASC`,
      [uniqueIds],
    );

    const eligibleDraftCount = rows.filter((r) => r.status === 'DRAFT').length;
    const alreadyPostedCount = rows.filter((r) => r.status === 'POSTED').length;

    return {
      mode: 'SELECTED',
      totalTargeted: uniqueIds.length,
      eligibleDraftCount,
      alreadyPostedCount,
      entries: rows,
    };
  }

  const { whereSql, params } = buildAllDraftsFilterSql(options.filters);
  const { rows } = await dbQuery<BulkJournalPostPreviewEntry>(
    `SELECT je.id, je.entry_number, je.entry_date::TEXT AS entry_date, je.description, je.total_debit::FLOAT8 AS total_debit, je.total_credit::FLOAT8 AS total_credit, je.status
     FROM public.journal_entries je
     ${whereSql}
     ORDER BY je.entry_date ASC, je.entry_number ASC`,
    params,
  );

  return {
    mode: 'ALL_DRAFTS',
    totalTargeted: rows.length,
    eligibleDraftCount: rows.length,
    alreadyPostedCount: 0,
    entries: rows,
  };
}

export async function executeBulkJournalPosting(options: {
  mode: BulkJournalPostMode;
  entryIds?: string[];
  filters?: BulkJournalPostFilter;
  actorId: string;
  onProgress?: (event: BulkPostProgressEvent) => void;
}): Promise<BulkJournalPostSummary> {
  let candidateRows: Array<{
    id: string;
    entry_number: string;
    entry_date: string;
    description: string;
    total_debit: number;
    status: JournalStatus | 'MISSING';
  }> = [];

  if (options.mode === 'SELECTED') {
    const uniqueIds = Array.from(new Set(options.entryIds || []));
    if (uniqueIds.length === 0) {
      throw new AppError(400, 'يجب تحديد قيد مسودة واحد على الأقل.', 'VALIDATION_ERROR');
    }

    const { rows } = await dbQuery<{
      id: string;
      entry_number: string;
      entry_date: string;
      description: string;
      total_debit: number;
      status: JournalStatus;
    }>(
      `SELECT id, entry_number, entry_date::TEXT AS entry_date, description, total_debit::FLOAT8 AS total_debit, status
       FROM public.journal_entries
       WHERE id = ANY($1::UUID[])
       ORDER BY entry_date ASC, entry_number ASC`,
      [uniqueIds],
    );

    const foundSet = new Set(rows.map((r) => r.id));
    candidateRows = [...rows];
    for (const missingId of uniqueIds) {
      if (!foundSet.has(missingId)) {
        candidateRows.push({
          id: missingId,
          entry_number: missingId.slice(0, 8),
          entry_date: '',
          description: 'قيد غير موجود',
          total_debit: 0,
          status: 'MISSING',
        });
      }
    }
  } else {
    const { whereSql, params } = buildAllDraftsFilterSql(options.filters);
    const { rows } = await dbQuery<{
      id: string;
      entry_number: string;
      entry_date: string;
      description: string;
      total_debit: number;
      status: JournalStatus;
    }>(
      `SELECT je.id, je.entry_number, je.entry_date::TEXT AS entry_date, je.description, je.total_debit::FLOAT8 AS total_debit, je.status
       FROM public.journal_entries je
       ${whereSql}
       ORDER BY je.entry_date ASC, je.entry_number ASC`,
      params,
    );
    candidateRows = rows;
  }

  const total = candidateRows.length;
  const results: BulkJournalPostItemResult[] = [];
  let postedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < candidateRows.length; i++) {
    const row = candidateRows[i];

    if (row.status === 'MISSING') {
      failedCount += 1;
      results.push({
        entry_id: row.id,
        entry_number: row.entry_number,
        entry_date: row.entry_date,
        description: row.description,
        total_debit: 0,
        outcome: 'FAILED',
        reason: 'القيد غير موجود أو تم حذفه قبل التنفيذ.',
      });
    } else if (row.status !== 'DRAFT') {
      // Already posted or otherwise ineligible: skip cleanly without re-posting
      skippedCount += 1;
      results.push({
        entry_id: row.id,
        entry_number: row.entry_number,
        entry_date: row.entry_date,
        description: row.description,
        total_debit: row.total_debit,
        outcome: 'SKIPPED',
        reason: 'القيد مرحّل بالفعل مسبقاً وتم تخطيه لمنع تكرار الترحيل أو الحركات.',
      });
    } else {
      try {
        // Independent isolated transaction per entry reusing the existing atomic posting logic
        await withTransaction(async (client) => {
          await client.query(
            'SELECT public.post_journal_entry_atomic($1::UUID, $2::UUID)',
            [row.id, options.actorId],
          );
        }, options.actorId);

        postedCount += 1;
        results.push({
          entry_id: row.id,
          entry_number: row.entry_number,
          entry_date: row.entry_date,
          description: row.description,
          total_debit: row.total_debit,
          outcome: 'POSTED',
          reason: 'تم ترحيل القيد بنجاح وتحديث الأستاذ العام.',
        });
      } catch (err) {
        const mapped = mapDatabaseError(err);
        if (mapped.code === 'ALREADY_POSTED') {
          skippedCount += 1;
          results.push({
            entry_id: row.id,
            entry_number: row.entry_number,
            entry_date: row.entry_date,
            description: row.description,
            total_debit: row.total_debit,
            outcome: 'SKIPPED',
            reason: 'تم ترحيل القيد عبر عملية متزامنة أخرى، وتم تخطيه لمنع تكرار الترحيل.',
          });
        } else {
          failedCount += 1;
          results.push({
            entry_id: row.id,
            entry_number: row.entry_number,
            entry_date: row.entry_date,
            description: row.description,
            total_debit: row.total_debit,
            outcome: 'FAILED',
            reason: mapped.message,
          });
        }
      }
    }

    options.onProgress?.({
      type: 'progress',
      processed: i + 1,
      total,
      postedCount,
      failedCount,
      skippedCount,
      currentEntryNumber: row.entry_number,
    });
  }

  const auditRecord = await withTransaction(async (client) => {
    const numRes = await client.query<{ num: string }>(
      `SELECT public.next_document_number('bulk_post', 'JBP') AS num`,
    );
    const operationNumber = numRes.rows[0].num;
    const insertRes = await client.query<{ id: string; created_at: string }>(
      `INSERT INTO public.journal_bulk_posting_audit_logs (
         operation_number, mode, total_targeted, posted_count, failed_count, skipped_count,
         filter_snapshot, results, admin_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
       RETURNING id, created_at`,
      [
        operationNumber,
        options.mode,
        total,
        postedCount,
        failedCount,
        skippedCount,
        options.mode === 'ALL_DRAFTS' ? JSON.stringify(options.filters || {}) : null,
        JSON.stringify(results),
        options.actorId,
      ],
    );
    return {
      auditLogId: insertRes.rows[0].id,
      operationNumber,
      createdAt: insertRes.rows[0].created_at,
    };
  }, options.actorId);

  return {
    auditLogId: auditRecord.auditLogId,
    operationNumber: auditRecord.operationNumber,
    mode: options.mode,
    totalSelected: total,
    postedCount,
    failedCount,
    skippedCount,
    results,
    createdAt: auditRecord.createdAt,
  };
}

export async function fetchBulkJournalPostingAuditLogs(): Promise<BulkJournalPostAuditLog[]> {
  const { rows } = await dbQuery<BulkJournalPostAuditLog>(
    `SELECT
       a.*,
       jsonb_build_object('id', p.id, 'full_name', p.full_name, 'username', p.username) AS admin
     FROM public.journal_bulk_posting_audit_logs a
     JOIN public.profiles p ON p.id = a.admin_user_id
     ORDER BY a.created_at DESC
     LIMIT 100`,
  );
  return rows;
}
