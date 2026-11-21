import type { PoolClient } from 'pg';
import * as XLSX from 'xlsx';
import {
  type AccountUsageInfo,
  CANONICAL_IMPORT_FIELD_DEFINITIONS,
  discoverPostingLevelValues,
  discoverUnifiedImportValues,
  isValidTargetForField,
  MAPPABLE_FIELD_ORDER,
  normalizeFieldValueToken,
  validateAndPlanAccountImport,
} from '../shared/accountImportValidator.ts';
import type {
  Account,
  AccountImportColumnMapping,
  AccountImportExecuteResult,
  AccountImportFieldDefinition,
  AccountImportInspectResult,
  AccountImportLog,
  AccountImportLogDetailItem,
  AccountImportMappableFieldKey,
  AccountImportMode,
  AccountImportPreviewResult,
  PostingLevelDiscoveryResult,
  PostingLevelInternalTarget,
  PostingLevelValueMappingMap,
  SavedImportValueMapping,
  SavedPostingLevelMapping,
  UnifiedFieldValueMappings,
  UnifiedValueDiscoveryResult,
} from '../shared/types.ts';
import { accountSchema } from '../shared/validation.ts';
import { parseAccountImportSheet } from './accountImportParser.ts';
import { dbQuery, withTransaction } from './db.ts';
import { AppError, mapDatabaseError } from './errors.ts';
import { fetchAllAccounts } from './reports.ts';

async function fetchAccountUsageMap(
  client?: PoolClient,
): Promise<Map<string, AccountUsageInfo>> {
  const runQuery = <T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
    client ? client.query<T>(sql, params) : dbQuery<T>(sql, params);

  const [jlRes, vRes] = await Promise.all([
    runQuery<{ account_id: string; has_draft: boolean }>(
      `SELECT
         jl.account_id,
         BOOL_OR(je.status = 'DRAFT') AS has_draft
       FROM public.journal_lines jl
       JOIN public.journal_entries je ON je.id = jl.journal_entry_id
       GROUP BY jl.account_id`,
    ),
    runQuery<{ account_id: string; has_draft: boolean }>(
      `SELECT account_id, BOOL_OR(status = 'DRAFT') AS has_draft
       FROM (
         SELECT cash_bank_account_id AS account_id, status FROM public.vouchers
         UNION ALL
         SELECT counter_account_id AS account_id, status FROM public.vouchers
       ) t
       GROUP BY account_id`,
    ),
  ]);

  const map = new Map<string, AccountUsageInfo>();
  for (const r of jlRes.rows) {
    map.set(r.account_id, {
      hasJournalLines: true,
      hasVouchers: false,
      hasDraftUsage: Boolean(r.has_draft),
    });
  }
  for (const r of vRes.rows) {
    const prev = map.get(r.account_id) ?? {
      hasJournalLines: false,
      hasVouchers: false,
      hasDraftUsage: false,
    };
    map.set(r.account_id, {
      hasJournalLines: prev.hasJournalLines,
      hasVouchers: true,
      hasDraftUsage: prev.hasDraftUsage || Boolean(r.has_draft),
    });
  }
  return map;
}

export function inspectAccountImportWorkbook(
  fileName: string,
  fileBase64: string,
  sheetName?: string,
): AccountImportInspectResult {
  const parsed = parseAccountImportSheet(fileName, fileBase64, sheetName);
  return {
    fileName: parsed.fileName,
    sheetNames: parsed.sheetNames,
    selectedSheet: parsed.selectedSheet,
    headerRowNumber: parsed.headerRowNumber,
    dataStartRowNumber: parsed.dataStartRowNumber,
    totalRawDataRows: parsed.rows.length,
    columns: parsed.columns,
    detectedMapping: parsed.detectedMapping,
    parseWarnings: parsed.parseWarnings,
    blankRowsSkipped: parsed.blankRowsSkipped,
    mergedBannerRowsSkipped: parsed.mergedBannerRowsSkipped,
  };
}

export async function fetchAuthoritativeImportFieldDefinitions(
  client?: PoolClient,
): Promise<AccountImportFieldDefinition[]> {
  // Verify live PostgreSQL CHECK constraints on public.accounts so options reflect actual DB constraints
  const sql = `SELECT pg_get_constraintdef(c.oid) AS def
               FROM pg_constraint c
               JOIN pg_class t ON t.oid = c.conrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               WHERE n.nspname = 'public' AND t.relname = 'accounts' AND c.contype = 'c'`;
  const res = client ? await client.query<{ def: string }>(sql) : await dbQuery<{ def: string }>(sql);
  const allDefsText = res.rows.map((r) => r.def).join('\n');

  const extractAllowedLiterals = (colName: string): Set<string> | null => {
    const match = allDefsText.match(new RegExp(`${colName}\\s*=\\s*ANY\\s*\\(ARRAY\\[(.*?)\\]\\)`));
    if (!match) return null;
    const items = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return items.length > 0 ? new Set(items) : null;
  };

  const dbAccountTypes = extractAllowedLiterals('account_type');
  const dbNormalBalances = extractAllowedLiterals('normal_balance');
  const dbStatuses = extractAllowedLiterals('status');

  return CANONICAL_IMPORT_FIELD_DEFINITIONS.map((def) => {
    if (def.fieldKey === 'account_type' && dbAccountTypes) {
      return { ...def, options: def.options.filter((o) => dbAccountTypes.has(o.value)) };
    }
    if (def.fieldKey === 'normal_balance' && dbNormalBalances) {
      return { ...def, options: def.options.filter((o) => dbNormalBalances.has(o.value)) };
    }
    if (def.fieldKey === 'status' && dbStatuses) {
      return { ...def, options: def.options.filter((o) => dbStatuses.has(o.value)) };
    }
    return def;
  });
}

export async function fetchSavedValueMappings(
  client?: PoolClient,
): Promise<SavedImportValueMapping[]> {
  const sql = `SELECT
       m.*,
       CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('id', p.id, 'full_name', p.full_name) ELSE NULL END AS updater
     FROM public.account_import_value_mappings m
     LEFT JOIN public.profiles p ON p.id = m.updated_by
     ORDER BY m.field_key ASC, m.updated_at DESC, m.source_value ASC`;
  const res = client ? await client.query(sql) : await dbQuery(sql);
  return res.rows as SavedImportValueMapping[];
}

export async function upsertSavedValueMappings(
  entries: Array<{
    field_key: AccountImportMappableFieldKey;
    source_value: string;
    internal_target: string;
  }>,
  actorId: string,
  client?: PoolClient,
): Promise<SavedImportValueMapping[]> {
  const run = async (txClient: PoolClient) => {
    const saved: SavedImportValueMapping[] = [];
    for (const entry of entries) {
      const source = entry.source_value.trim();
      const token = normalizeFieldValueToken(source);
      if (!source || !token || !isValidTargetForField(entry.field_key, entry.internal_target)) {
        continue;
      }
      const { rows } = await txClient.query(
        `INSERT INTO public.account_import_value_mappings (
           field_key, source_value, normalized_token, internal_target, updated_by
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (field_key, normalized_token)
         DO UPDATE SET
           source_value = EXCLUDED.source_value,
           internal_target = EXCLUDED.internal_target,
           updated_by = EXCLUDED.updated_by,
           updated_at = timezone('utc', now())
         RETURNING *`,
        [entry.field_key, source, token, entry.internal_target, actorId],
      );
      if (rows[0]) saved.push(rows[0] as SavedImportValueMapping);
    }
    return saved;
  };

  if (client) return run(client);
  return withTransaction((txClient) => run(txClient), actorId);
}

export async function deleteSavedValueMapping(id: string): Promise<boolean> {
  const { rowCount } = await dbQuery(
    'DELETE FROM public.account_import_value_mappings WHERE id = $1',
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function fetchSavedPostingLevelMappings(
  client?: PoolClient,
): Promise<SavedPostingLevelMapping[]> {
  const sql = `SELECT
       m.id, m.source_value, m.normalized_token, m.internal_target, m.updated_by,
       m.created_at, m.updated_at,
       CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('id', p.id, 'full_name', p.full_name) ELSE NULL END AS updater
     FROM public.account_import_value_mappings m
     LEFT JOIN public.profiles p ON p.id = m.updated_by
     WHERE m.field_key = 'is_postable'
     ORDER BY m.updated_at DESC, m.source_value ASC`;
  const res = client ? await client.query(sql) : await dbQuery(sql);
  return res.rows as SavedPostingLevelMapping[];
}

export async function upsertSavedPostingLevelMappings(
  entries: Array<{ source_value: string; internal_target: PostingLevelInternalTarget }>,
  actorId: string,
  client?: PoolClient,
): Promise<SavedPostingLevelMapping[]> {
  const saved = await upsertSavedValueMappings(
    entries.map((e) => ({
      field_key: 'is_postable' as const,
      source_value: e.source_value,
      internal_target: e.internal_target,
    })),
    actorId,
    client,
  );
  return saved as unknown as SavedPostingLevelMapping[];
}

export async function deleteSavedPostingLevelMapping(id: string): Promise<boolean> {
  const { rowCount } = await dbQuery(
    "DELETE FROM public.account_import_value_mappings WHERE id = $1 AND field_key = 'is_postable'",
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function discoverAccountImportPostingLevels(params: {
  fileName: string;
  fileBase64: string;
  sheetName?: string;
  postingColumnIndex: number;
}): Promise<PostingLevelDiscoveryResult> {
  const parsed = parseAccountImportSheet(params.fileName, params.fileBase64, params.sheetName);
  const savedMappings = await fetchSavedPostingLevelMappings();
  return discoverPostingLevelValues({
    fileName: parsed.fileName,
    sheetName: parsed.selectedSheet,
    rows: parsed.rows,
    postingColumnIndex: params.postingColumnIndex,
    savedMappings,
  });
}

export async function discoverAccountImportValues(params: {
  fileName: string;
  fileBase64: string;
  sheetName?: string;
  mapping?: AccountImportColumnMapping;
}): Promise<UnifiedValueDiscoveryResult> {
  const parsed = parseAccountImportSheet(params.fileName, params.fileBase64, params.sheetName);
  const effectiveMapping = params.mapping ?? parsed.detectedMapping;
  const columnHeaders: Record<number, string> = {};
  for (const col of parsed.columns) {
    columnHeaders[col.index] = col.header;
  }
  const [fieldDefinitions, savedMappings] = await Promise.all([
    fetchAuthoritativeImportFieldDefinitions(),
    fetchSavedValueMappings(),
  ]);

  return discoverUnifiedImportValues({
    fileName: parsed.fileName,
    sheetName: parsed.selectedSheet,
    rows: parsed.rows,
    columnHeaders,
    mapping: effectiveMapping,
    fieldDefinitions,
    savedMappings,
  });
}

export async function previewAccountImport(params: {
  fileName: string;
  fileBase64: string;
  sheetName?: string;
  mapping?: AccountImportColumnMapping;
  mode: AccountImportMode;
  createMissingInUpdateMode?: boolean;
  postingValueMappings?: PostingLevelValueMappingMap;
  fieldValueMappings?: UnifiedFieldValueMappings;
}): Promise<AccountImportPreviewResult> {
  const parsed = parseAccountImportSheet(params.fileName, params.fileBase64, params.sheetName);
  const effectiveMapping = params.mapping ?? parsed.detectedMapping;

  const [existingAccounts, accountUsageMap, savedValueMappings] = await Promise.all([
    fetchAllAccounts(),
    fetchAccountUsageMap(),
    fetchSavedValueMappings(),
  ]);

  return validateAndPlanAccountImport({
    fileName: parsed.fileName,
    sheetName: parsed.selectedSheet,
    rows: parsed.rows,
    mapping: effectiveMapping,
    existingAccounts,
    accountUsageMap,
    mode: params.mode,
    createMissingInUpdateMode: Boolean(params.createMissingInUpdateMode),
    postingValueMappings: params.postingValueMappings,
    fieldValueMappings: params.fieldValueMappings,
    savedValueMappings,
    parseWarnings: parsed.parseWarnings,
    blankRowsSkipped: parsed.blankRowsSkipped,
    mergedBannerRowsSkipped: parsed.mergedBannerRowsSkipped,
  });
}

export async function executeAccountImport(params: {
  fileName: string;
  fileBase64: string;
  sheetName?: string;
  mapping?: AccountImportColumnMapping;
  mode: AccountImportMode;
  createMissingInUpdateMode?: boolean;
  postingValueMappings?: PostingLevelValueMappingMap;
  savePostingMappings?: boolean;
  fieldValueMappings?: UnifiedFieldValueMappings;
  saveValueMappings?: boolean;
  skipInvalidRows?: boolean;
  confirmReviewRows?: boolean;
  confirmExistingUpdates?: boolean;
  actorId: string;
}): Promise<AccountImportExecuteResult> {
  const parsed = parseAccountImportSheet(params.fileName, params.fileBase64, params.sheetName);
  const effectiveMapping = params.mapping ?? parsed.detectedMapping;

  try {
    return await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(91827364)');

      const { rows: existingAccounts } = await client.query<Account>(
        'SELECT * FROM public.accounts ORDER BY code ASC FOR UPDATE',
      );
      const accountUsageMap = await fetchAccountUsageMap(client);
      const [fieldDefinitions, savedValueMappings] = await Promise.all([
        fetchAuthoritativeImportFieldDefinitions(client),
        fetchSavedValueMappings(client),
      ]);

      // Server-side guard: ensure every unique non-empty value in any mapped classification column is resolved
      const unifiedDiscovery = discoverUnifiedImportValues({
        fileName: parsed.fileName,
        sheetName: parsed.selectedSheet,
        rows: parsed.rows,
        mapping: effectiveMapping,
        fieldDefinitions,
        savedMappings: savedValueMappings,
      });

      for (const colGroup of unifiedDiscovery.columns) {
        for (const item of colGroup.items) {
          const explicitFromUnified =
            params.fieldValueMappings?.[item.fieldKey]?.[item.rawValue] ??
            params.fieldValueMappings?.[item.fieldKey]?.[item.normalizedToken] ??
            null;
          const explicitFromPosting =
            item.fieldKey === 'is_postable'
              ? params.postingValueMappings?.[item.rawValue] ??
                params.postingValueMappings?.[item.normalizedToken] ??
                null
              : null;
          const resolved = explicitFromUnified ?? explicitFromPosting ?? item.suggestedTarget;
          if (!resolved || !isValidTargetForField(item.fieldKey, resolved)) {
            throw new AppError(
              400,
              `القيمة "${item.rawValue}" في حقل "${item.fieldLabel}" غير مطابقة مع التصنيفات الداخلية المعتمدة. يجب إتمام المطابقة أولاً.`,
              item.fieldKey === 'is_postable' ? 'UNMAPPED_POSTING_VALUES' : 'UNMAPPED_IMPORT_VALUES',
            );
          }
        }
      }

      const plan = validateAndPlanAccountImport({
        fileName: parsed.fileName,
        sheetName: parsed.selectedSheet,
        rows: parsed.rows,
        mapping: effectiveMapping,
        existingAccounts,
        accountUsageMap,
        mode: params.mode,
        createMissingInUpdateMode: Boolean(params.createMissingInUpdateMode),
        postingValueMappings: params.postingValueMappings,
        fieldValueMappings: params.fieldValueMappings,
        savedValueMappings,
        parseWarnings: parsed.parseWarnings,
        blankRowsSkipped: parsed.blankRowsSkipped,
        mergedBannerRowsSkipped: parsed.mergedBannerRowsSkipped,
      });

      if (plan.rows.length === 0) {
        throw new AppError(
          400,
          'ورقة العمل المحددة لا تحتوي على أي صفوف حسابات قابلة للاستيراد.',
          'NO_IMPORT_ROWS',
        );
      }

      if (plan.summary.invalidCount > 0 && !params.skipInvalidRows) {
        throw new AppError(
          400,
          `يوجد ${plan.summary.invalidCount} سجل غير صالح في الملف. يرجى معالجة الأخطاء أو تفعيل خيار تخطي السجلات غير الصالحة للمتابعة.`,
          'IMPORT_VALIDATION_ERRORS',
        );
      }

      const executableReviewRows = plan.rows.filter(
        (r) =>
          r.classification === 'REQUIRES_REVIEW' &&
          (r.action === 'INSERT' || r.action === 'UPDATE'),
      );
      if (executableReviewRows.length > 0 && !params.confirmReviewRows) {
        throw new AppError(
          400,
          `يوجد ${executableReviewRows.length} حساب يتطلب مراجعة قبل التنفيذ. يرجى تأكيد مراجعتها للمتابعة.`,
          'REVIEW_CONFIRMATION_REQUIRED',
        );
      }

      if (
        params.mode === 'UPDATE_EXISTING' &&
        plan.summary.updatableCount > 0 &&
        !params.confirmExistingUpdates
      ) {
        throw new AppError(
          400,
          'يجب تأكيد الموافقة على تحديث الحسابات الموجودة قبل تنفيذ العملية.',
          'UPDATE_CONFIRMATION_REQUIRED',
        );
      }

      const insertRows = plan.rows
        .filter((r) => r.action === 'INSERT')
        .sort((a, b) => (a.executionOrder ?? 999999) - (b.executionOrder ?? 999999));

      const updateRows = plan.rows.filter((r) => r.action === 'UPDATE');

      if (insertRows.length === 0 && updateRows.length === 0) {
        throw new AppError(
          400,
          'لا توجد حسابات صالحة للإضافة أو التحديث في هذا الملف.',
          'NOTHING_TO_IMPORT',
        );
      }

      const codeToId = new Map<string, string>(
        existingAccounts.map((a) => [a.code.trim(), a.id]),
      );

      // Phase A: Pre-updates on existing accounts so parents become non-postable / active before children attach
      for (const row of updateRows) {
        if (!row.existingAccountId) continue;
        const target = row.normalized;
        const setClauses: string[] = [];
        const values: unknown[] = [];
        let p = 1;

        if (target.is_postable === false) {
          setClauses.push(`is_postable = $${p++}`);
          values.push(false);
        }
        if (target.status === 'ACTIVE') {
          setClauses.push(`status = $${p++}`);
          values.push('ACTIVE');
        }
        if (setClauses.length > 0) {
          values.push(row.existingAccountId);
          await client.query(
            `UPDATE public.accounts SET ${setClauses.join(', ')} WHERE id = $${p}`,
            values,
          );
        }
      }

      // Phase B: Insert new accounts in strict topological order (level 1 -> 2 -> 3...)
      for (const row of insertRows) {
        const n = row.normalized;
        const parentId = n.resolved_parent_code
          ? codeToId.get(n.resolved_parent_code) ?? null
          : null;

        if (n.resolved_parent_code && !parentId) {
          throw new AppError(
            400,
            `تعذر العثور على الحساب الأب "${n.resolved_parent_code}" أثناء إنشاء الحساب "${n.code}".`,
            'MISSING_PARENT_DURING_INSERT',
          );
        }

        const validated = accountSchema.safeParse({
          code: n.code,
          name_ar: n.name_ar,
          account_type: n.account_type,
          normal_balance: n.normal_balance,
          parent_id: parentId,
          is_postable: n.is_postable,
          status: n.status ?? 'ACTIVE',
          cost_center_required: n.is_postable ? n.cost_center_required : false,
        });
        if (!validated.success) {
          throw new AppError(
            400,
            `الصف ${row.excelRowNumber} (${n.code}): ${validated.error.issues[0]?.message || 'بيانات الحساب غير صالحة.'}`,
            'VALIDATION_ERROR',
          );
        }

        const d = validated.data;
        const { rows: insertedRows } = await client.query<Account>(
          `INSERT INTO public.accounts (
             code, name_ar, account_type, normal_balance, parent_id, is_postable, status, cost_center_required
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            d.code,
            d.name_ar,
            d.account_type,
            d.normal_balance,
            d.parent_id || null,
            d.is_postable,
            d.status,
            d.cost_center_required,
          ],
        );

        codeToId.set(insertedRows[0].code.trim(), insertedRows[0].id);
      }

      // Phase C1: Update core attributes & parent_id on existing accounts (so moved children detach first)
      const updateAsc = [...updateRows].sort(
        (a, b) => (a.normalized.computed_level ?? 999) - (b.normalized.computed_level ?? 999),
      );
      for (const row of updateAsc) {
        if (!row.existingAccountId) continue;
        const n = row.normalized;
        const parentId = n.resolved_parent_code
          ? codeToId.get(n.resolved_parent_code) ?? null
          : null;

        if (n.resolved_parent_code && !parentId) {
          throw new AppError(
            400,
            `تعذر العثور على الحساب الأب "${n.resolved_parent_code}" أثناء تحديث الحساب "${n.code}".`,
            'MISSING_PARENT_DURING_UPDATE',
          );
        }

        const validated = accountSchema.safeParse({
          code: n.code,
          name_ar: n.name_ar,
          account_type: n.account_type,
          normal_balance: n.normal_balance,
          parent_id: parentId,
          is_postable: n.is_postable,
          status: n.status ?? 'ACTIVE',
          cost_center_required: n.is_postable ? n.cost_center_required : false,
        });
        if (!validated.success) {
          throw new AppError(
            400,
            `الصف ${row.excelRowNumber} (${n.code}): ${validated.error.issues[0]?.message || 'بيانات التحديث غير صالحة.'}`,
            'VALIDATION_ERROR',
          );
        }

        const d = validated.data;
        await client.query(
          `UPDATE public.accounts
           SET name_ar = $1,
               account_type = $2,
               normal_balance = $3,
               parent_id = $4,
               cost_center_required = $5
           WHERE id = $6`,
          [
            d.name_ar,
            d.account_type,
            d.normal_balance,
            d.parent_id || null,
            d.cost_center_required,
            row.existingAccountId,
          ],
        );
      }

      // Phase C2: Apply is_postable = true updates after all child parent_ids are updated
      for (const row of updateAsc) {
        if (!row.existingAccountId) continue;
        if (row.normalized.is_postable === true) {
          await client.query(
            'UPDATE public.accounts SET is_postable = true WHERE id = $1',
            [row.existingAccountId],
          );
        }
      }

      // Phase C3: Apply status = 'INACTIVE' updates in reverse depth order (children before parents)
      const updateDesc = [...updateRows].sort(
        (a, b) => (b.normalized.computed_level ?? 0) - (a.normalized.computed_level ?? 0),
      );
      for (const row of updateDesc) {
        if (!row.existingAccountId) continue;
        if (row.normalized.status === 'INACTIVE') {
          await client.query(
            "UPDATE public.accounts SET status = 'INACTIVE' WHERE id = $1",
            [row.existingAccountId],
          );
        }
      }

      // Phase D: Save approved field-scoped mappings if requested (does not modify existing accounts)
      const shouldSave = Boolean(params.saveValueMappings || params.savePostingMappings);
      if (shouldSave) {
        const toSave: Array<{
          field_key: AccountImportMappableFieldKey;
          source_value: string;
          internal_target: string;
        }> = [];
        if (params.fieldValueMappings) {
          for (const fieldKey of MAPPABLE_FIELD_ORDER) {
            const rec = params.fieldValueMappings[fieldKey];
            if (!rec) continue;
            for (const [k, v] of Object.entries(rec)) {
              if (k.trim().length > 0 && isValidTargetForField(fieldKey, v)) {
                toSave.push({ field_key: fieldKey, source_value: k, internal_target: v });
              }
            }
          }
        }
        if (params.postingValueMappings && !params.fieldValueMappings?.is_postable) {
          for (const [k, v] of Object.entries(params.postingValueMappings)) {
            if (k.trim().length > 0) {
              toSave.push({ field_key: 'is_postable', source_value: k, internal_target: v });
            }
          }
        }
        if (toSave.length > 0) {
          await upsertSavedValueMappings(toSave, params.actorId, client);
        }
      }

      // Phase E: Record traceable operation log inside the same committed transaction
      const details: AccountImportLogDetailItem[] = plan.rows.map((r) => ({
        excelRowNumber: r.excelRowNumber,
        code: r.normalized.code || r.raw.code,
        name_ar: r.normalized.name_ar || r.raw.name_ar,
        classification: r.classification,
        outcome:
          r.action === 'INSERT'
            ? 'IMPORTED'
            : r.action === 'UPDATE'
              ? 'UPDATED'
              : r.action === 'ERROR'
                ? 'ERROR'
                : 'SKIPPED',
        messages: [...r.errors, ...r.warnings],
        changes: r.changes.length > 0 ? r.changes : undefined,
      }));

      const importedCount = insertRows.length;
      const updatedCount = updateRows.length;
      const errorCount = plan.summary.invalidCount;
      const skippedCount = plan.summary.skippableCount;
      const opStatus =
        errorCount > 0 || skippedCount > 0 ? 'COMPLETED_WITH_SKIPS' : 'COMPLETED';

      const { rows: numRows } = await client.query<{ op_num: string }>(
        "SELECT public.next_document_number('account_import', 'IMP') AS op_num",
      );
      const operationNumber = numRows[0].op_num;

      const { rows: logRows } = await client.query<AccountImportLog>(
        `INSERT INTO public.account_import_logs (
           operation_number, file_name, sheet_name, import_mode,
           total_rows, imported_count, updated_count, skipped_count, error_count, review_count,
           status, details, performed_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
         RETURNING *`,
        [
          operationNumber,
          parsed.fileName,
          parsed.selectedSheet,
          params.mode,
          plan.summary.totalRows,
          importedCount,
          updatedCount,
          skippedCount,
          errorCount,
          plan.summary.reviewCount,
          opStatus,
          JSON.stringify(details),
          params.actorId,
        ],
      );

      return {
        log: logRows[0],
        importedCount,
        updatedCount,
        skippedCount,
        errorCount,
      };
    }, params.actorId);
  } catch (err) {
    const mapped = mapDatabaseError(err);
    // Persist a traceable FAILED import log outside the rolled-back transaction
    try {
      const { rows: numRows } = await dbQuery<{ op_num: string }>(
        "SELECT public.next_document_number('account_import', 'IMP') AS op_num",
      );
      await dbQuery(
        `INSERT INTO public.account_import_logs (
           operation_number, file_name, sheet_name, import_mode,
           total_rows, imported_count, updated_count, skipped_count, error_count, review_count,
           status, error_message, details, performed_by
         ) VALUES ($1, $2, $3, $4, $5, 0, 0, 0, $6, 0, 'FAILED', $7, '[]'::jsonb, $8)`,
        [
          numRows[0].op_num,
          parsed.fileName,
          parsed.selectedSheet,
          params.mode,
          parsed.rows.length,
          parsed.rows.length,
          mapped.message,
          params.actorId,
        ],
      );
    } catch {
      // ignore secondary logging failure
    }
    throw mapped;
  }
}

export async function fetchAccountImportLogs(limit = 50): Promise<AccountImportLog[]> {
  const safeLimit = Math.min(100, Math.max(1, limit));
  const { rows } = await dbQuery<AccountImportLog>(
    `SELECT
       l.id, l.operation_number, l.file_name, l.sheet_name, l.import_mode,
       l.total_rows, l.imported_count, l.updated_count, l.skipped_count, l.error_count, l.review_count,
       l.status, l.error_message, l.performed_by, l.created_at,
       '[]'::jsonb AS details,
       jsonb_build_object('id', p.id, 'full_name', p.full_name, 'username', p.username) AS performer
     FROM public.account_import_logs l
     LEFT JOIN public.profiles p ON p.id = l.performed_by
     ORDER BY l.created_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  return rows;
}

export async function fetchAccountImportLogById(id: string): Promise<AccountImportLog | null> {
  const { rows } = await dbQuery<AccountImportLog>(
    `SELECT
       l.*,
       jsonb_build_object('id', p.id, 'full_name', p.full_name, 'username', p.username) AS performer
     FROM public.account_import_logs l
     LEFT JOIN public.profiles p ON p.id = l.performed_by
     WHERE l.id = $1
     LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

export function generateAccountsImportTemplateBuffer(): { buffer: Buffer; filename: string } {
  const headers = [
    'رمز الحساب',
    'اسم الحساب',
    'رمز الحساب الأب',
    'اسم الحساب الأب',
    'المستوى',
    'نوع الحساب',
    'طبيعة الحساب',
    'مستوى الترحيل',
    'الحالة',
    'إلزامية مركز التكلفة',
  ];

  // Strictly headers only — zero mock or sample rows
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  ws['!views'] = [{ rightToLeft: true }];
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(18, h.length + 6) }));

  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'دليل الحسابات');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  return {
    buffer,
    filename: 'chart_of_accounts_import_template.xlsx',
  };
}
