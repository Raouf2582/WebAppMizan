import Decimal from 'decimal.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { validateDoubleEntryLines } from '../shared/accounting.ts';
import type {
  AccountingPeriod,
  Account,
  CostCenter,
  JournalEntry,
  JournalLine,
  UserProfile,
  Voucher,
} from '../shared/types.ts';
import {
  accountSchema,
  bulkJournalPostExecuteSchema,
  bulkJournalPostPreviewSchema,
  costCenterSchema,
  createUserSchema,
  deleteJournalImportBatchSchema,
  deleteJournalSchema,
  discoverPostingLevelsSchema,
  discoverUnifiedValuesSchema,
  executeAccountImportSchema,
  executeJournalImportSchema,
  inspectAccountImportSchema,
  inspectJournalImportSchema,
  journalEntrySchema,
  periodSchema,
  previewAccountImportSchema,
  previewJournalImportSchema,
  reverseJournalSchema,
  savePostingMappingsSchema,
  saveValueMappingsSchema,
  setupAdminSchema,
  updateUserSchema,
  voucherSchema,
} from '../shared/validation.ts';
import {
  deleteSavedPostingLevelMapping,
  deleteSavedValueMapping,
  discoverAccountImportPostingLevels,
  discoverAccountImportValues,
  executeAccountImport,
  fetchAccountImportLogById,
  fetchAccountImportLogs,
  fetchAuthoritativeImportFieldDefinitions,
  fetchSavedPostingLevelMappings,
  fetchSavedValueMappings,
  generateAccountsImportTemplateBuffer,
  inspectAccountImportWorkbook,
  previewAccountImport,
  upsertSavedPostingLevelMappings,
  upsertSavedValueMappings,
} from './accountImportService.ts';
import {
  executeBulkJournalPosting,
  fetchBulkJournalPostingAuditLogs,
  previewBulkJournalPosting,
} from './bulkJournalPostingService.ts';
import { inspectJournalImportWorkbook } from './journalImportParser.ts';
import {
  deleteJournalImportBatch,
  executeJournalImport,
  fetchJournalImportBatchDetails,
  fetchJournalImportDeletionAuditLogs,
  fetchJournalImportHistory,
  generateJournalImportTemplateBuffer,
  previewJournalImport,
} from './journalImportService.ts';
import { hashPassword, signSessionToken, verifyPassword } from './auth.ts';
import { requireAdmin, requireAuth } from './authMiddleware.ts';
import { dbQuery, withTransaction } from './db.ts';
import { AppError, mapDatabaseError } from './errors.ts';
import {
  buildAccountLedger,
  buildBalanceSheet,
  buildCostCenterProfitability,
  buildIncomeStatement,
  buildTrialBalance,
  fetchAllAccounts,
  fetchAllCostCenters,
  fetchPostedLineFacts,
  generateReportWorkbookBuffer,
} from './reports.ts';

export const app = express();
const defaultJsonParser = express.json({ limit: '1mb' });
const importJsonParser = express.json({ limit: '15mb' });
app.use((req, res, next) => {
  if (
    req.path.startsWith('/api/accounts/import') ||
    req.path.startsWith('/api/journal-imports')
  ) {
    return importJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});

let setupInFlight = false;

const DUMMY_PASSWORD_HASH =
  '00000000000000000000000000000000:' + '0'.repeat(128);

const loginSchema = z.object({
  username: z.string().trim().min(1, 'اسم المستخدم مطلوب'),
  password: z.string().min(1, 'كلمة المرور مطلوبة'),
});

function wrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// ============================================================================
// SYSTEM STATUS, FIRST-TIME ADMIN SETUP & LOGIN
// ============================================================================

app.get(
  '/api/system/status',
  wrap(async (_req, res) => {
    try {
      const { rows } = await dbQuery<{ cnt: number }>(
        'SELECT COUNT(*)::INT AS cnt FROM public.profiles',
      );
      return res.json({
        configured: true,
        schemaReady: true,
        initialized: (rows[0]?.cnt ?? 0) > 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Database connection error';
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      return res.json({
        configured: true,
        schemaReady: code === '42P01' ? false : false,
        initialized: false,
        schemaError: msg,
      });
    }
  }),
);

app.post(
  '/api/auth/setup',
  wrap(async (req, res) => {
    if (setupInFlight) {
      throw new AppError(409, 'توجد عملية تهيئة أولية قيد التنفيذ حالياً.', 'SETUP_IN_PROGRESS');
    }

    setupInFlight = true;
    try {
      const parsed = setupAdminSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
      }

      const { full_name, username, password } = parsed.data;
      const normalizedUsername = username.trim();
      const passwordHash = hashPassword(password);

      const user = await withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(72819011)');
        const { rows: countRows } = await client.query<{ cnt: number }>(
          'SELECT COUNT(*)::INT AS cnt FROM public.profiles',
        );
        if ((countRows[0]?.cnt ?? 0) > 0) {
          throw new AppError(
            403,
            'تمت تهيئة النظام مسبقاً. صفحة الإعداد الأولي معطلة.',
            'ALREADY_INITIALIZED',
          );
        }

        const { rows } = await client.query<UserProfile>(
          `INSERT INTO public.profiles (full_name, username, password_hash, role, is_active)
           VALUES ($1, $2, $3, 'ADMIN', true)
           RETURNING id, full_name, username, role, is_active, created_at, updated_at`,
          [full_name, normalizedUsername, passwordHash],
        );
        return rows[0];
      });

      const token = signSessionToken(user.id, user.role);
      res.status(201).json({ user, token });
    } finally {
      setupInFlight = false;
    }
  }),
);

app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
    }

    const { username, password } = parsed.data;
    const { rows } = await dbQuery<UserProfile & { password_hash: string }>(
      `SELECT id, full_name, username, password_hash, role, is_active, created_at, updated_at
       FROM public.profiles
       WHERE LOWER(username) = LOWER($1)
       LIMIT 1`,
      [username.trim()],
    );

    const found = rows[0];
    if (!found) {
      // Constant-time work to prevent username enumeration via response timing
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw new AppError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة.', 'INVALID_CREDENTIALS');
    }

    if (!verifyPassword(password, found.password_hash)) {
      throw new AppError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة.', 'INVALID_CREDENTIALS');
    }

    if (!found.is_active) {
      throw new AppError(403, 'تم تعطيل هذا الحساب. يرجى التواصل مع مدير النظام.', 'ACCOUNT_DISABLED');
    }

    const { password_hash: _ignored, ...profile } = found;
    const token = signSessionToken(profile.id, profile.role);
    res.json({ profile, token });
  }),
);

app.get(
  '/api/auth/me',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ profile: req.userProfile });
  }),
);

// ============================================================================
// USER MANAGEMENT (ADMIN ONLY)
// ============================================================================

app.get(
  '/api/users',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    const { rows } = await dbQuery<UserProfile>(
      `SELECT id, full_name, username, role, is_active, created_at, updated_at
       FROM public.profiles
       ORDER BY created_at DESC`,
    );
    res.json({ users: rows });
  }),
);

app.post(
  '/api/users',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
    }

    const { full_name, username, password, role } = parsed.data;
    const normalizedUsername = username.trim();

    const { rows: existing } = await dbQuery<{ id: string }>(
      'SELECT id FROM public.profiles WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [normalizedUsername],
    );
    if (existing.length > 0) {
      throw new AppError(409, 'اسم المستخدم مستخدم بالفعل، يرجى اختيار اسم مستخدم آخر.', 'USERNAME_TAKEN');
    }

    const passwordHash = hashPassword(password);

    const { rows } = await dbQuery<UserProfile>(
      `INSERT INTO public.profiles (full_name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id, full_name, username, role, is_active, created_at, updated_at`,
      [full_name, normalizedUsername, passwordHash, role],
    );

    res.status(201).json({ user: rows[0] });
  }),
);

app.patch(
  '/api/users/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف المستخدم غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف المستخدم غير صالح.', 'INVALID_ID');
    }
    const targetId = idCheck.data;

    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
    }

    if (req.userProfile!.id === targetId) {
      if (parsed.data.is_active === false) {
        throw new AppError(400, 'لا يمكنك تعطيل حسابك الشخصي أثناء تسجيل الدخول.', 'SELF_DEACTIVATE');
      }
      if (parsed.data.role && parsed.data.role !== 'ADMIN') {
        throw new AppError(400, 'لا يمكنك تخفيض صلاحيتك من مدير نظام.', 'SELF_DEMOTE');
      }
    }

    const updated = await withTransaction(async (client) => {
      const { rows: existingRows } = await client.query<UserProfile>(
        `SELECT id, full_name, username, role, is_active, created_at, updated_at
         FROM public.profiles
         WHERE id = $1
         FOR UPDATE`,
        [targetId],
      );
      const existing = existingRows[0];
      if (!existing) {
        throw new AppError(404, 'المستخدم غير موجود.', 'NOT_FOUND');
      }

      if (parsed.data.username !== undefined) {
        const normalizedUsername = parsed.data.username.trim();
        const { rows: dupRows } = await client.query<{ id: string }>(
          'SELECT id FROM public.profiles WHERE LOWER(username) = LOWER($1) AND id <> $2 LIMIT 1',
          [normalizedUsername, targetId],
        );
        if (dupRows.length > 0) {
          throw new AppError(409, 'اسم المستخدم مستخدم بالفعل، يرجى اختيار اسم مستخدم آخر.', 'USERNAME_TAKEN');
        }
      }

      const nextRole = parsed.data.role ?? existing.role;
      const nextActive = parsed.data.is_active ?? existing.is_active;
      if (existing.role === 'ADMIN' && existing.is_active && (nextRole !== 'ADMIN' || !nextActive)) {
        const { rows: adminCountRows } = await client.query<{ cnt: number }>(
          `SELECT COUNT(*)::INT AS cnt
           FROM public.profiles
           WHERE role = 'ADMIN' AND is_active = true AND id <> $1`,
          [targetId],
        );
        if ((adminCountRows[0]?.cnt ?? 0) === 0) {
          throw new AppError(
            400,
            'لا يمكن تعطيل أو تغيير صلاحية آخر مدير نظام نشط.',
            'LAST_ADMIN_PROTECTED',
          );
        }
      }

      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (parsed.data.full_name !== undefined) {
        updates.push(`full_name = $${idx++}`);
        values.push(parsed.data.full_name);
      }
      if (parsed.data.username !== undefined) {
        updates.push(`username = $${idx++}`);
        values.push(parsed.data.username.trim());
      }
      if (parsed.data.password !== undefined) {
        updates.push(`password_hash = $${idx++}`);
        values.push(hashPassword(parsed.data.password));
      }
      if (parsed.data.role !== undefined) {
        updates.push(`role = $${idx++}`);
        values.push(parsed.data.role);
      }
      if (parsed.data.is_active !== undefined) {
        updates.push(`is_active = $${idx++}`);
        values.push(parsed.data.is_active);
      }

      if (updates.length === 0) {
        throw new AppError(400, 'لا توجد حقول لتحديثها.', 'NO_UPDATES');
      }

      values.push(targetId);
      const { rows } = await client.query<UserProfile>(
        `UPDATE public.profiles
         SET ${updates.join(', ')}
         WHERE id = $${idx}
         RETURNING id, full_name, username, role, is_active, created_at, updated_at`,
        values,
      );

      return rows[0];
    });

    res.json({ user: updated });
  }),
);

app.delete(
  '/api/users/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف المستخدم غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف المستخدم غير صالح.', 'INVALID_ID');
    }
    const targetId = idCheck.data;

    if (req.userProfile!.id === targetId) {
      throw new AppError(400, 'لا يمكنك حذف حسابك الشخصي أثناء تسجيل الدخول.', 'SELF_DELETE_FORBIDDEN');
    }

    const result = await withTransaction(async (client) => {
      const { rows: targetRows } = await client.query<UserProfile>(
        `SELECT id, full_name, username, role, is_active, created_at, updated_at
         FROM public.profiles
         WHERE id = $1
         FOR UPDATE`,
        [targetId],
      );
      const target = targetRows[0];
      if (!target) {
        throw new AppError(404, 'المستخدم غير موجود.', 'NOT_FOUND');
      }

      if (target.role === 'ADMIN') {
        const { rows: adminCountRows } = await client.query<{ active_cnt: number; total_cnt: number }>(
          `SELECT
             COUNT(*) FILTER (WHERE is_active = true)::INT AS active_cnt,
             COUNT(*)::INT AS total_cnt
           FROM public.profiles
           WHERE role = 'ADMIN' AND id <> $1`,
          [targetId],
        );
        const remainingActive = adminCountRows[0]?.active_cnt ?? 0;
        const remainingTotal = adminCountRows[0]?.total_cnt ?? 0;
        if (remainingTotal === 0 || (target.is_active && remainingActive === 0)) {
          throw new AppError(400, 'لا يمكن حذف آخر مدير نظام في النظام.', 'LAST_ADMIN_PROTECTED');
        }
      }

      const { rows: refRows } = await client.query<{ has_records: boolean }>(
        `SELECT (
           EXISTS (SELECT 1 FROM public.accounting_periods WHERE created_by = $1 OR closed_by = $1 OR reopened_by = $1)
           OR EXISTS (SELECT 1 FROM public.journal_entries WHERE created_by = $1 OR posted_by = $1)
           OR EXISTS (SELECT 1 FROM public.vouchers WHERE created_by = $1 OR posted_by = $1)
           OR EXISTS (SELECT 1 FROM public.account_import_logs WHERE performed_by = $1)
           OR EXISTS (SELECT 1 FROM public.account_import_value_mappings WHERE updated_by = $1)
           OR EXISTS (SELECT 1 FROM public.journal_import_batches WHERE performed_by = $1)
           OR EXISTS (SELECT 1 FROM public.journal_import_deletion_audit_logs WHERE admin_user_id = $1)
           OR EXISTS (SELECT 1 FROM public.journal_bulk_posting_audit_logs WHERE admin_user_id = $1)
         ) AS has_records`,
        [targetId],
      );

      if (refRows[0]?.has_records) {
        if (!target.is_active) {
          throw new AppError(
            409,
            'لا يمكن حذف هذا المستخدم نهائياً لارتباطه بسجلات محاسبية قائمة؛ الحساب معطل بالفعل للحفاظ على سلامة البيانات المالية.',
            'HAS_ACCOUNTING_RECORDS',
          );
        }

        const { rows: deactivatedRows } = await client.query<UserProfile>(
          `UPDATE public.profiles
           SET is_active = false
           WHERE id = $1
           RETURNING id, full_name, username, role, is_active, created_at, updated_at`,
          [targetId],
        );

        return {
          deleted: false,
          deactivated: true,
          user: deactivatedRows[0],
          message: `المستخدم "${target.username}" مرتبط بسجلات محاسبية قائمة؛ تم تعطيل الحساب بأمان للحفاظ على سلامة البيانات المالية.`,
        };
      }

      await client.query('DELETE FROM public.profiles WHERE id = $1', [targetId]);

      return {
        deleted: true,
        deactivated: false,
        message: `تم حذف المستخدم "${target.username}" بنجاح.`,
      };
    });

    res.json(result);
  }),
);

// ============================================================================
// CHART OF ACCOUNTS
// ============================================================================

app.get(
  '/api/accounts',
  requireAuth,
  wrap(async (_req, res) => {
    const accounts = await fetchAllAccounts();
    res.json({ accounts });
  }),
);

app.post(
  '/api/accounts',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = accountSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
    }

    const d = parsed.data;
    const { rows } = await dbQuery<Account>(
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
    res.status(201).json({ account: rows[0] });
  }),
);

app.patch(
  '/api/accounts/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = accountSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
    }

    const d = parsed.data;
    const { rows } = await dbQuery<Account>(
      `UPDATE public.accounts
       SET code = $1, name_ar = $2, account_type = $3, normal_balance = $4,
           parent_id = $5, is_postable = $6, status = $7, cost_center_required = $8
       WHERE id = $9
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
        req.params.id,
      ],
    );

    if (!rows[0]) throw new AppError(404, 'الحساب غير موجود.', 'NOT_FOUND');
    res.json({ account: rows[0] });
  }),
);

app.delete(
  '/api/accounts/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = req.params.id;
    const { rows: children } = await dbQuery(
      'SELECT id FROM public.accounts WHERE parent_id = $1 LIMIT 1',
      [id],
    );
    if (children.length > 0) {
      throw new AppError(400, 'لا يمكن حذف حساب رئيسي يحتوي على حسابات فرعية.', 'HAS_CHILDREN');
    }

    const { rows: lines } = await dbQuery(
      'SELECT id FROM public.journal_lines WHERE account_id = $1 LIMIT 1',
      [id],
    );
    if (lines.length > 0) {
      throw new AppError(400, 'لا يمكن حذف حساب عليه قيود أو حركات محاسبية.', 'HAS_TRANSACTIONS');
    }

    const { rows: vouchers } = await dbQuery(
      'SELECT id FROM public.vouchers WHERE cash_bank_account_id = $1 OR counter_account_id = $1 LIMIT 1',
      [id],
    );
    if (vouchers.length > 0) {
      throw new AppError(400, 'لا يمكن حذف حساب مستخدم في السندات المالية.', 'HAS_VOUCHERS');
    }

    await dbQuery('DELETE FROM public.accounts WHERE id = $1', [id]);
    res.json({ deleted: true });
  }),
);

// ============================================================================
// CHART OF ACCOUNTS EXCEL IMPORT (ADMIN ONLY)
// ============================================================================

app.get(
  '/api/accounts/import/template',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    const { buffer, filename } = generateAccountsImportTemplateBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

app.get(
  '/api/accounts/import/history',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const limit = Number(req.query.limit || 50);
    const logs = await fetchAccountImportLogs(Number.isFinite(limit) ? limit : 50);
    res.json({ logs });
  }),
);

app.get(
  '/api/accounts/import/history/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف عملية الاستيراد غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف عملية الاستيراد غير صالح.', 'INVALID_ID');
    }
    const log = await fetchAccountImportLogById(idCheck.data);
    if (!log) {
      throw new AppError(404, 'سجل عملية الاستيراد غير موجود.', 'NOT_FOUND');
    }
    res.json({ log });
  }),
);

app.post(
  '/api/accounts/import/inspect',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = inspectAccountImportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات الملف غير صالحة.', 'VALIDATION_ERROR');
    }

    const result = inspectAccountImportWorkbook(
      parsed.data.fileName,
      parsed.data.fileBase64,
      parsed.data.sheetName,
    );
    res.json({ inspection: result });
  }),
);

app.post(
  '/api/accounts/import/discover-values',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = discoverUnifiedValuesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات فحص قيم الأعمدة غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    const discovery = await discoverAccountImportValues(parsed.data);
    res.json({ discovery });
  }),
);

app.get(
  '/api/accounts/import/value-mappings',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    const [mappings, fieldDefinitions] = await Promise.all([
      fetchSavedValueMappings(),
      fetchAuthoritativeImportFieldDefinitions(),
    ]);
    res.json({ mappings, fieldDefinitions });
  }),
);

app.post(
  '/api/accounts/import/value-mappings',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = saveValueMappingsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات المطابقات المحفوظة غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    await upsertSavedValueMappings(parsed.data.mappings, req.userProfile!.id);
    const mappings = await fetchSavedValueMappings();
    res.json({ mappings });
  }),
);

app.delete(
  '/api/accounts/import/value-mappings/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف المطابقة غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف المطابقة غير صالح.', 'INVALID_ID');
    }

    const deleted = await deleteSavedValueMapping(idCheck.data);
    if (!deleted) {
      throw new AppError(404, 'المطابقة المحفوظة غير موجودة.', 'NOT_FOUND');
    }

    res.json({ deleted: true });
  }),
);

app.post(
  '/api/accounts/import/discover-posting-levels',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = discoverPostingLevelsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات فحص عمود مستوى الترحيل غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    const discovery = await discoverAccountImportPostingLevels(parsed.data);
    res.json({ discovery });
  }),
);

app.get(
  '/api/accounts/import/posting-mappings',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    const mappings = await fetchSavedPostingLevelMappings();
    res.json({ mappings });
  }),
);

app.post(
  '/api/accounts/import/posting-mappings',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = savePostingMappingsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات المطابقة المحفوظة غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    await upsertSavedPostingLevelMappings(parsed.data.mappings, req.userProfile!.id);
    const mappings = await fetchSavedPostingLevelMappings();
    res.json({ mappings });
  }),
);

app.delete(
  '/api/accounts/import/posting-mappings/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف المطابقة غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف المطابقة غير صالح.', 'INVALID_ID');
    }

    const deleted = await deleteSavedPostingLevelMapping(idCheck.data);
    if (!deleted) {
      throw new AppError(404, 'المطابقة المحفوظة غير موجودة.', 'NOT_FOUND');
    }

    res.json({ deleted: true });
  }),
);

app.post(
  '/api/accounts/import/preview',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = previewAccountImportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات المعاينة غير صالحة.', 'VALIDATION_ERROR');
    }

    const preview = await previewAccountImport({
      fileName: parsed.data.fileName,
      fileBase64: parsed.data.fileBase64,
      sheetName: parsed.data.sheetName,
      mapping: parsed.data.mapping,
      mode: parsed.data.mode,
      createMissingInUpdateMode: parsed.data.createMissingInUpdateMode,
      postingValueMappings: parsed.data.postingValueMappings,
      fieldValueMappings: parsed.data.fieldValueMappings,
    });
    res.json({ preview });
  }),
);

app.post(
  '/api/accounts/import/execute',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = executeAccountImportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات الاستيراد غير صالحة.', 'VALIDATION_ERROR');
    }

    const result = await executeAccountImport({
      fileName: parsed.data.fileName,
      fileBase64: parsed.data.fileBase64,
      sheetName: parsed.data.sheetName,
      mapping: parsed.data.mapping,
      mode: parsed.data.mode,
      createMissingInUpdateMode: parsed.data.createMissingInUpdateMode,
      postingValueMappings: parsed.data.postingValueMappings,
      savePostingMappings: parsed.data.savePostingMappings,
      fieldValueMappings: parsed.data.fieldValueMappings,
      saveValueMappings: parsed.data.saveValueMappings,
      skipInvalidRows: parsed.data.skipInvalidRows,
      confirmReviewRows: parsed.data.confirmReviewRows,
      confirmExistingUpdates: parsed.data.confirmExistingUpdates,
      actorId: req.userProfile!.id,
    });
    res.status(201).json({ result });
  }),
);

// ============================================================================
// COST CENTERS
// ============================================================================

app.get(
  '/api/cost-centers',
  requireAuth,
  wrap(async (_req, res) => {
    const costCenters = await fetchAllCostCenters();
    res.json({ costCenters });
  }),
);

app.post(
  '/api/cost-centers',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = costCenterSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
    }

    const d = parsed.data;
    const { rows } = await dbQuery<CostCenter>(
      `INSERT INTO public.cost_centers (code, name_ar, description, parent_id, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [d.code, d.name_ar, d.description || null, d.parent_id || null, d.status],
    );
    res.status(201).json({ costCenter: rows[0] });
  }),
);

app.patch(
  '/api/cost-centers/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = costCenterSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
    }

    const d = parsed.data;
    const { rows } = await dbQuery<CostCenter>(
      `UPDATE public.cost_centers
       SET code = $1, name_ar = $2, description = $3, parent_id = $4, status = $5
       WHERE id = $6
       RETURNING *`,
      [d.code, d.name_ar, d.description || null, d.parent_id || null, d.status, req.params.id],
    );

    if (!rows[0]) throw new AppError(404, 'مركز التكلفة غير موجود.', 'NOT_FOUND');
    res.json({ costCenter: rows[0] });
  }),
);

app.delete(
  '/api/cost-centers/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const id = req.params.id;
    const { rows: children } = await dbQuery(
      'SELECT id FROM public.cost_centers WHERE parent_id = $1 LIMIT 1',
      [id],
    );
    if (children.length > 0) {
      throw new AppError(400, 'لا يمكن حذف مركز تكلفة لديه مراكز فرعية.', 'HAS_CHILDREN');
    }

    const { rows: lines } = await dbQuery(
      'SELECT id FROM public.journal_lines WHERE cost_center_id = $1 LIMIT 1',
      [id],
    );
    if (lines.length > 0) {
      throw new AppError(
        400,
        'لا يمكن حذف مركز تكلفة مرتبط بحركات محاسبية؛ يمكنك تعطيله بدلاً من الحذف.',
        'HAS_TRANSACTIONS',
      );
    }

    await dbQuery('DELETE FROM public.cost_centers WHERE id = $1', [id]);
    res.json({ deleted: true });
  }),
);

// ============================================================================
// ACCOUNTING PERIODS
// ============================================================================

app.get(
  '/api/periods',
  requireAuth,
  wrap(async (_req, res) => {
    const { rows } = await dbQuery<AccountingPeriod>(
      'SELECT * FROM public.accounting_periods ORDER BY start_date DESC',
    );
    res.json({ periods: rows });
  }),
);

app.post(
  '/api/periods',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = periodSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات غير صالحة.', 'VALIDATION_ERROR');
    }

    const d = parsed.data;
    const { rows } = await dbQuery<AccountingPeriod>(
      `INSERT INTO public.accounting_periods (name_ar, start_date, end_date, status, created_by)
       VALUES ($1, $2, $3, 'OPEN', $4)
       RETURNING *`,
      [d.name_ar, d.start_date, d.end_date, req.userProfile!.id],
    );
    res.status(201).json({ period: rows[0] });
  }),
);

app.post(
  '/api/periods/:id/close',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const { rows: existing } = await dbQuery<AccountingPeriod>(
      'SELECT * FROM public.accounting_periods WHERE id = $1 LIMIT 1',
      [req.params.id],
    );
    if (!existing[0]) throw new AppError(404, 'الفترة المحاسبية غير موجودة.', 'NOT_FOUND');
    if (existing[0].status === 'CLOSED') {
      throw new AppError(400, 'الفترة المحاسبية مغلقة بالفعل.', 'ALREADY_CLOSED');
    }

    const { rows } = await dbQuery<AccountingPeriod>(
      `UPDATE public.accounting_periods
       SET status = 'CLOSED', closed_at = timezone('utc', now()), closed_by = $1
       WHERE id = $2
       RETURNING *`,
      [req.userProfile!.id, req.params.id],
    );
    res.json({ period: rows[0] });
  }),
);

app.post(
  '/api/periods/:id/reopen',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const { rows: existing } = await dbQuery<AccountingPeriod>(
      'SELECT * FROM public.accounting_periods WHERE id = $1 LIMIT 1',
      [req.params.id],
    );
    if (!existing[0]) throw new AppError(404, 'الفترة المحاسبية غير موجودة.', 'NOT_FOUND');
    if (existing[0].status === 'OPEN') {
      throw new AppError(400, 'الفترة المحاسبية مفتوحة بالفعل.', 'ALREADY_OPEN');
    }

    const { rows } = await dbQuery<AccountingPeriod>(
      `UPDATE public.accounting_periods
       SET status = 'OPEN', reopened_at = timezone('utc', now()), reopened_by = $1
       WHERE id = $2
       RETURNING *`,
      [req.userProfile!.id, req.params.id],
    );
    res.json({ period: rows[0] });
  }),
);

// ============================================================================
// JOURNAL ENTRIES (DOUBLE-ENTRY)
// ============================================================================

app.get(
  '/api/journals',
  requireAuth,
  wrap(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (status === 'DRAFT' || status === 'POSTED') {
      conditions.push(`je.status = $${idx++}`);
      params.push(status);
    }
    if (startDate) {
      conditions.push(`je.entry_date >= $${idx++}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`je.entry_date <= $${idx++}`);
      params.push(endDate);
    }
    if (search) {
      conditions.push(
        `(je.entry_number ILIKE $${idx} OR je.description ILIKE $${idx} OR COALESCE(je.reference_number, '') ILIKE $${idx})`,
      );
      params.push(`%${search}%`);
      idx++;
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const countRes = await dbQuery<{ total: number }>(
      `SELECT COUNT(*)::INT AS total FROM public.journal_entries je ${whereSql}`,
      params,
    );

    const dataRes = await dbQuery<JournalEntry>(
      `SELECT
         je.*,
         jsonb_build_object('id', c.id, 'full_name', c.full_name) AS creator,
         CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('id', p.id, 'full_name', p.full_name) ELSE NULL END AS poster,
         jsonb_build_object('id', ap.id, 'name_ar', ap.name_ar, 'status', ap.status) AS period,
         CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center,
         CASE WHEN jib.id IS NOT NULL THEN jsonb_build_object('id', jib.id, 'batch_number', jib.batch_number, 'file_name', jib.file_name) ELSE NULL END AS import_batch,
         CASE WHEN orig_je.id IS NOT NULL THEN jsonb_build_object('id', orig_je.id, 'entry_number', orig_je.entry_number, 'entry_date', orig_je.entry_date) ELSE NULL END AS reversed_entry,
         CASE WHEN rev_je.id IS NOT NULL THEN jsonb_build_object('id', rev_je.id, 'entry_number', rev_je.entry_number, 'entry_date', rev_je.entry_date, 'status', rev_je.status) ELSE NULL END AS reversal_entry,
         CASE WHEN sv.id IS NOT NULL THEN jsonb_build_object(
           'id', sv.id,
           'voucher_number', sv.voucher_number,
           'voucher_type', sv.voucher_type,
           'voucher_date', sv.voucher_date,
           'party_name', sv.party_name,
           'amount', sv.amount,
           'status', sv.status
         ) ELSE NULL END AS source_voucher
       FROM public.journal_entries je
       LEFT JOIN public.profiles c ON c.id = je.created_by
       LEFT JOIN public.profiles p ON p.id = je.posted_by
       LEFT JOIN public.accounting_periods ap ON ap.id = je.period_id
       LEFT JOIN public.cost_centers cc ON cc.id = je.cost_center_id
       LEFT JOIN public.journal_import_batches jib ON jib.id = je.import_batch_id
       LEFT JOIN public.journal_entries orig_je ON orig_je.id = je.reversed_entry_id
       LEFT JOIN public.journal_entries rev_je ON rev_je.reversed_entry_id = je.id
       LEFT JOIN LATERAL (
         SELECT v.id, v.voucher_number, v.voucher_type, v.voucher_date, v.party_name, v.amount, v.status
         FROM public.vouchers v
         WHERE v.journal_entry_id = je.id OR v.id = je.source_voucher_id
         LIMIT 1
       ) sv ON true
       ${whereSql}
       ORDER BY je.entry_date DESC, je.entry_number DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, pageSize, offset],
    );

    res.json({
      entries: dataRes.rows,
      total: countRes.rows[0]?.total ?? 0,
      page,
      pageSize,
    });
  }),
);

// Bulk journal posting routes (registered before /api/journals/:id)
app.post(
  '/api/journals/bulk-post/preview',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = bulkJournalPostPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات معاينة الترحيل الجماعي غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    const preview = await previewBulkJournalPosting({
      mode: parsed.data.mode,
      entryIds: parsed.data.entryIds,
      filters: parsed.data.filters,
    });
    res.json({ preview });
  }),
);

app.get(
  '/api/journals/bulk-post/audit-logs',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    const logs = await fetchBulkJournalPostingAuditLogs();
    res.json({ logs });
  }),
);

app.post(
  '/api/journals/bulk-post',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = bulkJournalPostExecuteSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات الترحيل الجماعي غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    if (parsed.data.stream) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.flushHeaders?.();

      const summary = await executeBulkJournalPosting({
        mode: parsed.data.mode,
        entryIds: parsed.data.entryIds,
        filters: parsed.data.filters,
        actorId: req.userProfile!.id,
        onProgress: (ev) => {
          res.write(`${JSON.stringify(ev)}\n`);
        },
      });
      res.write(`${JSON.stringify({ type: 'done', summary })}\n`);
      res.end();
      return;
    }

    const summary = await executeBulkJournalPosting({
      mode: parsed.data.mode,
      entryIds: parsed.data.entryIds,
      filters: parsed.data.filters,
      actorId: req.userProfile!.id,
    });
    res.json({ summary });
  }),
);

app.get(
  '/api/journals/:id',
  requireAuth,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف القيد غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف القيد غير صالح.', 'INVALID_ID');
    }

    const { rows: entryRows } = await dbQuery<JournalEntry>(
      `SELECT
         je.*,
         jsonb_build_object('id', c.id, 'full_name', c.full_name) AS creator,
         CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('id', p.id, 'full_name', p.full_name) ELSE NULL END AS poster,
         jsonb_build_object('id', ap.id, 'name_ar', ap.name_ar, 'status', ap.status) AS period,
         CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center,
         CASE WHEN jib.id IS NOT NULL THEN jsonb_build_object('id', jib.id, 'batch_number', jib.batch_number, 'file_name', jib.file_name) ELSE NULL END AS import_batch,
         CASE WHEN orig_je.id IS NOT NULL THEN jsonb_build_object('id', orig_je.id, 'entry_number', orig_je.entry_number, 'entry_date', orig_je.entry_date) ELSE NULL END AS reversed_entry,
         CASE WHEN rev_je.id IS NOT NULL THEN jsonb_build_object('id', rev_je.id, 'entry_number', rev_je.entry_number, 'entry_date', rev_je.entry_date, 'status', rev_je.status) ELSE NULL END AS reversal_entry,
         CASE WHEN sv.id IS NOT NULL THEN jsonb_build_object(
           'id', sv.id,
           'voucher_number', sv.voucher_number,
           'voucher_type', sv.voucher_type,
           'voucher_date', sv.voucher_date,
           'party_name', sv.party_name,
           'amount', sv.amount,
           'status', sv.status
         ) ELSE NULL END AS source_voucher
       FROM public.journal_entries je
       LEFT JOIN public.profiles c ON c.id = je.created_by
       LEFT JOIN public.profiles p ON p.id = je.posted_by
       LEFT JOIN public.accounting_periods ap ON ap.id = je.period_id
       LEFT JOIN public.cost_centers cc ON cc.id = je.cost_center_id
       LEFT JOIN public.journal_import_batches jib ON jib.id = je.import_batch_id
       LEFT JOIN public.journal_entries orig_je ON orig_je.id = je.reversed_entry_id
       LEFT JOIN public.journal_entries rev_je ON rev_je.reversed_entry_id = je.id
       LEFT JOIN LATERAL (
         SELECT v.id, v.voucher_number, v.voucher_type, v.voucher_date, v.party_name, v.amount, v.status
         FROM public.vouchers v
         WHERE v.journal_entry_id = je.id OR v.id = je.source_voucher_id
         LIMIT 1
       ) sv ON true
       WHERE je.id = $1
       LIMIT 1`,
      [idCheck.data],
    );

    const entry = entryRows[0];
    if (!entry) throw new AppError(404, 'القيد المحاسبي غير موجود.', 'NOT_FOUND');

    const { rows: lines } = await dbQuery<JournalLine>(
      `SELECT
         jl.*,
         jsonb_build_object('id', a.id, 'code', a.code, 'name_ar', a.name_ar, 'account_type', a.account_type, 'normal_balance', a.normal_balance) AS account,
         CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center
       FROM public.journal_lines jl
       JOIN public.accounts a ON a.id = jl.account_id
       LEFT JOIN public.cost_centers cc ON cc.id = jl.cost_center_id
       WHERE jl.journal_entry_id = $1
       ORDER BY jl.line_order ASC`,
      [req.params.id],
    );

    res.json({ entry: { ...entry, lines } });
  }),
);

app.post(
  '/api/journals',
  requireAuth,
  wrap(async (req, res) => {
    const parsed = journalEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات القيد غير صالحة.', 'VALIDATION_ERROR');
    }

    const [accounts, costCenters] = await Promise.all([fetchAllAccounts(), fetchAllCostCenters()]);
    const accountMap = new Map<string, Account>(accounts.map((a) => [a.id, a]));
    const ccMap = new Map<string, CostCenter>(costCenters.map((c) => [c.id, c]));

    const headerCostCenterId = parsed.data.cost_center_id || null;
    if (headerCostCenterId) {
      const headerCc = ccMap.get(headerCostCenterId);
      if (!headerCc || headerCc.status !== 'ACTIVE') {
        throw new AppError(400, 'مركز التكلفة المحدد غير موجود أو غير نشط.', 'INVALID_COST_CENTER');
      }
    }

    const normalizedLines = parsed.data.lines.map((line) => ({
      ...line,
      cost_center_id: headerCostCenterId,
    }));

    const validation = validateDoubleEntryLines(normalizedLines, accountMap, ccMap);
    if (!validation.valid) {
      throw new AppError(400, validation.error || 'القيد غير متوازن.', 'INVALID_JOURNAL');
    }

    const entry = await withTransaction(async (client) => {
      const { rows: rpcRows } = await client.query<{ entry_id: string }>(
        `SELECT public.create_journal_entry_with_lines($1::DATE, $2::TEXT, $3::TEXT, $4::UUID, $5::JSONB, $6::UUID) AS entry_id`,
        [
          parsed.data.entry_date,
          parsed.data.description,
          parsed.data.reference_number || null,
          req.userProfile!.id,
          JSON.stringify(normalizedLines),
          headerCostCenterId,
        ],
      );
      const { rows } = await client.query<JournalEntry>(
        `SELECT
           je.*,
           CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center
         FROM public.journal_entries je
         LEFT JOIN public.cost_centers cc ON cc.id = je.cost_center_id
         WHERE je.id = $1`,
        [rpcRows[0].entry_id],
      );
      return rows[0];
    }, req.userProfile!.id);

    res.status(201).json({ entry });
  }),
);

app.patch(
  '/api/journals/:id',
  requireAuth,
  wrap(async (req, res) => {
    const parsed = journalEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات القيد غير صالحة.', 'VALIDATION_ERROR');
    }

    const [accounts, costCenters] = await Promise.all([fetchAllAccounts(), fetchAllCostCenters()]);
    const accountMap = new Map<string, Account>(accounts.map((a) => [a.id, a]));
    const ccMap = new Map<string, CostCenter>(costCenters.map((c) => [c.id, c]));

    const headerCostCenterId = parsed.data.cost_center_id || null;
    if (headerCostCenterId) {
      const headerCc = ccMap.get(headerCostCenterId);
      if (!headerCc || headerCc.status !== 'ACTIVE') {
        throw new AppError(400, 'مركز التكلفة المحدد غير موجود أو غير نشط.', 'INVALID_COST_CENTER');
      }
    }

    const normalizedLines = parsed.data.lines.map((line) => ({
      ...line,
      cost_center_id: headerCostCenterId,
    }));

    const validation = validateDoubleEntryLines(normalizedLines, accountMap, ccMap);
    if (!validation.valid) {
      throw new AppError(400, validation.error || 'القيد غير متوازن.', 'INVALID_JOURNAL');
    }

    const entry = await withTransaction(async (client) => {
      const { rows: rpcRows } = await client.query<{ entry_id: string }>(
        `SELECT public.update_draft_journal_entry($1::UUID, $2::DATE, $3::TEXT, $4::TEXT, $5::UUID, $6::JSONB, $7::UUID) AS entry_id`,
        [
          req.params.id,
          parsed.data.entry_date,
          parsed.data.description,
          parsed.data.reference_number || null,
          req.userProfile!.id,
          JSON.stringify(normalizedLines),
          headerCostCenterId,
        ],
      );
      const { rows } = await client.query<JournalEntry>(
        `SELECT
           je.*,
           CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center
         FROM public.journal_entries je
         LEFT JOIN public.cost_centers cc ON cc.id = je.cost_center_id
         WHERE je.id = $1`,
        [rpcRows[0].entry_id],
      );
      return rows[0];
    }, req.userProfile!.id);

    res.json({ entry });
  }),
);

app.post(
  '/api/journals/:id/post',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف القيد غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف القيد غير صالح.', 'INVALID_ID');
    }

    const entry = await withTransaction(async (client) => {
      const { rows: rpcRows } = await client.query<{ entry_id: string }>(
        'SELECT public.post_journal_entry_atomic($1::UUID, $2::UUID) AS entry_id',
        [idCheck.data, req.userProfile!.id],
      );
      const { rows } = await client.query<JournalEntry>(
        `SELECT
           je.*,
           CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center,
           CASE WHEN orig_je.id IS NOT NULL THEN jsonb_build_object('id', orig_je.id, 'entry_number', orig_je.entry_number, 'entry_date', orig_je.entry_date) ELSE NULL END AS reversed_entry,
           CASE WHEN rev_je.id IS NOT NULL THEN jsonb_build_object('id', rev_je.id, 'entry_number', rev_je.entry_number, 'entry_date', rev_je.entry_date, 'status', rev_je.status) ELSE NULL END AS reversal_entry
         FROM public.journal_entries je
         LEFT JOIN public.cost_centers cc ON cc.id = je.cost_center_id
         LEFT JOIN public.journal_entries orig_je ON orig_je.id = je.reversed_entry_id
         LEFT JOIN public.journal_entries rev_je ON rev_je.reversed_entry_id = je.id
         WHERE je.id = $1`,
        [rpcRows[0].entry_id],
      );
      return rows[0];
    }, req.userProfile!.id);

    res.json({ entry });
  }),
);

app.post(
  '/api/journals/:id/reverse',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف القيد غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف القيد غير صالح.', 'INVALID_ID');
    }

    const parsed = reverseJournalSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات القيد العكسي غير صالحة.', 'VALIDATION_ERROR');
    }

    const entry = await withTransaction(async (client) => {
      const { rows: rpcRows } = await client.query<{ entry_id: string }>(
        'SELECT public.reverse_journal_entry_atomic($1::UUID, $2::DATE, $3::UUID) AS entry_id',
        [idCheck.data, parsed.data.entry_date, req.userProfile!.id],
      );
      const { rows } = await client.query<JournalEntry>(
        `SELECT
           je.*,
           CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center,
           CASE WHEN orig_je.id IS NOT NULL THEN jsonb_build_object('id', orig_je.id, 'entry_number', orig_je.entry_number, 'entry_date', orig_je.entry_date) ELSE NULL END AS reversed_entry
         FROM public.journal_entries je
         LEFT JOIN public.cost_centers cc ON cc.id = je.cost_center_id
         LEFT JOIN public.journal_entries orig_je ON orig_je.id = je.reversed_entry_id
         WHERE je.id = $1`,
        [rpcRows[0].entry_id],
      );
      return rows[0];
    }, req.userProfile!.id);

    res.status(201).json({ entry });
  }),
);

app.delete(
  '/api/journals/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف القيد غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف القيد غير صالح.', 'INVALID_ID');
    }

    const rawVoucherAction =
      req.body && typeof req.body === 'object' && 'voucher_action' in req.body
        ? req.body.voucher_action
        : typeof req.query.voucherAction === 'string'
          ? req.query.voucherAction
          : undefined;

    const parsed = deleteJournalSchema.safeParse({
      voucher_action: rawVoucherAction,
    });
    if (!parsed.success) {
      throw new AppError(400, 'خيار التعامل مع السند المرتبط غير صالح.', 'INVALID_VOUCHER_ACTION');
    }

    const voucherAction = parsed.data.voucher_action;

    const outcome = await withTransaction(async (client) => {
      const { rows: linkedRows } = await client.query<{ voucher_number: string }>(
        `SELECT v.voucher_number
         FROM public.journal_entries je
         JOIN public.vouchers v ON v.journal_entry_id = je.id OR v.id = je.source_voucher_id
         WHERE je.id = $1
         LIMIT 1`,
        [idCheck.data],
      );

      await client.query(
        'SELECT public.delete_journal_entry_atomic($1::UUID, $2::UUID, $3::TEXT)',
        [idCheck.data, req.userProfile!.id, voucherAction],
      );

      return {
        deleted: true,
        voucherAction,
        linkedVoucherNumber: linkedRows[0]?.voucher_number ?? null,
      };
    }, req.userProfile!.id);

    res.json(outcome);
  }),
);

// ============================================================================
// EXCEL JOURNAL IMPORT & ADMIN-ONLY IMPORT HISTORY MANAGEMENT
// ============================================================================

app.get(
  '/api/journal-imports/template',
  requireAuth,
  wrap(async (_req, res) => {
    const { buffer, filename } = generateJournalImportTemplateBuffer();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

app.post(
  '/api/journal-imports/inspect',
  requireAuth,
  wrap(async (req, res) => {
    const parsed = inspectJournalImportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات ملف الاستيراد غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    const inspection = inspectJournalImportWorkbook(
      parsed.data.fileName,
      parsed.data.fileBase64,
    );
    res.json({ inspection });
  }),
);

app.post(
  '/api/journal-imports/preview',
  requireAuth,
  wrap(async (req, res) => {
    const parsed = previewJournalImportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات معاينة استيراد القيود غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    const preview = await previewJournalImport({
      fileName: parsed.data.fileName,
      fileBase64: parsed.data.fileBase64,
      sheetNames: parsed.data.sheetNames,
      mappingsBySheet: parsed.data.mappingsBySheet,
    });
    res.json({ preview });
  }),
);

app.post(
  '/api/journal-imports/execute',
  requireAuth,
  wrap(async (req, res) => {
    const parsed = executeJournalImportSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات تنفيذ استيراد القيود غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    const result = await executeJournalImport({
      fileName: parsed.data.fileName,
      fileBase64: parsed.data.fileBase64,
      sheetNames: parsed.data.sheetNames,
      mappingsBySheet: parsed.data.mappingsBySheet,
      skipRejectedEntries: parsed.data.skipRejectedEntries,
      actorId: req.userProfile!.id,
    });
    res.status(201).json({ result });
  }),
);

app.get(
  '/api/journal-imports/history',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : '';

    const batches = await fetchJournalImportHistory({
      search,
      status,
      startDate,
      endDate,
    });
    res.json({ batches });
  }),
);

app.get(
  '/api/journal-imports/history/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف دفعة الاستيراد غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف دفعة الاستيراد غير صالح.', 'INVALID_ID');
    }

    const details = await fetchJournalImportBatchDetails(idCheck.data);
    res.json(details);
  }),
);

app.delete(
  '/api/journal-imports/history/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف دفعة الاستيراد غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف دفعة الاستيراد غير صالح.', 'INVALID_ID');
    }

    const parsed = deleteJournalImportBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message || 'بيانات تأكيد الحذف غير صالحة.',
        'VALIDATION_ERROR',
      );
    }

    const outcome = await deleteJournalImportBatch({
      batchId: idCheck.data,
      actorId: req.userProfile!.id,
      mode: parsed.data.mode,
    });
    res.json(outcome);
  }),
);

app.get(
  '/api/journal-imports/audit-logs',
  requireAuth,
  requireAdmin,
  wrap(async (_req, res) => {
    const logs = await fetchJournalImportDeletionAuditLogs();
    res.json({ logs });
  }),
);

// ============================================================================
// RECEIPT & PAYMENT VOUCHERS
// ============================================================================

app.get(
  '/api/vouchers',
  requireAuth,
  wrap(async (req, res) => {
    const type = req.query.type === 'RECEIPT' || req.query.type === 'PAYMENT' ? req.query.type : null;
    const status = req.query.status === 'DRAFT' || req.query.status === 'POSTED' ? req.query.status : null;
    const page = Math.max(1, Number(req.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : '';
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : '';

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (type) {
      conditions.push(`v.voucher_type = $${idx++}`);
      params.push(type);
    }
    if (status) {
      conditions.push(`v.status = $${idx++}`);
      params.push(status);
    }
    if (startDate) {
      conditions.push(`v.voucher_date >= $${idx++}`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`v.voucher_date <= $${idx++}`);
      params.push(endDate);
    }
    if (search) {
      conditions.push(
        `(v.voucher_number ILIKE $${idx} OR v.party_name ILIKE $${idx} OR v.description ILIKE $${idx} OR COALESCE(v.reference_number, '') ILIKE $${idx})`,
      );
      params.push(`%${search}%`);
      idx++;
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (page - 1) * pageSize;

    const countRes = await dbQuery<{ total: number }>(
      `SELECT COUNT(*)::INT AS total FROM public.vouchers v ${whereSql}`,
      params,
    );

    const dataRes = await dbQuery<Voucher>(
      `SELECT
         v.*,
         jsonb_build_object('id', ca.id, 'code', ca.code, 'name_ar', ca.name_ar) AS cash_bank_account,
         jsonb_build_object('id', cta.id, 'code', cta.code, 'name_ar', cta.name_ar) AS counter_account,
         CASE WHEN cc.id IS NOT NULL THEN jsonb_build_object('id', cc.id, 'code', cc.code, 'name_ar', cc.name_ar) ELSE NULL END AS cost_center,
         CASE WHEN je.id IS NOT NULL THEN jsonb_build_object('id', je.id, 'entry_number', je.entry_number, 'status', je.status) ELSE NULL END AS journal_entry,
         jsonb_build_object('id', cr.id, 'full_name', cr.full_name) AS creator
       FROM public.vouchers v
       JOIN public.accounts ca ON ca.id = v.cash_bank_account_id
       JOIN public.accounts cta ON cta.id = v.counter_account_id
       LEFT JOIN public.cost_centers cc ON cc.id = v.cost_center_id
       LEFT JOIN public.journal_entries je ON je.id = v.journal_entry_id
       LEFT JOIN public.profiles cr ON cr.id = v.created_by
       ${whereSql}
       ORDER BY v.voucher_date DESC, v.voucher_number DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, pageSize, offset],
    );

    res.json({
      vouchers: dataRes.rows,
      total: countRes.rows[0]?.total ?? 0,
      page,
      pageSize,
    });
  }),
);

app.post(
  '/api/vouchers',
  requireAuth,
  wrap(async (req, res) => {
    const parsed = voucherSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات السند غير صالحة.', 'VALIDATION_ERROR');
    }

    if (parsed.data.finalize_immediately && req.userProfile!.role !== 'ADMIN') {
      throw new AppError(403, 'اعتماد وترحيل السندات متاح لمدير النظام فقط.', 'ADMIN_REQUIRED');
    }

    const voucher = await withTransaction(async (client) => {
      const { rows: rpcRows } = await client.query<{ voucher_id: string }>(
        `SELECT public.create_voucher_atomic(
           $1::TEXT, $2::DATE, $3::TEXT, $4::UUID, $5::UUID, $6::TEXT, $7::NUMERIC, $8::TEXT, $9::TEXT, $10::UUID, $11::UUID
         ) AS voucher_id`,
        [
          parsed.data.voucher_type,
          parsed.data.voucher_date,
          parsed.data.payment_method,
          parsed.data.cash_bank_account_id,
          parsed.data.counter_account_id,
          parsed.data.party_name,
          new Decimal(parsed.data.amount).toDecimalPlaces(2).toNumber(),
          parsed.data.description,
          parsed.data.reference_number || null,
          parsed.data.cost_center_id || null,
          req.userProfile!.id,
        ],
      );
      const voucherId = rpcRows[0].voucher_id;

      if (parsed.data.finalize_immediately && req.userProfile!.role === 'ADMIN') {
        await client.query('SELECT public.finalize_voucher_atomic($1::UUID, $2::UUID)', [
          voucherId,
          req.userProfile!.id,
        ]);
      }

      const { rows } = await client.query<Voucher>('SELECT * FROM public.vouchers WHERE id = $1', [
        voucherId,
      ]);
      return rows[0];
    }, req.userProfile!.id);

    res.status(201).json({ voucher });
  }),
);

app.patch(
  '/api/vouchers/:id',
  requireAuth,
  wrap(async (req, res) => {
    const parsed = voucherSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0]?.message || 'بيانات السند غير صالحة.', 'VALIDATION_ERROR');
    }

    const voucher = await withTransaction(async (client) => {
      const { rows: rpcRows } = await client.query<{ voucher_id: string }>(
        `SELECT public.update_draft_voucher_atomic(
           $1::UUID, $2::DATE, $3::TEXT, $4::UUID, $5::UUID, $6::TEXT, $7::NUMERIC, $8::TEXT, $9::TEXT, $10::UUID, $11::UUID
         ) AS voucher_id`,
        [
          req.params.id,
          parsed.data.voucher_date,
          parsed.data.payment_method,
          parsed.data.cash_bank_account_id,
          parsed.data.counter_account_id,
          parsed.data.party_name,
          new Decimal(parsed.data.amount).toDecimalPlaces(2).toNumber(),
          parsed.data.description,
          parsed.data.reference_number || null,
          parsed.data.cost_center_id || null,
          req.userProfile!.id,
        ],
      );
      const { rows } = await client.query<Voucher>('SELECT * FROM public.vouchers WHERE id = $1', [
        rpcRows[0].voucher_id,
      ]);
      return rows[0];
    }, req.userProfile!.id);

    res.json({ voucher });
  }),
);

app.post(
  '/api/vouchers/:id/finalize',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const { rows: rpcRows } = await client.query<{ entry_id: string }>(
        'SELECT public.finalize_voucher_atomic($1::UUID, $2::UUID) AS entry_id',
        [req.params.id, req.userProfile!.id],
      );
      const { rows } = await client.query<Voucher>(
        `SELECT v.*,
           jsonb_build_object('id', je.id, 'entry_number', je.entry_number, 'status', je.status) AS journal_entry
         FROM public.vouchers v
         LEFT JOIN public.journal_entries je ON je.id = v.journal_entry_id
         WHERE v.id = $1`,
        [req.params.id],
      );
      return { voucher: rows[0], journalEntryId: rpcRows[0].entry_id };
    }, req.userProfile!.id);

    res.json(result);
  }),
);

app.delete(
  '/api/vouchers/:id',
  requireAuth,
  requireAdmin,
  wrap(async (req, res) => {
    const idCheck = z.string().uuid('معرف السند غير صالح.').safeParse(req.params.id);
    if (!idCheck.success) {
      throw new AppError(400, 'معرف السند غير صالح.', 'INVALID_ID');
    }

    const outcome = await withTransaction(async (client) => {
      const { rows: voucherRows } = await client.query<{
        id: string;
        voucher_number: string;
        status: string;
        journal_entry_id: string | null;
      }>(
        `SELECT id, voucher_number, status, journal_entry_id
         FROM public.vouchers
         WHERE id = $1
         FOR UPDATE`,
        [idCheck.data],
      );
      const voucher = voucherRows[0];
      if (!voucher) {
        throw new AppError(404, 'السند غير موجود.', 'NOT_FOUND');
      }

      const { rows: entryRows } = await client.query<{ id: string; entry_number: string }>(
        `SELECT id, entry_number
         FROM public.journal_entries
         WHERE id = $1 OR source_voucher_id = $2
         LIMIT 1
         FOR UPDATE`,
        [voucher.journal_entry_id, voucher.id],
      );
      const linkedEntry = entryRows[0] ?? null;

      if (linkedEntry) {
        await client.query(
          'SELECT public.delete_journal_entry_atomic($1::UUID, $2::UUID, $3::TEXT)',
          [linkedEntry.id, req.userProfile!.id, 'DELETE_VOUCHER'],
        );
      } else {
        if (voucher.status === 'POSTED') {
          await client.query("SELECT set_config('app.bypass_admin_delete_guard', 'true', true)");
        }
        await client.query('DELETE FROM public.vouchers WHERE id = $1', [voucher.id]);
        if (voucher.status === 'POSTED') {
          await client.query("SELECT set_config('app.bypass_admin_delete_guard', 'false', true)");
        }
      }

      return {
        deleted: true,
        voucherNumber: voucher.voucher_number,
        deletedJournalEntryNumber: linkedEntry?.entry_number ?? null,
      };
    }, req.userProfile!.id);

    res.json(outcome);
  }),
);

// ============================================================================
// FINANCIAL REPORTS & REAL XLSX EXPORTS (POSTED DATA ONLY)
// ============================================================================

app.get(
  '/api/reports/ledger',
  requireAuth,
  wrap(async (req, res) => {
    const accountId = String(req.query.accountId || '');
    const startDate = String(req.query.startDate || '1900-01-01');
    const endDate = String(req.query.endDate || '2999-12-31');
    const costCenterId =
      typeof req.query.costCenterId === 'string' && req.query.costCenterId ? req.query.costCenterId : null;

    if (!accountId) throw new AppError(400, 'يجب تحديد الحساب لعرض كشف الأستاذ.', 'VALIDATION_ERROR');

    const report = await buildAccountLedger(accountId, startDate, endDate, costCenterId);
    res.json({ report });
  }),
);

app.get(
  '/api/reports/trial-balance',
  requireAuth,
  wrap(async (req, res) => {
    const startDate = String(req.query.startDate || '1900-01-01');
    const endDate = String(req.query.endDate || '2999-12-31');
    const costCenterId =
      typeof req.query.costCenterId === 'string' && req.query.costCenterId ? req.query.costCenterId : null;

    const report = await buildTrialBalance(startDate, endDate, costCenterId);
    res.json({ report });
  }),
);

app.get(
  '/api/reports/cost-centers',
  requireAuth,
  wrap(async (req, res) => {
    const startDate = String(req.query.startDate || '1900-01-01');
    const endDate = String(req.query.endDate || '2999-12-31');

    const report = await buildCostCenterProfitability(startDate, endDate);
    res.json({ report });
  }),
);

app.get(
  '/api/reports/income-statement',
  requireAuth,
  wrap(async (req, res) => {
    const startDate = String(req.query.startDate || '1900-01-01');
    const endDate = String(req.query.endDate || '2999-12-31');
    const costCenterId =
      typeof req.query.costCenterId === 'string' && req.query.costCenterId ? req.query.costCenterId : null;

    const report = await buildIncomeStatement(startDate, endDate, costCenterId);
    res.json({ report });
  }),
);

app.get(
  '/api/reports/balance-sheet',
  requireAuth,
  wrap(async (req, res) => {
    const asOfDate = String(req.query.asOfDate || new Date().toISOString().slice(0, 10));
    const costCenterId =
      typeof req.query.costCenterId === 'string' && req.query.costCenterId ? req.query.costCenterId : null;

    const report = await buildBalanceSheet(asOfDate, costCenterId);
    res.json({ report });
  }),
);

app.get(
  '/api/reports/export/xlsx',
  requireAuth,
  wrap(async (req, res) => {
    const type = String(req.query.type || '');
    const startDate = String(req.query.startDate || '1900-01-01');
    const endDate = String(req.query.endDate || '2999-12-31');
    const asOfDate = String(req.query.asOfDate || new Date().toISOString().slice(0, 10));
    const costCenterId =
      typeof req.query.costCenterId === 'string' && req.query.costCenterId ? req.query.costCenterId : null;
    const accountId = String(req.query.accountId || '');

    let payload: unknown;
    if (type === 'ledger') {
      if (!accountId) throw new AppError(400, 'يجب تحديد الحساب.', 'VALIDATION_ERROR');
      payload = await buildAccountLedger(accountId, startDate, endDate, costCenterId);
    } else if (type === 'trial-balance') {
      payload = await buildTrialBalance(startDate, endDate, costCenterId);
    } else if (type === 'cost-centers') {
      payload = await buildCostCenterProfitability(startDate, endDate);
    } else if (type === 'income-statement') {
      payload = await buildIncomeStatement(startDate, endDate, costCenterId);
    } else if (type === 'balance-sheet') {
      payload = await buildBalanceSheet(asOfDate, costCenterId);
    } else {
      throw new AppError(400, 'نوع التقرير المطلوب غير مدعوم.', 'INVALID_REPORT_TYPE');
    }

    const { buffer, filename } = generateReportWorkbookBuffer(
      type as 'ledger' | 'trial-balance' | 'cost-centers' | 'income-statement' | 'balance-sheet',
      payload,
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

// ============================================================================
// DASHBOARD (REAL DATABASE AGGREGATES ONLY)
// ============================================================================

app.get(
  '/api/dashboard',
  requireAuth,
  wrap(async (_req, res) => {
    const [
      accounts,
      costCenters,
      entriesRes,
      recentJournalsRes,
      recentReceiptsRes,
      recentPaymentsRes,
      postedFacts,
    ] = await Promise.all([
      fetchAllAccounts(),
      fetchAllCostCenters(),
      dbQuery<{ id: string; status: string; total_debit: number; total_credit: number }>(
        'SELECT id, status, total_debit, total_credit FROM public.journal_entries',
      ),
      dbQuery<JournalEntry>(
        `SELECT je.*, jsonb_build_object('id', c.id, 'full_name', c.full_name) AS creator
         FROM public.journal_entries je
         LEFT JOIN public.profiles c ON c.id = je.created_by
         ORDER BY je.created_at DESC
         LIMIT 5`,
      ),
      dbQuery<Voucher>(
        `SELECT v.*, jsonb_build_object('id', ca.id, 'code', ca.code, 'name_ar', ca.name_ar) AS cash_bank_account
         FROM public.vouchers v
         JOIN public.accounts ca ON ca.id = v.cash_bank_account_id
         WHERE v.voucher_type = 'RECEIPT'
         ORDER BY v.created_at DESC
         LIMIT 5`,
      ),
      dbQuery<Voucher>(
        `SELECT v.*, jsonb_build_object('id', ca.id, 'code', ca.code, 'name_ar', ca.name_ar) AS cash_bank_account
         FROM public.vouchers v
         JOIN public.accounts ca ON ca.id = v.cash_bank_account_id
         WHERE v.voucher_type = 'PAYMENT'
         ORDER BY v.created_at DESC
         LIMIT 5`,
      ),
      fetchPostedLineFacts(),
    ]);

    const allEntries = entriesRes.rows;
    let draftCount = 0;
    let postedCount = 0;
    let totalDebitMovements = new Decimal(0);
    let totalCreditMovements = new Decimal(0);

    for (const je of allEntries) {
      if (je.status === 'POSTED') {
        postedCount++;
        totalDebitMovements = totalDebitMovements.plus(je.total_debit || 0);
        totalCreditMovements = totalCreditMovements.plus(je.total_credit || 0);
      } else {
        draftCount++;
      }
    }

    const accountMap = new Map(accounts.map((a) => [a.id, a]));
    let totalRevenue = new Decimal(0);
    let totalExpenses = new Decimal(0);

    for (const f of postedFacts) {
      const acc = accountMap.get(f.account_id);
      if (!acc) continue;
      const d = new Decimal(f.debit);
      const c = new Decimal(f.credit);
      if (acc.account_type === 'REVENUE') {
        totalRevenue = totalRevenue.plus(c.minus(d));
      } else if (acc.account_type === 'EXPENSE') {
        totalExpenses = totalExpenses.plus(d.minus(c));
      }
    }

    res.json({
      summary: {
        totalAccounts: accounts.length,
        activeAccounts: accounts.filter((a) => a.status === 'ACTIVE').length,
        totalCostCenters: costCenters.length,
        totalJournalEntries: allEntries.length,
        draftJournalEntries: draftCount,
        postedJournalEntries: postedCount,
        totalDebitMovements: totalDebitMovements.toDecimalPlaces(2).toNumber(),
        totalCreditMovements: totalCreditMovements.toDecimalPlaces(2).toNumber(),
        totalRevenue: totalRevenue.toDecimalPlaces(2).toNumber(),
        totalExpenses: totalExpenses.toDecimalPlaces(2).toNumber(),
        netProfit: totalRevenue.minus(totalExpenses).toDecimalPlaces(2).toNumber(),
        recentJournals: recentJournalsRes.rows,
        recentReceipts: recentReceiptsRes.rows,
        recentPayments: recentPaymentsRes.rows,
      },
    });
  }),
);

// Unmatched /api/* JSON 404 (prevents falling through to SPA HTML middleware)
app.all('/api/*', (_req, res) => {
  res.status(404).json({
    error: 'نقطة النهاية المطلوبة غير موجودة.',
    code: 'NOT_FOUND',
  });
});

// Global error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const mapped = mapDatabaseError(err);
  res.status(mapped.status).json({
    error: mapped.message,
    code: mapped.code,
  });
});
