export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = 'APP_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function mapDatabaseError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const message =
    typeof err === 'object' && err !== null && 'message' in err
      ? String((err as { message: unknown }).message)
      : String(err);

  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';

  const knownPrefixes = [
    'NO_ACCOUNTING_PERIOD:',
    'CLOSED_ACCOUNTING_PERIOD:',
    'PERIOD_OVERLAP:',
    'INVALID_PARENT_ACCOUNT:',
    'PARENT_IS_POSTABLE:',
    'CIRCULAR_ACCOUNT_HIERARCHY:',
    'ACCOUNT_HAS_CHILDREN:',
    'ACCOUNT_HAS_TRANSACTIONS:',
    'ACTIVE_CHILD_ACCOUNTS:',
    'ACCOUNT_IN_DRAFT_TRANSACTIONS:',
    'INVALID_PARENT_COST_CENTER:',
    'CIRCULAR_COST_CENTER_HIERARCHY:',
    'ACTIVE_CHILD_COST_CENTERS:',
    'POSTED_ENTRY_IMMUTABLE:',
    'CLOSED_PERIOD_IMMUTABLE:',
    'INVALID_ACCOUNT:',
    'COST_CENTER_REQUIRED:',
    'INVALID_COST_CENTER:',
    'POSTED_VOUCHER_IMMUTABLE:',
    'MIN_TWO_LINES:',
    'UNBALANCED_JOURNAL:',
    'UNAUTHORIZED_ACTOR:',
    'VOUCHER_JOURNAL_LOCKED:',
    'FORBIDDEN:',
    'ADMIN_REQUIRED:',
    'ALREADY_POSTED:',
    'INVALID_LINES_AT_POSTING:',
    'INVALID_CASH_ACCOUNT:',
    'INVALID_COUNTER_ACCOUNT:',
    'INVALID_AMOUNT:',
    'SAME_ACCOUNTS:',
    'INVALID_VOUCHER_TYPE:',
    'ONLY_POSTED_REVERSIBLE:',
    'ALREADY_REVERSED:',
    'REVERSAL_REQUIRED_BEFORE_DELETE:',
    'HAS_REVERSAL_DEPENDENCY:',
    'INVALID_VOUCHER_ACTION:',
    'BATCH_DELETE_BLOCKED:',
    'INVALID_DELETION_MODE:',
    'NOT_FOUND:',
  ];

  for (const prefix of knownPrefixes) {
    const idx = message.indexOf(prefix);
    if (idx !== -1) {
      const clean = message.slice(idx + prefix.length).trim();
      const status =
        prefix === 'FORBIDDEN:' || prefix === 'ADMIN_REQUIRED:' || prefix === 'UNAUTHORIZED_ACTOR:'
          ? 403
          : prefix === 'NOT_FOUND:'
            ? 404
            : prefix === 'ALREADY_REVERSED:' ||
                prefix === 'HAS_REVERSAL_DEPENDENCY:' ||
                prefix === 'BATCH_DELETE_BLOCKED:'
              ? 409
              : 400;
      return new AppError(status, clean || 'تعذر تنفيذ العملية المحاسبية.', prefix.replace(':', ''));
    }
  }

  if (code === '23505') {
    if (message.includes('idx_profiles_username_lower_unique') || message.includes('username')) {
      return new AppError(409, 'اسم المستخدم مستخدم بالفعل، يرجى اختيار اسم مستخدم آخر.', 'USERNAME_TAKEN');
    }
    if (message.includes('idx_journal_entries_unique_reversal')) {
      return new AppError(409, 'تم إنشاء قيد عكسي لهذا القيد مسبقاً.', 'ALREADY_REVERSED');
    }
    return new AppError(409, 'توجد قيمة مكررة بالفعل (الرمز أو اسم المستخدم مستخدم مسبقاً).', 'DUPLICATE_VALUE');
  }
  if (code === '23503') {
    return new AppError(400, 'لا يمكن حذف أو تعديل هذا السجل لارتباطه بحركات أو سجلات أخرى.', 'FOREIGN_KEY_CONSTRAINT');
  }
  if (code === '23514') {
    return new AppError(400, 'القيم المدخلة تخالف القيود المحاسبية للنظام.', 'CHECK_CONSTRAINT');
  }

  return new AppError(500, 'حدث خطأ في معالجة الطلب على قاعدة البيانات.', 'INTERNAL_ERROR');
}
