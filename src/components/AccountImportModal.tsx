import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookmarkCheck,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Info,
  RefreshCw,
  Settings2,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { apiRequest, downloadExcelFile } from '../lib/api.ts';
import {
  ACCOUNT_TYPE_LABELS,
  ENTITY_STATUS_LABELS,
  NORMAL_BALANCE_LABELS,
} from '../lib/format.ts';
import type {
  AccountImportClassification,
  AccountImportColumnMapping,
  AccountImportExecuteResult,
  AccountImportFieldDefinition,
  AccountImportFieldKey,
  AccountImportFieldOption,
  AccountImportInspectResult,
  AccountImportMappableFieldKey,
  AccountImportMode,
  AccountImportPreviewResult,
  AccountImportPreviewRow,
  PostingLevelMatchSource,
  SavedImportValueMapping,
  UnifiedFieldValueMappings,
  UnifiedValueDiscoveryResult,
} from '../shared/types.ts';
import { ModalShell } from './ui.tsx';

interface FieldDescriptor {
  key: AccountImportFieldKey;
  label: string;
  required: boolean;
  hint: string;
}

const IMPORT_FIELDS: FieldDescriptor[] = [
  { key: 'code', label: 'رمز الحساب', required: true, hint: 'المعرف الفريد للحساب' },
  { key: 'name_ar', label: 'اسم الحساب', required: true, hint: 'الاسم بالعربية (حرفان على الأقل)' },
  { key: 'parent_code', label: 'رمز الحساب الأب', required: false, hint: 'فارغ للحسابات الرئيسية بالمستوى 1' },
  { key: 'parent_name', label: 'اسم الحساب الأب', required: false, hint: 'اختياري للمطابقة أو التحقق الإضافي' },
  { key: 'level', label: 'المستوى', required: false, hint: 'المستوى الهرمي (1، 2، 3...)' },
  { key: 'account_type', label: 'نوع الحساب', required: true, hint: 'الأصول / الالتزامات / حقوق الملكية / الإيرادات / المصروفات' },
  { key: 'normal_balance', label: 'طبيعة الحساب', required: true, hint: 'مدين أو دائن' },
  { key: 'is_postable', label: 'مستوى الترحيل', required: true, hint: 'تجميعي (GROUP) / قابل للترحيل (POSTING)' },
  { key: 'status', label: 'الحالة', required: false, hint: 'نشط أو غير نشط (الافتراضي: نشط)' },
  { key: 'cost_center_required', label: 'إلزامية مركز التكلفة', required: false, hint: 'إلزامي / اختياري (الافتراضي: اختياري)' },
];

const CLASSIFICATION_META: Record<
  AccountImportClassification,
  { label: string; tone: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  VALID: { label: 'صالح للاستيراد', tone: 'text-emerald-700 bg-emerald-50 border-emerald-200', Icon: CheckCircle2 },
  INVALID: { label: 'غير صالح', tone: 'text-red-700 bg-red-50 border-red-200', Icon: XCircle },
  EXISTING: { label: 'موجود مسبقاً', tone: 'text-slate-700 bg-slate-100 border-slate-200', Icon: Info },
  REQUIRES_REVIEW: { label: 'يتطلب مراجعة', tone: 'text-amber-800 bg-amber-50 border-amber-200', Icon: AlertTriangle },
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error('تعذر قراءة الملف المحدد.'));
    reader.readAsDataURL(file);
  });
}

const MATCH_SOURCE_META: Record<
  PostingLevelMatchSource,
  { label: string; tone: string }
> = {
  SAVED: { label: 'مطابقة محفوظة', tone: 'border-blue-200 bg-blue-50 text-blue-800' },
  AUTO: { label: 'مطابقة تلقائية', tone: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  UNMATCHED: { label: 'غير معروفة — تتطلب مطابقة يدوية', tone: 'border-amber-200 bg-amber-50 text-amber-800' },
};

const EMPTY_FIELD_MAPPINGS: Record<AccountImportMappableFieldKey, Record<string, string>> = {
  account_type: {},
  normal_balance: {},
  is_postable: {},
  status: {},
  cost_center_required: {},
};

export function AccountImportModal({
  open,
  onClose,
  onImported,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [step, setStep] = useState<'upload' | 'value_mapping' | 'preview' | 'result'>('upload');
  const [fileName, setFileName] = useState('');
  const [fileBase64, setFileBase64] = useState('');
  const [inspection, setInspection] = useState<AccountImportInspectResult | null>(null);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [mapping, setMapping] = useState<AccountImportColumnMapping>({});
  const [mode, setMode] = useState<AccountImportMode>('ADD_NEW');
  const [createMissingInUpdateMode, setCreateMissingInUpdateMode] = useState(false);

  const [discovery, setDiscovery] = useState<UnifiedValueDiscoveryResult | null>(null);
  const [fieldValueMappings, setFieldValueMappings] = useState<
    Record<AccountImportMappableFieldKey, Record<string, string>>
  >({ ...EMPTY_FIELD_MAPPINGS });
  const [valueFilterField, setValueFilterField] = useState<
    'ALL' | 'UNMATCHED' | AccountImportMappableFieldKey
  >('ALL');
  const [saveValueMappings, setSaveValueMappings] = useState(true);
  const [showSavedMappings, setShowSavedMappings] = useState(false);
  const [savedMappings, setSavedMappings] = useState<SavedImportValueMapping[]>([]);
  const [savedFieldDefs, setSavedFieldDefs] = useState<AccountImportFieldDefinition[]>([]);
  const [savedMappingsBusy, setSavedMappingsBusy] = useState(false);

  const [preview, setPreview] = useState<AccountImportPreviewResult | null>(null);
  const [filterClass, setFilterClass] = useState<AccountImportClassification | 'ALL'>('ALL');
  const [skipInvalidRows, setSkipInvalidRows] = useState(false);
  const [confirmReviewRows, setConfirmReviewRows] = useState(false);
  const [confirmExistingUpdates, setConfirmExistingUpdates] = useState(false);

  const [executeResult, setExecuteResult] = useState<AccountImportExecuteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState('');

  function resetAll() {
    setStep('upload');
    setFileName('');
    setFileBase64('');
    setInspection(null);
    setSelectedSheet('');
    setMapping({});
    setMode('ADD_NEW');
    setCreateMissingInUpdateMode(false);
    setDiscovery(null);
    setFieldValueMappings({ ...EMPTY_FIELD_MAPPINGS });
    setValueFilterField('ALL');
    setSaveValueMappings(true);
    setShowSavedMappings(false);
    setPreview(null);
    setFilterClass('ALL');
    setSkipInvalidRows(false);
    setConfirmReviewRows(false);
    setConfirmExistingUpdates(false);
    setExecuteResult(null);
    setInlineError('');
  }

  function handleClose() {
    resetAll();
    onClose();
  }

  async function handleFileSelect(file: File | null) {
    if (!file) return;
    setInlineError('');
    setDiscovery(null);
    setFieldValueMappings({ ...EMPTY_FIELD_MAPPINGS });
    setPreview(null);
    setExecuteResult(null);

    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.xlsx') && !lower.endsWith('.xls')) {
      setInlineError('صيغة الملف غير مدعومة. يرجى اختيار ملف Excel بصيغة .xlsx أو .xls.');
      return;
    }

    setBusy(true);
    try {
      const b64 = await fileToBase64(file);
      const res = await apiRequest<{ inspection: AccountImportInspectResult }>(
        '/api/accounts/import/inspect',
        {
          method: 'POST',
          body: { fileName: file.name, fileBase64: b64 },
        },
      );
      setFileName(file.name);
      setFileBase64(b64);
      setInspection(res.inspection);
      setSelectedSheet(res.inspection.selectedSheet);
      setMapping(res.inspection.detectedMapping || {});
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'تعذر قراءة ملف Excel.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSheetChange(sheet: string) {
    if (!fileName || !fileBase64) return;
    setInlineError('');
    setDiscovery(null);
    setFieldValueMappings({ ...EMPTY_FIELD_MAPPINGS });
    setPreview(null);
    setBusy(true);
    try {
      const res = await apiRequest<{ inspection: AccountImportInspectResult }>(
        '/api/accounts/import/inspect',
        {
          method: 'POST',
          body: { fileName, fileBase64, sheetName: sheet },
        },
      );
      setInspection(res.inspection);
      setSelectedSheet(res.inspection.selectedSheet);
      setMapping(res.inspection.detectedMapping || {});
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'تعذر قراءة ورقة العمل المحددة.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadTemplate() {
    try {
      await downloadExcelFile(
        '/api/accounts/import/template',
        'chart_of_accounts_import_template.xlsx',
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل نموذج Excel.');
    }
  }

  const requiredFieldsMissing = useMemo(() => {
    return IMPORT_FIELDS.filter(
      (f) => f.required && (mapping[f.key] === undefined || mapping[f.key] === null),
    );
  }, [mapping]);

  const normalizedFieldMappings = useMemo<UnifiedFieldValueMappings>(() => {
    const out: UnifiedFieldValueMappings = {};
    for (const [fKey, rec] of Object.entries(fieldValueMappings)) {
      const cleaned: Record<string, string> = {};
      for (const [rawKey, targetVal] of Object.entries(rec)) {
        if (targetVal) cleaned[rawKey] = targetVal;
      }
      if (Object.keys(cleaned).length > 0) {
        out[fKey as AccountImportMappableFieldKey] = cleaned;
      }
    }
    return out;
  }, [fieldValueMappings]);

  const allDiscoveredRows = useMemo(() => {
    if (!discovery) return [];
    return discovery.columns.flatMap((col) =>
      col.items.map((item) => ({
        col,
        item,
      })),
    );
  }, [discovery]);

  const unresolvedTotalCount = useMemo(() => {
    return allDiscoveredRows.filter(({ col, item }) => {
      const chosen = fieldValueMappings[col.fieldKey]?.[item.rawValue] ?? '';
      return !chosen;
    }).length;
  }, [allDiscoveredRows, fieldValueMappings]);

  const filteredDiscoveredRows = useMemo(() => {
    return allDiscoveredRows.filter(({ col, item }) => {
      if (valueFilterField === 'UNMATCHED') {
        const chosen = fieldValueMappings[col.fieldKey]?.[item.rawValue] ?? '';
        return !chosen || item.matchSource === 'UNMATCHED';
      }
      if (valueFilterField !== 'ALL' && col.fieldKey !== valueFilterField) {
        return false;
      }
      return true;
    });
  }, [allDiscoveredRows, valueFilterField, fieldValueMappings]);

  const columnsWithBlanks = useMemo(() => {
    if (!discovery) return [];
    return discovery.columns.filter((c) => c.blankCount > 0);
  }, [discovery]);

  const totalBlankCells = useMemo(() => {
    return columnsWithBlanks.reduce((acc, c) => acc + c.blankCount, 0);
  }, [columnsWithBlanks]);

  const savedFieldDefMap = useMemo(() => {
    const map = new Map<AccountImportMappableFieldKey, AccountImportFieldDefinition>();
    for (const d of savedFieldDefs) {
      map.set(d.fieldKey, d);
    }
    if (discovery) {
      for (const d of discovery.fieldDefinitions) {
        if (!map.has(d.fieldKey)) map.set(d.fieldKey, d);
      }
    }
    return map;
  }, [savedFieldDefs, discovery]);

  async function loadSavedMappings() {
    setSavedMappingsBusy(true);
    try {
      const res = await apiRequest<{
        mappings: SavedImportValueMapping[];
        fieldDefinitions: AccountImportFieldDefinition[];
      }>('/api/accounts/import/value-mappings');
      setSavedMappings(res.mappings);
      setSavedFieldDefs(res.fieldDefinitions);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل المطابقات المحفوظة.');
    } finally {
      setSavedMappingsBusy(false);
    }
  }

  async function handleToggleSavedMappings() {
    const next = !showSavedMappings;
    setShowSavedMappings(next);
    if (next) {
      await loadSavedMappings();
    }
  }

  async function handleUpdateSavedMapping(
    item: SavedImportValueMapping,
    newTarget: string,
  ) {
    setSavedMappingsBusy(true);
    try {
      const res = await apiRequest<{ mappings: SavedImportValueMapping[] }>(
        '/api/accounts/import/value-mappings',
        {
          method: 'POST',
          body: {
            mappings: [
              {
                field_key: item.field_key,
                source_value: item.source_value,
                internal_target: newTarget,
              },
            ],
          },
        },
      );
      setSavedMappings(res.mappings);
      onNotify('success', `تم تحديث المطابقة المحفوظة للقيمة "${item.source_value}".`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحديث المطابقة المحفوظة.');
    } finally {
      setSavedMappingsBusy(false);
    }
  }

  async function handleDeleteSavedMapping(item: SavedImportValueMapping) {
    setSavedMappingsBusy(true);
    try {
      await apiRequest(`/api/accounts/import/value-mappings/${item.id}`, {
        method: 'DELETE',
      });
      setSavedMappings((prev) => prev.filter((m) => m.id !== item.id));
      onNotify('info', `تم حذف المطابقة المحفوظة للقيمة "${item.source_value}".`);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حذف المطابقة المحفوظة.');
    } finally {
      setSavedMappingsBusy(false);
    }
  }

  async function handleDiscoverValues() {
    if (!fileName || !fileBase64 || !selectedSheet) return;
    setInlineError('');

    if (requiredFieldsMissing.length > 0) {
      setInlineError(
        `يجب ربط جميع الأعمدة المطلوبة أولاً: ${requiredFieldsMissing.map((f) => f.label).join('، ')}.`,
      );
      return;
    }

    setBusy(true);
    try {
      const res = await apiRequest<{ discovery: UnifiedValueDiscoveryResult }>(
        '/api/accounts/import/discover-values',
        {
          method: 'POST',
          body: {
            fileName,
            fileBase64,
            sheetName: selectedSheet,
            mapping,
          },
        },
      );
      setDiscovery(res.discovery);
      const initial: Record<AccountImportMappableFieldKey, Record<string, string>> = {
        account_type: {},
        normal_balance: {},
        is_postable: {},
        status: {},
        cost_center_required: {},
      };
      for (const col of res.discovery.columns) {
        for (const item of col.items) {
          initial[col.fieldKey][item.rawValue] = item.suggestedTarget ?? '';
        }
      }
      setFieldValueMappings(initial);
      setValueFilterField('ALL');
      setStep('value_mapping');
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'تعذر اكتشاف قيم الأعمدة من الملف.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePreview(customMappings?: UnifiedFieldValueMappings) {
    if (!fileName || !fileBase64 || !selectedSheet) return;
    setInlineError('');

    if (unresolvedTotalCount > 0) {
      setInlineError(
        `لا يمكن الانتقال للمعاينة قبل حسم جميع القيم غير المعروفة (${unresolvedTotalCount} قيمة متبقية).`,
      );
      return;
    }

    setBusy(true);
    try {
      const effectiveFieldMappings = customMappings ?? normalizedFieldMappings;
      const res = await apiRequest<{ preview: AccountImportPreviewResult }>(
        '/api/accounts/import/preview',
        {
          method: 'POST',
          body: {
            fileName,
            fileBase64,
            sheetName: selectedSheet,
            mapping,
            mode,
            createMissingInUpdateMode,
            fieldValueMappings: effectiveFieldMappings,
          },
        },
      );
      setPreview(res.preview);
      setFilterClass('ALL');
      setSkipInvalidRows(false);
      setConfirmReviewRows(false);
      setConfirmExistingUpdates(false);
      setStep('preview');
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'تعذر فحص ومعاينة البيانات.');
    } finally {
      setBusy(false);
    }
  }

  const filteredPreviewRows = useMemo(() => {
    if (!preview) return [];
    if (filterClass === 'ALL') return preview.rows;
    return preview.rows.filter((r) => r.classification === filterClass);
  }, [preview, filterClass]);

  const executableReviewCount = useMemo(() => {
    if (!preview) return 0;
    return preview.rows.filter(
      (r) => r.classification === 'REQUIRES_REVIEW' && (r.action === 'INSERT' || r.action === 'UPDATE'),
    ).length;
  }, [preview]);

  const canExecute = useMemo(() => {
    if (!preview || busy) return false;
    const executableTotal = preview.summary.insertableCount + preview.summary.updatableCount;
    if (executableTotal === 0) return false;
    if (preview.summary.invalidCount > 0 && !skipInvalidRows) return false;
    if (executableReviewCount > 0 && !confirmReviewRows) return false;
    if (mode === 'UPDATE_EXISTING' && preview.summary.updatableCount > 0 && !confirmExistingUpdates) {
      return false;
    }
    return true;
  }, [
    preview,
    busy,
    skipInvalidRows,
    executableReviewCount,
    confirmReviewRows,
    mode,
    confirmExistingUpdates,
  ]);

  async function handleExecuteImport() {
    if (!preview) return;
    setInlineError('');
    setBusy(true);
    try {
      const res = await apiRequest<{ result: AccountImportExecuteResult }>(
        '/api/accounts/import/execute',
        {
          method: 'POST',
          body: {
            fileName,
            fileBase64,
            sheetName: selectedSheet,
            mapping,
            mode,
            createMissingInUpdateMode,
            fieldValueMappings: normalizedFieldMappings,
            saveValueMappings,
            skipInvalidRows,
            confirmReviewRows,
            confirmExistingUpdates,
          },
        },
      );
      setExecuteResult(res.result);
      setStep('result');
      await onImported();
      onNotify(
        'success',
        `تمت عملية الاستيراد (${res.result.log.operation_number}) بنجاح: إضافة ${res.result.importedCount}، تحديث ${res.result.updatedCount}.`,
      );
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'تعذر تنفيذ الاستيراد.');
    } finally {
      setBusy(false);
    }
  }

  function formatRowPostable(row: AccountImportPreviewRow) {
    if (row.normalized.is_postable === true) {
      return (
        <div>
          <span className="font-medium text-emerald-800">قابل للترحيل (POSTING)</span>
          {row.raw.is_postable && row.raw.is_postable !== 'قابل للترحيل' ? (
            <p className="text-[11px] text-slate-400">الأصل: {row.raw.is_postable}</p>
          ) : null}
        </div>
      );
    }
    if (row.normalized.is_postable === false) {
      return (
        <div>
          <span className="font-medium text-slate-800">تجميعي (GROUP)</span>
          {row.raw.is_postable && row.raw.is_postable !== 'تجميعي' ? (
            <p className="text-[11px] text-slate-400">الأصل: {row.raw.is_postable}</p>
          ) : null}
        </div>
      );
    }
    return row.raw.is_postable || '-';
  }

  function getOptionLabel(
    options: AccountImportFieldOption[],
    targetValue: string | null,
  ): string {
    if (!targetValue) return '—';
    return options.find((o) => o.value === targetValue)?.label ?? targetValue;
  }

  return (
    <ModalShell
      open={open}
      title="استيراد شجرة الحسابات من ملف Excel"
      onClose={handleClose}
      maxWidth="max-w-6xl"
    >
      {/* Stepper Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex flex-wrap items-center gap-2.5 text-xs font-semibold">
          <span className={step === 'upload' ? 'text-emerald-700' : 'text-slate-400'}>
            1. رفع الملف وربط الأعمدة
          </span>
          <span className="text-slate-300">/</span>
          <span className={step === 'value_mapping' ? 'text-emerald-700' : 'text-slate-400'}>
            2. مطابقة القيم والتصنيفات
          </span>
          <span className="text-slate-300">/</span>
          <span className={step === 'preview' ? 'text-emerald-700' : 'text-slate-400'}>
            3. المعاينة والفحص المحاسبي
          </span>
          <span className="text-slate-300">/</span>
          <span className={step === 'result' ? 'text-emerald-700' : 'text-slate-400'}>
            4. ملخص ونتيجة الاستيراد
          </span>
        </div>

        {step !== 'result' ? (
          <button
            type="button"
            onClick={() => void handleToggleSavedMappings()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Settings2 className="h-3.5 w-3.5 text-emerald-700" />
            <span>{showSavedMappings ? 'إخفاء المطابقات المحفوظة' : 'عرض وإدارة المطابقات المحفوظة'}</span>
          </button>
        ) : null}
      </div>

      {showSavedMappings && step !== 'result' ? (
        <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-bold text-slate-900">
                المطابقات المحفوظة لقيم الأعمدة والتصنيفات
              </h4>
              <p className="text-[11px] text-slate-600">
                تُطبق كل مطابقة ضمن نطاق حقلها فقط وتُستخدم تلقائياً في الملفات القادمة دون أي تعديل على الحسابات القائمة مسبقاً.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadSavedMappings()}
              disabled={savedMappingsBusy}
              className="flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${savedMappingsBusy ? 'animate-spin' : ''}`} />
              <span>تحديث</span>
            </button>
          </div>

          {savedMappingsBusy && savedMappings.length === 0 ? (
            <p className="text-xs text-slate-500">جاري تحميل المطابقات المحفوظة...</p>
          ) : savedMappings.length === 0 ? (
            <p className="rounded border border-dashed border-slate-300 bg-white px-3 py-3 text-center text-xs text-slate-500">
              لا توجد مطابقات محفوظة حالياً. يمكنك تفعيل خيار الحفظ في خطوة مطابقة القيم والتصنيفات.
            </p>
          ) : (
            <div className="max-h-56 overflow-auto rounded border border-slate-200 bg-white">
              <table className="w-full text-right text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">الحقل المرتبط</th>
                    <th className="px-3 py-2">القيمة في Excel</th>
                    <th className="px-3 py-2">التصنيف الداخلي المعتمد</th>
                    <th className="px-3 py-2">آخر تعديل بواسطة</th>
                    <th className="px-3 py-2 text-center">إجراء</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {savedMappings.map((m) => {
                    const def = savedFieldDefMap.get(m.field_key);
                    const opts = def?.options ?? [];
                    return (
                      <tr key={m.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-medium text-slate-700">
                          {def?.fieldLabel ?? m.field_key}
                        </td>
                        <td className="px-3 py-2 font-semibold text-slate-900">{m.source_value}</td>
                        <td className="px-3 py-2">
                          <select
                            value={m.internal_target}
                            disabled={savedMappingsBusy || opts.length === 0}
                            onChange={(e) => void handleUpdateSavedMapping(m, e.target.value)}
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-emerald-700 focus:outline-none"
                          >
                            {opts.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-slate-500">
                          {m.updater?.full_name || 'مدير النظام'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            type="button"
                            disabled={savedMappingsBusy}
                            onClick={() => void handleDeleteSavedMapping(m)}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                            title="حذف المطابقة المحفوظة"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>حذف</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {inlineError ? (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <span>{inlineError}</span>
        </div>
      ) : null}

      {/* STEP 1: UPLOAD & MAPPING */}
      {step === 'upload' ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-3">
              <FileSpreadsheet className="h-6 w-6 text-emerald-700 shrink-0" />
              <div>
                <p className="text-sm font-bold text-slate-900">رفع ملف Excel (.xlsx أو .xls)</p>
                <p className="text-xs text-slate-600">
                  يتعرف النظام تلقائياً على العناوين العربية والإنجليزية ويدعم اختلاف ترتيب الأعمدة والخلايا المدمجة.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadTemplate}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                <Download className="h-3.5 w-3.5" />
                <span>تحميل نموذج Excel فارغ</span>
              </button>
              <label className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800">
                <Upload className="h-3.5 w-3.5" />
                <span>{fileName ? 'تغيير الملف' : 'اختيار ملف Excel'}</span>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    e.target.value = '';
                    void handleFileSelect(f);
                  }}
                />
              </label>
            </div>
          </div>

          {busy && !inspection ? (
            <div className="p-6 text-center text-sm text-slate-500">جاري قراءة وتحليل ملف Excel...</div>
          ) : null}

          {inspection ? (
            <>
              {/* File & Sheet Selection + Mode */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-slate-200 p-4 space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span>الملف المحدد:</span>
                    <span className="font-mono font-semibold text-slate-900">{inspection.fileName}</span>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      ورقة العمل المطلوب استيرادها
                    </label>
                    <select
                      value={selectedSheet}
                      disabled={busy}
                      onChange={(e) => void handleSheetChange(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
                    >
                      {inspection.sheetNames.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-4 text-xs text-slate-600">
                    <span>صف العناوين: <strong className="text-slate-900">{inspection.headerRowNumber}</strong></span>
                    <span>عدد السجلات المكتشفة: <strong className="text-slate-900">{inspection.totalRawDataRows}</strong></span>
                    {inspection.blankRowsSkipped > 0 ? (
                      <span>صفوف فارغة متجاهلة: <strong className="text-slate-900">{inspection.blankRowsSkipped}</strong></span>
                    ) : null}
                  </div>
                </div>

                {/* Import Mode Options */}
                <div className="rounded-lg border border-slate-200 p-4 space-y-2.5">
                  <p className="text-xs font-bold text-slate-800">وضع الاستيراد</p>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 p-2.5 hover:bg-slate-50">
                    <input
                      type="radio"
                      name="import_mode"
                      checked={mode === 'ADD_NEW'}
                      onChange={() => setMode('ADD_NEW')}
                      className="mt-1 h-4 w-4 text-emerald-700"
                    />
                    <div>
                      <p className="text-xs font-bold text-slate-900">الخيار أ: إضافة حسابات جديدة فقط</p>
                      <p className="text-xs text-slate-500">
                        يستورد الحسابات غير الموجودة فقط ويحافظ على جميع الحسابات القائمة دون تعديل.
                      </p>
                    </div>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 p-2.5 hover:bg-slate-50">
                    <input
                      type="radio"
                      name="import_mode"
                      checked={mode === 'UPDATE_EXISTING'}
                      onChange={() => setMode('UPDATE_EXISTING')}
                      className="mt-1 h-4 w-4 text-emerald-700"
                    />
                    <div className="flex-1">
                      <p className="text-xs font-bold text-slate-900">الخيار ب: تحديث الحسابات القائمة</p>
                      <p className="text-xs text-slate-500">
                        يطابق الحسابات برمز الحساب ويعرض التغييرات لتأكيدها قبل التحديث مع حماية القيود التاريخية.
                      </p>
                      {mode === 'UPDATE_EXISTING' ? (
                        <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={createMissingInUpdateMode}
                            onChange={(e) => setCreateMissingInUpdateMode(e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-700"
                          />
                          <span>إنشاء الحسابات الجديدة غير الموجودة في قاعدة البيانات أيضاً</span>
                        </label>
                      ) : null}
                    </div>
                  </label>
                </div>
              </div>

              {/* Parse / Merge Warnings */}
              {inspection.parseWarnings.length > 0 ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
                  <p className="font-bold">تنبيهات قراءة بنية ملف Excel:</p>
                  {inspection.parseWarnings.map((w, idx) => (
                    <p key={idx}>• {w}</p>
                  ))}
                </div>
              ) : null}

              {/* Column Mapping */}
              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                  <span className="text-xs font-bold text-slate-800">
                    ربط أعمدة Excel بحقول دليل الحسابات
                  </span>
                  {requiredFieldsMissing.length > 0 ? (
                    <span className="text-xs font-semibold text-red-600">
                      حقول مطلوبة غير مربوطة: {requiredFieldsMissing.map((f) => f.label).join('، ')}
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-emerald-700">
                      جميع الحقول الأساسية مربوطة وجاهزة للفحص
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2">حقل النظام</th>
                        <th className="px-3 py-2">الإلزام</th>
                        <th className="px-3 py-2">عمود Excel المقابل</th>
                        <th className="px-3 py-2">الوصف</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {IMPORT_FIELDS.map((field) => {
                        const mappedIdx = mapping[field.key];
                        const isMapped = mappedIdx !== undefined && mappedIdx !== null;
                        return (
                          <tr key={field.key} className="hover:bg-slate-50">
                            <td className="px-3 py-2 font-semibold text-slate-900">{field.label}</td>
                            <td className="px-3 py-2">
                              {field.required ? (
                                <span className="font-semibold text-red-600">مطلوب</span>
                              ) : (
                                <span className="text-slate-500">اختياري</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={isMapped ? String(mappedIdx) : ''}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setMapping((prev) => ({
                                    ...prev,
                                    [field.key]: v === '' ? null : Number(v),
                                  }));
                                }}
                                className="w-full min-w-[220px] rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs focus:border-emerald-700 focus:outline-none"
                              >
                                <option value="">— غير مربوط —</option>
                                {inspection.columns.map((col) => (
                                  <option key={col.index} value={String(col.index)}>
                                    {col.header}
                                    {col.sampleValues.length > 0
                                      ? ` (مثال: ${col.sampleValues[0]})`
                                      : ''}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-2 text-slate-500">{field.hint}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}

          <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="button"
              disabled={!inspection || busy || inspection.totalRawDataRows === 0}
              onClick={() => void handleDiscoverValues()}
              className="flex items-center gap-2 rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              <span>{busy ? 'جاري اكتشاف ومطابقة القيم...' : 'التالي: مطابقة القيم والتصنيفات'}</span>
            </button>
          </div>
        </div>
      ) : null}

      {/* STEP 2: UNIFIED VALUE DISCOVERY & FIELD-SCOPED MAPPING */}
      {step === 'value_mapping' && discovery ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-500">القيم الفريدة عبر الأعمدة</p>
              <p className="mt-1 text-lg font-bold text-slate-900">{discovery.totalUniqueValues}</p>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3">
              <p className="text-xs text-emerald-800">مطابقة تلقائياً / محفوظة</p>
              <p className="mt-1 text-lg font-bold text-emerald-800">{discovery.totalMatched}</p>
            </div>
            <div
              className={`rounded-lg border p-3 ${
                unresolvedTotalCount > 0
                  ? 'border-amber-300 bg-amber-50'
                  : 'border-emerald-200 bg-emerald-50/40'
              }`}
            >
              <p className="text-xs text-slate-700">قيم غير محسومة حالياً</p>
              <p
                className={`mt-1 text-lg font-bold ${
                  unresolvedTotalCount > 0 ? 'text-amber-800' : 'text-emerald-700'
                }`}
              >
                {unresolvedTotalCount}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-600">خلايا فارغة في الأعمدة المصنّفة</p>
              <p className="mt-1 text-lg font-bold text-slate-800">{totalBlankCells}</p>
            </div>
          </div>

          {columnsWithBlanks.length > 0 ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 space-y-1">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <div className="space-y-1">
                <p className="font-bold">تم رصد خلايا فارغة في الأعمدة التالية:</p>
                {columnsWithBlanks.map((col) => (
                  <p key={col.fieldKey}>
                    • <strong>{col.fieldLabel}</strong> ({col.blankCount} خلية — الصفوف:{' '}
                    <span className="font-mono">
                      {col.blankRowNumbers.slice(0, 10).join('، ')}
                      {col.blankRowNumbers.length > 10
                        ? ` ... (+${col.blankRowNumbers.length - 10})`
                        : ''}
                    </span>
                    ){col.required ? ' — حقل مطلوب سيُرفض في المعاينة ما لم يُستكمل' : ' — حقل اختياري سيأخذ القيمة الافتراضية'}
                  </p>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
            <button
              type="button"
              onClick={() => setValueFilterField('ALL')}
              className={`rounded-md px-3 py-1.5 font-semibold transition ${
                valueFilterField === 'ALL'
                  ? 'bg-emerald-700 text-white'
                  : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
              }`}
            >
              جميع الحقول ({allDiscoveredRows.length})
            </button>
            <button
              type="button"
              onClick={() => setValueFilterField('UNMATCHED')}
              className={`rounded-md px-3 py-1.5 font-semibold transition ${
                valueFilterField === 'UNMATCHED'
                  ? 'bg-amber-700 text-white'
                  : 'bg-white text-amber-900 border border-amber-200 hover:bg-amber-50'
              }`}
            >
              تتطلب مطابقة ({unresolvedTotalCount})
            </button>
            {discovery.columns.map((col) => (
              <button
                key={col.fieldKey}
                type="button"
                onClick={() => setValueFilterField(col.fieldKey)}
                className={`rounded-md px-3 py-1.5 font-semibold transition ${
                  valueFilterField === col.fieldKey
                    ? 'bg-slate-800 text-white'
                    : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                }`}
              >
                {col.fieldLabel} ({col.items.length})
                {col.unmatchedCount > 0 ? ` • ${col.unmatchedCount} غير مطابق` : ''}
              </button>
            ))}
          </div>

          {filteredDiscoveredRows.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-5 text-center text-xs text-slate-600">
              لا توجد قيم ضمن التصفية المحددة حالياً.
            </div>
          ) : (
            <div className="max-h-[42vh] overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-slate-700">
                  <tr>
                    <th className="px-3 py-2.5">العمود / الحقل</th>
                    <th className="px-3 py-2.5">القيمة الأصلية في Excel</th>
                    <th className="px-3 py-2.5">التكرار</th>
                    <th className="px-3 py-2.5">التصنيف المقترح وحالة المطابقة</th>
                    <th className="px-3 py-2.5 min-w-[270px]">التصنيف الداخلي المختار</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {filteredDiscoveredRows.map(({ col, item }) => {
                    const sourceMeta = MATCH_SOURCE_META[item.matchSource];
                    const selectedVal = fieldValueMappings[col.fieldKey]?.[item.rawValue] ?? '';
                    const isUnresolved = !selectedVal;
                    const suggestedLabel = getOptionLabel(col.options, item.suggestedTarget);

                    return (
                      <tr
                        key={`${col.fieldKey}::${item.rawValue}`}
                        className={isUnresolved ? 'bg-amber-50/40' : 'hover:bg-slate-50'}
                      >
                        <td className="px-3 py-2.5">
                          <p className="font-bold text-slate-900">{col.fieldLabel}</p>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            عمود Excel: {col.columnHeader} • {col.required ? 'مطلوب' : 'اختياري'}
                          </p>
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="font-bold text-slate-900">{item.rawValue}</p>
                          <p className="mt-0.5 text-[11px] text-slate-500">
                            الصفوف:{' '}
                            <span className="font-mono">
                              {item.rowNumbers.slice(0, 6).join('، ')}
                              {item.rowNumbers.length > 6
                                ? ` ... (+${item.rowNumbers.length - 6})`
                                : ''}
                            </span>
                          </p>
                        </td>
                        <td className="px-3 py-2.5 font-mono font-semibold text-slate-800">
                          {item.count}
                        </td>
                        <td className="px-3 py-2.5 space-y-1">
                          <span
                            className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold ${sourceMeta.tone}`}
                          >
                            {sourceMeta.label}
                          </span>
                          {item.suggestedTarget ? (
                            <p className="text-[11px] text-slate-600">
                              المقترح: <strong>{suggestedLabel}</strong>
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <select
                            value={selectedVal}
                            onChange={(e) => {
                              const nextVal = e.target.value;
                              setFieldValueMappings((prev) => ({
                                ...prev,
                                [col.fieldKey]: {
                                  ...(prev[col.fieldKey] ?? {}),
                                  [item.rawValue]: nextVal,
                                },
                              }));
                            }}
                            className={`w-full rounded-lg border px-2.5 py-1.5 text-xs focus:outline-none ${
                              isUnresolved
                                ? 'border-amber-500 bg-white text-amber-900 focus:border-amber-700'
                                : 'border-slate-300 bg-white text-slate-900 focus:border-emerald-700'
                            }`}
                          >
                            <option value="">— اختر التصنيف الداخلي المعتمد —</option>
                            {col.options.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs">
            <label className="flex cursor-pointer items-start gap-2.5 text-slate-800">
              <input
                type="checkbox"
                checked={saveValueMappings}
                onChange={(e) => setSaveValueMappings(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-700"
              />
              <span className="flex items-center gap-1.5">
                <BookmarkCheck className="h-4 w-4 text-emerald-700 shrink-0" />
                <span>
                  حفظ المطابقات المعتمدة لكل حقل لإعادة استخدامها تلقائياً في الملفات القادمة (تُحفظ لكل حقل على حدة دون تعديل الحسابات القائمة).
                </span>
              </span>
            </label>
          </div>

          {unresolvedTotalCount > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-semibold text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
              <span>
                يوجد {unresolvedTotalCount} قيمة غير محسومة عبر الأعمدة المربوطة. لا يمكن الانتقال للمعاينة أو الاستيراد قبل تحديد تصنيفها الداخلي.
              </span>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => {
                setInlineError('');
                setStep('upload');
              }}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <ArrowRight className="h-4 w-4" />
              <span>العودة لربط الأعمدة</span>
            </button>
            <button
              type="button"
              disabled={busy || unresolvedTotalCount > 0}
              onClick={() => void handlePreview()}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? 'جاري الفحص والمعاينة...' : 'تأكيد جميع المطابقات ومعاينة الاستيراد'}
            </button>
          </div>
        </div>
      ) : null}

      {/* STEP 2: PREVIEW & VALIDATION */}
      {step === 'preview' && preview ? (
        <div className="space-y-4">
          {/* 4 Classification Filters */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            <button
              type="button"
              onClick={() => setFilterClass('ALL')}
              className={`rounded-lg border p-3 text-right transition ${
                filterClass === 'ALL'
                  ? 'border-emerald-700 bg-emerald-50/70'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <p className="text-xs text-slate-500">إجمالي السجلات</p>
              <p className="mt-1 text-lg font-bold text-slate-900">{preview.summary.totalRows}</p>
            </button>
            <button
              type="button"
              onClick={() => setFilterClass('VALID')}
              className={`rounded-lg border p-3 text-right transition ${
                filterClass === 'VALID'
                  ? 'border-emerald-700 bg-emerald-50'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <p className="text-xs text-emerald-700">صالحة وجاهزة للاستيراد</p>
              <p className="mt-1 text-lg font-bold text-emerald-800">{preview.summary.validCount}</p>
            </button>
            <button
              type="button"
              onClick={() => setFilterClass('INVALID')}
              className={`rounded-lg border p-3 text-right transition ${
                filterClass === 'INVALID'
                  ? 'border-red-600 bg-red-50'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <p className="text-xs text-red-700">حسابات غير صالحة</p>
              <p className="mt-1 text-lg font-bold text-red-700">{preview.summary.invalidCount}</p>
            </button>
            <button
              type="button"
              onClick={() => setFilterClass('EXISTING')}
              className={`rounded-lg border p-3 text-right transition ${
                filterClass === 'EXISTING'
                  ? 'border-slate-600 bg-slate-100'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <p className="text-xs text-slate-600">حسابات موجودة مسبقاً</p>
              <p className="mt-1 text-lg font-bold text-slate-800">{preview.summary.existingCount}</p>
            </button>
            <button
              type="button"
              onClick={() => setFilterClass('REQUIRES_REVIEW')}
              className={`rounded-lg border p-3 text-right transition ${
                filterClass === 'REQUIRES_REVIEW'
                  ? 'border-amber-600 bg-amber-50'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <p className="text-xs text-amber-800">تتطلب مراجعة</p>
              <p className="mt-1 text-lg font-bold text-amber-800">{preview.summary.reviewCount}</p>
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">
            <div className="flex flex-wrap items-center gap-4">
              <span>
                الوضع: <strong>{preview.mode === 'ADD_NEW' ? 'إضافة حسابات جديدة فقط' : 'تحديث الحسابات القائمة'}</strong>
              </span>
              <span>سيتم إضافتها: <strong className="text-emerald-700">{preview.summary.insertableCount}</strong></span>
              <span>سيتم تحديثها: <strong className="text-blue-700">{preview.summary.updatableCount}</strong></span>
              <span>سيتم تخطيها: <strong className="text-slate-700">{preview.summary.skippableCount}</strong></span>
            </div>
            <button
              type="button"
              onClick={() => void handlePreview()}
              disabled={busy}
              className="flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>إعادة الفحص</span>
            </button>
          </div>

          {/* Preview Rows Table */}
          <div className="max-h-[42vh] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-right text-xs">
              <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-slate-700">
                <tr>
                  <th className="px-2.5 py-2">الصف</th>
                  <th className="px-2.5 py-2">الرمز</th>
                  <th className="px-2.5 py-2">اسم الحساب</th>
                  <th className="px-2.5 py-2">الأب</th>
                  <th className="px-2.5 py-2">المستوى</th>
                  <th className="px-2.5 py-2">النوع</th>
                  <th className="px-2.5 py-2">الطبيعة</th>
                  <th className="px-2.5 py-2">الترحيل</th>
                  <th className="px-2.5 py-2">الحالة</th>
                  <th className="px-2.5 py-2">النتيجة</th>
                  <th className="px-2.5 py-2 min-w-[260px]">الرسائل والتفاصيل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {filteredPreviewRows.map((row) => {
                  const meta = CLASSIFICATION_META[row.classification];
                  const Icon = meta.Icon;
                  return (
                    <tr key={row.excelRowNumber} className="align-top hover:bg-slate-50">
                      <td className="px-2.5 py-2 font-mono text-slate-500">{row.excelRowNumber}</td>
                      <td className="px-2.5 py-2 font-mono font-semibold text-slate-900">
                        {row.normalized.code || row.raw.code || '-'}
                      </td>
                      <td className="px-2.5 py-2 font-medium text-slate-900">
                        {row.normalized.name_ar || row.raw.name_ar || '-'}
                      </td>
                      <td className="px-2.5 py-2 font-mono text-slate-700">
                        {row.normalized.resolved_parent_code || row.raw.parent_code || '-'}
                      </td>
                      <td className="px-2.5 py-2 text-slate-700">
                        {row.normalized.computed_level ?? row.normalized.specified_level ?? (row.raw.level || '-')}
                      </td>
                      <td className="px-2.5 py-2 text-slate-700">
                        {row.normalized.account_type
                          ? ACCOUNT_TYPE_LABELS[row.normalized.account_type]
                          : row.raw.account_type || '-'}
                      </td>
                      <td className="px-2.5 py-2 text-slate-700">
                        {row.normalized.normal_balance
                          ? NORMAL_BALANCE_LABELS[row.normalized.normal_balance]
                          : row.raw.normal_balance || '-'}
                      </td>
                      <td className="px-2.5 py-2 text-slate-700">{formatRowPostable(row)}</td>
                      <td className="px-2.5 py-2 text-slate-700">
                        {row.normalized.status
                          ? ENTITY_STATUS_LABELS[row.normalized.status]
                          : row.raw.status || '-'}
                      </td>
                      <td className="px-2.5 py-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${meta.tone}`}
                        >
                          <Icon className="h-3 w-3 shrink-0" />
                          <span>{meta.label}</span>
                        </span>
                      </td>
                      <td className="px-2.5 py-2 space-y-1">
                        {row.errors.map((e, i) => (
                          <p key={`e-${i}`} className="text-red-700">• {e}</p>
                        ))}
                        {row.warnings.map((w, i) => (
                          <p key={`w-${i}`} className="text-amber-800">• {w}</p>
                        ))}
                        {row.changes.length > 0 ? (
                          <div className="rounded border border-blue-200 bg-blue-50/70 p-1.5 text-[11px] text-blue-900 space-y-0.5">
                            <p className="font-bold">التغييرات المطبّقة:</p>
                            {row.changes.map((c, idx) => (
                              <p key={idx}>
                                {c.label}: <span className="line-through text-slate-500">{c.oldValue}</span> ←{' '}
                                <strong>{c.newValue}</strong>
                              </p>
                            ))}
                          </div>
                        ) : null}
                        {row.errors.length === 0 &&
                        row.warnings.length === 0 &&
                        row.changes.length === 0 ? (
                          <span className="text-emerald-700">
                            جاهز للإدراج (ترتيب الإنشاء: {row.executionOrder})
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Explicit Confirmation Checkboxes */}
          <div className="space-y-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs">
            {preview.summary.invalidCount > 0 ? (
              <label className="flex items-start gap-2.5 text-red-900">
                <input
                  type="checkbox"
                  checked={skipInvalidRows}
                  onChange={(e) => setSkipInvalidRows(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-700"
                />
                <span>
                  يوجد <strong>{preview.summary.invalidCount}</strong> حساب غير صالح. أوافق على تخطي السجلات غير الصالحة
                  وعدم تجاهلها بصمت، وتنفيذ الاستيراد فقط على السجلات السليمة (
                  {preview.summary.insertableCount + preview.summary.updatableCount} حساب).
                </span>
              </label>
            ) : null}

            {executableReviewCount > 0 ? (
              <label className="flex items-start gap-2.5 text-amber-900">
                <input
                  type="checkbox"
                  checked={confirmReviewRows}
                  onChange={(e) => setConfirmReviewRows(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-700"
                />
                <span>
                  يوجد <strong>{executableReviewCount}</strong> حساب مصنف للمراجعة. تمت مراجعة التنبيهات وأوافق على
                  اعتمادها واستيرادها.
                </span>
              </label>
            ) : null}

            {mode === 'UPDATE_EXISTING' && preview.summary.updatableCount > 0 ? (
              <label className="flex items-start gap-2.5 text-blue-950">
                <input
                  type="checkbox"
                  checked={confirmExistingUpdates}
                  onChange={(e) => setConfirmExistingUpdates(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-700"
                />
                <span>
                  تأكيد صريح: أوافق على تحديث بيانات <strong>{preview.summary.updatableCount}</strong> حساب موجود وفق
                  التغييرات الموضحة أعلاه (مع الإبقاء التام على القيود التاريخية والأرصدة دون أي مساس).
                </span>
              </label>
            ) : null}

            {preview.summary.insertableCount + preview.summary.updatableCount === 0 ? (
              <p className="font-semibold text-red-700">
                لا توجد حسابات جاهزة للإضافة أو التحديث حالياً. يرجى تعديل الملف أو وضع الاستيراد.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => {
                setInlineError('');
                setStep('value_mapping');
              }}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <ArrowRight className="h-4 w-4" />
              <span>العودة لمطابقة القيم والتصنيفات</span>
            </button>
            <button
              type="button"
              disabled={!canExecute}
              onClick={() => void handleExecuteImport()}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {busy ? 'جاري تنفيذ الاستيراد...' : 'تأكيد وتنفيذ الاستيراد'}
            </button>
          </div>
        </div>
      ) : null}

      {/* STEP 3: EXECUTION RESULT */}
      {step === 'result' && executeResult ? (
        <div className="space-y-5">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 text-emerald-700 shrink-0" />
              <div>
                <h3 className="text-base font-bold text-emerald-950">
                  تم إتمام عملية الاستيراد بنجاح — رقم العملية:{' '}
                  <span className="font-mono">{executeResult.log.operation_number}</span>
                </h3>
                <p className="text-xs text-emerald-800">
                  تم حفظ جميع الحسابات ضمن معاملة قاعدة بيانات واحدة وتسجيل العملية في سجل عمليات الاستيراد.
                </p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded border border-emerald-200 bg-white p-3">
                <p className="text-xs text-slate-500">تمت إضافتها</p>
                <p className="mt-1 text-lg font-bold text-emerald-700">{executeResult.importedCount}</p>
              </div>
              <div className="rounded border border-emerald-200 bg-white p-3">
                <p className="text-xs text-slate-500">تم تحديثها</p>
                <p className="mt-1 text-lg font-bold text-blue-700">{executeResult.updatedCount}</p>
              </div>
              <div className="rounded border border-emerald-200 bg-white p-3">
                <p className="text-xs text-slate-500">تم تخطيها</p>
                <p className="mt-1 text-lg font-bold text-slate-700">{executeResult.skippedCount}</p>
              </div>
              <div className="rounded border border-emerald-200 bg-white p-3">
                <p className="text-xs text-slate-500">سجلات بأخطاء</p>
                <p className="mt-1 text-lg font-bold text-red-700">{executeResult.errorCount}</p>
              </div>
            </div>
          </div>

          <div className="flex justify-end border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
            >
              إغلاق والعودة لشجرة الحسابات
            </button>
          </div>
        </div>
      ) : null}
    </ModalShell>
  );
}
