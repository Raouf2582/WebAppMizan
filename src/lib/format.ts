import type {
  AccountType,
  EntityStatus,
  JournalSourceType,
  JournalStatus,
  NormalBalance,
  PaymentMethod,
  PeriodStatus,
  UserRole,
  VoucherType,
} from '../shared/types.ts';

export function formatMoney(value: number | string | null | undefined): string {
  const num = Number(value ?? 0);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(num) ? num : 0);
}

export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '-';
  return isoDate.slice(0, 10);
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  ASSET: 'الأصول',
  LIABILITY: 'الالتزامات',
  EQUITY: 'حقوق الملكية',
  REVENUE: 'الإيرادات',
  EXPENSE: 'المصروفات',
};

export const NORMAL_BALANCE_LABELS: Record<NormalBalance, string> = {
  DEBIT: 'مدين',
  CREDIT: 'دائن',
};

export const ENTITY_STATUS_LABELS: Record<EntityStatus, string> = {
  ACTIVE: 'نشط',
  INACTIVE: 'غير نشط',
};

export const PERIOD_STATUS_LABELS: Record<PeriodStatus, string> = {
  OPEN: 'مفتوحة',
  CLOSED: 'مغلقة',
};

export const JOURNAL_STATUS_LABELS: Record<JournalStatus, string> = {
  DRAFT: 'مسودة',
  POSTED: 'مرحل',
};

export const JOURNAL_SOURCE_LABELS: Record<JournalSourceType, string> = {
  MANUAL: 'قيد يدوي',
  RECEIPT_VOUCHER: 'سند قبض',
  PAYMENT_VOUCHER: 'سند صرف',
};

export const VOUCHER_TYPE_LABELS: Record<VoucherType, string> = {
  RECEIPT: 'سند قبض',
  PAYMENT: 'سند صرف',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'نقداً (صندوق)',
  BANK_TRANSFER: 'تحويل بنكي',
  CHEQUE: 'شيك',
  CARD: 'بطاقة بنكية',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'مدير النظام',
  USER: 'مستخدم محاسبي',
};
