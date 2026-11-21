import { z } from 'zod';
import { isValidTargetForField } from './accountImportValidator.ts';
import type { AccountImportMappableFieldKey } from './types.ts';

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

export const accountImportMappingSchema = z
  .object({
    code: z.number().int().min(0).nullable().optional(),
    name_ar: z.number().int().min(0).nullable().optional(),
    parent_code: z.number().int().min(0).nullable().optional(),
    parent_name: z.number().int().min(0).nullable().optional(),
    level: z.number().int().min(0).nullable().optional(),
    account_type: z.number().int().min(0).nullable().optional(),
    normal_balance: z.number().int().min(0).nullable().optional(),
    is_postable: z.number().int().min(0).nullable().optional(),
    status: z.number().int().min(0).nullable().optional(),
    cost_center_required: z.number().int().min(0).nullable().optional(),
  })
  .optional();

export const mappableFieldKeySchema = z.enum([
  'account_type',
  'normal_balance',
  'is_postable',
  'status',
  'cost_center_required',
]);

export const fieldValueMappingsSchema = z
  .object({
    account_type: z.record(z.string(), z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'])).optional(),
    normal_balance: z.record(z.string(), z.enum(['DEBIT', 'CREDIT'])).optional(),
    is_postable: z.record(z.string(), z.enum(['GROUP', 'POSTING'])).optional(),
    status: z.record(z.string(), z.enum(['ACTIVE', 'INACTIVE'])).optional(),
    cost_center_required: z.record(z.string(), z.enum(['REQUIRED', 'OPTIONAL'])).optional(),
  })
  .optional();

export const postingValueMappingsRecordSchema = z
  .record(z.string(), z.enum(['GROUP', 'POSTING']))
  .optional();

export const inspectAccountImportSchema = z.object({
  fileName: z.string().trim().min(1, 'اسم الملف مطلوب').max(255),
  fileBase64: z.string().min(1, 'محتوى الملف مطلوب'),
  sheetName: z.string().trim().min(1).max(200).optional(),
});

export const discoverUnifiedValuesSchema = z.object({
  fileName: z.string().trim().min(1, 'اسم الملف مطلوب').max(255),
  fileBase64: z.string().min(1, 'محتوى الملف مطلوب'),
  sheetName: z.string().trim().min(1).max(200).optional(),
  mapping: accountImportMappingSchema,
});

export const discoverPostingLevelsSchema = z.object({
  fileName: z.string().trim().min(1, 'اسم الملف مطلوب').max(255),
  fileBase64: z.string().min(1, 'محتوى الملف مطلوب'),
  sheetName: z.string().trim().min(1).max(200).optional(),
  postingColumnIndex: z.number().int().min(0, 'يجب ربط عمود مستوى الترحيل أولاً'),
});

export const saveValueMappingsSchema = z.object({
  mappings: z
    .array(
      z
        .object({
          field_key: mappableFieldKeySchema,
          source_value: z.string().trim().min(1, 'القيمة الأصلية مطلوبة').max(150),
          internal_target: z.string().trim().min(1, 'التصنيف الداخلي مطلوب').max(50),
        })
        .superRefine((item, ctx) => {
          if (!isValidTargetForField(item.field_key as AccountImportMappableFieldKey, item.internal_target)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `التصنيف "${item.internal_target}" غير صالح للحقل "${item.field_key}"`,
              path: ['internal_target'],
            });
          }
        }),
    )
    .min(1, 'يجب تحديد مطابقة واحدة على الأقل'),
});

export const savePostingMappingsSchema = z.object({
  mappings: z
    .array(
      z.object({
        source_value: z.string().trim().min(1, 'القيمة الأصلية مطلوبة').max(150),
        internal_target: z.enum(['GROUP', 'POSTING']),
      }),
    )
    .min(1, 'يجب تحديد مطابقة واحدة على الأقل'),
});

export const previewAccountImportSchema = z.object({
  fileName: z.string().trim().min(1, 'اسم الملف مطلوب').max(255),
  fileBase64: z.string().min(1, 'محتوى الملف مطلوب'),
  sheetName: z.string().trim().min(1).max(200).optional(),
  mapping: accountImportMappingSchema,
  mode: z.enum(['ADD_NEW', 'UPDATE_EXISTING']),
  createMissingInUpdateMode: z.boolean().optional().default(false),
  postingValueMappings: postingValueMappingsRecordSchema,
  fieldValueMappings: fieldValueMappingsSchema,
});

export const executeAccountImportSchema = z.object({
  fileName: z.string().trim().min(1, 'اسم الملف مطلوب').max(255),
  fileBase64: z.string().min(1, 'محتوى الملف مطلوب'),
  sheetName: z.string().trim().min(1).max(200).optional(),
  mapping: accountImportMappingSchema,
  mode: z.enum(['ADD_NEW', 'UPDATE_EXISTING']),
  createMissingInUpdateMode: z.boolean().optional().default(false),
  postingValueMappings: postingValueMappingsRecordSchema,
  savePostingMappings: z.boolean().optional().default(false),
  fieldValueMappings: fieldValueMappingsSchema,
  saveValueMappings: z.boolean().optional().default(false),
  skipInvalidRows: z.boolean().optional().default(false),
  confirmReviewRows: z.boolean().optional().default(false),
  confirmExistingUpdates: z.boolean().optional().default(false),
});

export const journalImportMappingSchema = z.object({
  entry_group: z.number().int().min(0).nullable().optional(),
  entry_date: z.number().int().min(0).nullable().optional(),
  description: z.number().int().min(0).nullable().optional(),
  reference_number: z.number().int().min(0).nullable().optional(),
  cost_center_code: z.number().int().min(0).nullable().optional(),
  account_code: z.number().int().min(0).nullable().optional(),
  debit: z.number().int().min(0).nullable().optional(),
  credit: z.number().int().min(0).nullable().optional(),
  line_description: z.number().int().min(0).nullable().optional(),
});

export const inspectJournalImportSchema = z.object({
  fileName: z.string().trim().min(1, 'اسم الملف مطلوب').max(255),
  fileBase64: z.string().min(1, 'محتوى الملف مطلوب'),
});

export const previewJournalImportSchema = z.object({
  fileName: z.string().trim().min(1, 'اسم الملف مطلوب').max(255),
  fileBase64: z.string().min(1, 'محتوى الملف مطلوب'),
  sheetNames: z.array(z.string().trim().min(1).max(200)).min(1, 'يرجى اختيار ورقة عمل واحدة على الأقل'),
  mappingsBySheet: z.record(z.string().min(1), journalImportMappingSchema),
});

export const executeJournalImportSchema = z.object({
  fileName: z.string().trim().min(1, 'اسم الملف مطلوب').max(255),
  fileBase64: z.string().min(1, 'محتوى الملف مطلوب'),
  sheetNames: z.array(z.string().trim().min(1).max(200)).min(1, 'يرجى اختيار ورقة عمل واحدة على الأقل'),
  mappingsBySheet: z.record(z.string().min(1), journalImportMappingSchema),
  skipRejectedEntries: z.boolean().optional().default(true),
});

export const deleteJournalImportBatchSchema = z.object({
  mode: z.enum(['DELETE_BATCH_AND_ENTRIES', 'DELETE_HISTORY_ONLY']),
  confirm: z.literal(true, {
    message: 'يجب تأكيد عملية الحذف صراحةً قبل التنفيذ.',
  }),
});

export const bulkJournalPostFiltersSchema = z
  .object({
    search: z.string().max(200).optional().default(''),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة تاريخ البداية غير صالحة')
      .optional()
      .or(z.literal('')),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة تاريخ النهاية غير صالحة')
      .optional()
      .or(z.literal('')),
  })
  .optional()
  .default({ search: '', startDate: '', endDate: '' });

export const bulkJournalPostPreviewSchema = z
  .object({
    mode: z.enum(['SELECTED', 'ALL_DRAFTS']),
    entryIds: z.array(z.string().uuid('معرف القيد غير صالح')).max(5000).optional(),
    filters: bulkJournalPostFiltersSchema,
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'SELECTED' && (!val.entryIds || val.entryIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'يجب تحديد قيد مسودة واحد على الأقل.',
        path: ['entryIds'],
      });
    }
  });

export const bulkJournalPostExecuteSchema = z
  .object({
    mode: z.enum(['SELECTED', 'ALL_DRAFTS']),
    entryIds: z.array(z.string().uuid('معرف القيد غير صالح')).max(5000).optional(),
    filters: bulkJournalPostFiltersSchema,
    confirm: z.literal(true, {
      message: 'يجب تأكيد عملية الترحيل الجماعي صراحةً قبل التنفيذ.',
    }),
    stream: z.boolean().optional().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'SELECTED' && (!val.entryIds || val.entryIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'يجب تحديد قيد مسودة واحد على الأقل.',
        path: ['entryIds'],
      });
    }
  });


