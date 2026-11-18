import { z } from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const usernameSchema = z
  .string()
  .trim()
  .min(2, 'اسم المستخدم يجب أن يكون حرفين على الأقل')
  .max(50, 'اسم المستخدم طويل جداً')
  .refine((val) => !/\s/.test(val), 'اسم المستخدم لا يجب أن يحتوي على مسافات');

export const passwordSchema = z
  .string()
  .min(6, 'كلمة المرور يجب أن تكون 6 أحرف على الأقل');

export const setupAdminSchema = z.object({
  full_name: z.string().trim().min(2, 'الاسم الكامل يجب أن يكون حرفين على الأقل').max(100),
  username: usernameSchema,
  password: passwordSchema,
});

export const createUserSchema = z.object({
  full_name: z.string().trim().min(2, 'الاسم الكامل مطلوب').max(100),
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(['ADMIN', 'USER'], { error: 'الدور الوظيفي غير صالح' }),
});

export const updateUserSchema = z.object({
  full_name: z.string().trim().min(2, 'الاسم الكامل مطلوب').max(100).optional(),
  username: usernameSchema.optional(),
  password: passwordSchema.optional(),
  role: z.enum(['ADMIN', 'USER']).optional(),
  is_active: z.boolean().optional(),
});

export const accountSchema = z.object({
  code: z.string().trim().min(1, 'رمز الحساب مطلوب').max(30),
  name_ar: z.string().trim().min(2, 'اسم الحساب بالعربية مطلوب').max(150),
  account_type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  normal_balance: z.enum(['DEBIT', 'CREDIT']),
  parent_id: z.string().uuid().nullable().optional(),
  is_postable: z.boolean(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
  cost_center_required: z.boolean().default(false),
});

export const costCenterSchema = z.object({
  code: z.string().trim().min(1, 'رمز مركز التكلفة مطلوب').max(30),
  name_ar: z.string().trim().min(2, 'اسم مركز التكلفة مطلوب').max(150),
  description: z.string().trim().max(500).nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const periodSchema = z
  .object({
    name_ar: z.string().trim().min(2, 'اسم الفترة المحاسبية مطلوب').max(120),
    start_date: z.string().regex(dateRegex, 'تاريخ البداية غير صالح'),
    end_date: z.string().regex(dateRegex, 'تاريخ النهاية غير صالح'),
  })
  .refine((data) => data.end_date >= data.start_date, {
    message: 'تاريخ النهاية يجب أن يكون مساوياً أو لاحقاً لتاريخ البداية',
    path: ['end_date'],
  });

export const journalLineInputSchema = z
  .object({
    account_id: z.string().uuid('يجب اختيار حساب صحيح'),
    cost_center_id: z.string().uuid().nullable().optional(),
    debit: z.number().nonnegative('المبلغ المدين لا يمكن أن يكون سالباً').finite(),
    credit: z.number().nonnegative('المبلغ الدائن لا يمكن أن يكون سالباً').finite(),
    description: z.string().trim().max(300).nullable().optional(),
  })
  .refine((line) => (line.debit > 0 && line.credit === 0) || (line.credit > 0 && line.debit === 0), {
    message: 'يجب أن يحتوي السطر على مبلغ في خانة المدين فقط أو الدائن فقط وأكبر من صفر',
  });

export const journalEntrySchema = z.object({
  entry_date: z.string().regex(dateRegex, 'تاريخ القيد غير صالح'),
  description: z.string().trim().min(2, 'وصف القيد مطلوب').max(400),
  reference_number: z.string().trim().max(80).nullable().optional(),
  cost_center_id: z.string().uuid('مركز التكلفة غير صالح').nullable().optional(),
  lines: z.array(journalLineInputSchema).min(2, 'يجب إدخال سطرين على الأقل في القيد المحاسبي'),
});

export const reverseJournalSchema = z.object({
  entry_date: z.string().regex(dateRegex, 'تاريخ القيد العكسي غير صالح'),
});

export const deleteJournalSchema = z.object({
  voucher_action: z.enum(['KEEP_DRAFT', 'DELETE_VOUCHER']).default('KEEP_DRAFT'),
});

export const voucherSchema = z
  .object({
    voucher_type: z.enum(['RECEIPT', 'PAYMENT']),
    voucher_date: z.string().regex(dateRegex, 'تاريخ السند غير صالح'),
    payment_method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD']),
    cash_bank_account_id: z.string().uuid('يجب اختيار حساب الصندوق أو البنك'),
    counter_account_id: z.string().uuid('يجب اختيار الحساب المقابل'),
    party_name: z.string().trim().min(2, 'اسم الطرف مطلوب').max(150),
    amount: z.number().positive('المبلغ يجب أن يكون أكبر من صفر').finite(),
    description: z.string().trim().min(2, 'البيان مطلوب').max(400),
    reference_number: z.string().trim().max(80).nullable().optional(),
    cost_center_id: z.string().uuid().nullable().optional(),
    finalize_immediately: z.boolean().optional(),
  })
  .refine((v) => v.cash_bank_account_id !== v.counter_account_id, {
    message: 'لا يمكن أن يكون حساب الصندوق/البنك هو نفسه الحساب المقابل',
    path: ['counter_account_id'],
  });
