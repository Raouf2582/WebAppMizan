import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Upload,
} from 'lucide-react';
import { apiRequest, downloadExcelFile } from '../lib/api.ts';
import { formatDate, formatMoney } from '../lib/format.ts';
import type {
  JournalImportColumnMapping,
  JournalImportExecuteResult,
  JournalImportFieldKey,
  JournalImportInspectResult,
  JournalImportPreviewResult,
} from '../shared/types.ts';
import { ModalShell } from './ui.tsx';

const JOURNAL_FIELDS: Array<{
  key: JournalImportFieldKey;
  label: string;
  required: boolean;
}> = [
  { key: 'entry_group', label: 'رقم المجموعة / القيد', required: false },
  { key: 'entry_date', label: 'تاريخ القيد', required: true },
  { key: 'description', label: 'البيان العام', required: false },
  { key: 'reference_number', label: 'الرقم المرجعي', required: false },
  { key: 'cost_center_code', label: 'رمز مركز التكلفة', required: false },
  { key: 'account_code', label: 'رمز الحساب', required: true },
  { key: 'debit', label: 'مدين', required: true },
  { key: 'credit', label: 'دائن', required: true },
  { key: 'line_description', label: 'بيان السطر', required: false },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('تعذر قراءة الملف المحدد.'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export function JournalImportModal({
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
  const [step, setStep] = useState<'upload' | 'preview' | 'result'>('upload');
  const [fileName, setFileName] = useState('');
  const [fileBase64, setFileBase64] = useState('');
  const [inspection, setInspection] = useState<JournalImportInspectResult | null>(null);
  const [selectedSheets, setSelectedSheets] = useState<string[]>([]);
  const [mappingsBySheet, setMappingsBySheet] = useState<
    Record<string, JournalImportColumnMapping>
  >({});
  const [activeMappingSheet, setActiveMappingSheet] = useState('');

  const [preview, setPreview] = useState<JournalImportPreviewResult | null>(null);
  const [skipRejectedEntries, setSkipRejectedEntries] = useState(true);
  const [executeResult, setExecuteResult] = useState<JournalImportExecuteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState('');

  function resetAll() {
    setStep('upload');
    setFileName('');
    setFileBase64('');
    setInspection(null);
    setSelectedSheets([]);
    setMappingsBySheet({});
    setActiveMappingSheet('');
    setPreview(null);
    setSkipRejectedEntries(true);
    setExecuteResult(null);
    setInlineError('');
  }

  function handleClose() {
    resetAll();
    onClose();
  }

  async function handleDownloadTemplate() {
    try {
      await downloadExcelFile(
        '/api/journal-imports/template',
        'journal_entries_import_template.xlsx',
      );
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل نموذج استيراد القيود.');
    }
  }

  async function handleFileSelect(file: File | null) {
    if (!file) return;
    setInlineError('');
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
      const res = await apiRequest<{ inspection: JournalImportInspectResult }>(
        '/api/journal-imports/inspect',
        {
          method: 'POST',
          body: { fileName: file.name, fileBase64: b64 },
        },
      );
      setFileName(res.inspection.fileName);
      setFileBase64(b64);
      setInspection(res.inspection);

      const initialSheets = res.inspection.sheetNames.slice(0, 1);
      setSelectedSheets(initialSheets);
      setActiveMappingSheet(initialSheets[0] || '');

      const mapObj: Record<string, JournalImportColumnMapping> = {};
      for (const s of res.inspection.sheets) {
        mapObj[s.sheetName] = { ...s.detectedMapping };
      }
      setMappingsBySheet(mapObj);
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'تعذر قراءة ملف Excel.');
    } finally {
      setBusy(false);
    }
  }

  function toggleSheet(sheetName: string) {
    setSelectedSheets((prev) => {
      const exists = prev.includes(sheetName);
      const next = exists ? prev.filter((s) => s !== sheetName) : [...prev, sheetName];
      if (!exists && !activeMappingSheet) {
        setActiveMappingSheet(sheetName);
      } else if (exists && activeMappingSheet === sheetName) {
        setActiveMappingSheet(next[0] || '');
      }
      return next;
    });
  }

  const missingMappingErrors = useMemo(() => {
    const missing: string[] = [];
    for (const sName of selectedSheets) {
      const m = mappingsBySheet[sName] || {};
      const missingFields = JOURNAL_FIELDS.filter(
        (f) => f.required && (m[f.key] === undefined || m[f.key] === null),
      ).map((f) => f.label);
      if (missingFields.length > 0) {
        missing.push(`${sName}: ${missingFields.join('، ')}`);
      }
    }
    return missing;
  }, [selectedSheets, mappingsBySheet]);

  async function handlePreview() {
    if (!inspection || selectedSheets.length === 0) return;
    setInlineError('');
    setBusy(true);
    try {
      const res = await apiRequest<{ preview: JournalImportPreviewResult }>(
        '/api/journal-imports/preview',
        {
          method: 'POST',
          body: {
            fileName,
            fileBase64,
            sheetNames: selectedSheets,
            mappingsBySheet,
          },
        },
      );
      setPreview(res.preview);
      setStep('preview');
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'تعذر معاينة القيود المكتشفة.');
    } finally {
      setBusy(false);
    }
  }

  async function handleExecute() {
    if (!preview) return;
    setInlineError('');
    setBusy(true);
    try {
      const res = await apiRequest<{ result: JournalImportExecuteResult }>(
        '/api/journal-imports/execute',
        {
          method: 'POST',
          body: {
            fileName,
            fileBase64,
            sheetNames: selectedSheets,
            mappingsBySheet,
            skipRejectedEntries,
          },
        },
      );
      setExecuteResult(res.result);
      setStep('result');
      await onImported();
      onNotify(
        'success',
        `تم استيراد الدفعة ${res.result.batch.batch_number}: إنشاء ${res.result.draftsCreatedCount} قيد مسودة.`,
      );
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'تعذر تنفيذ عملية الاستيراد.');
    } finally {
      setBusy(false);
    }
  }

  const activeSheetMeta = inspection?.sheets.find((s) => s.sheetName === activeMappingSheet);

  return (
    <ModalShell
      open={open}
      title="استيراد القيود اليومية من Excel"
      onClose={handleClose}
      maxWidth="max-w-5xl"
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3 text-xs">
          <div className="flex items-center gap-3 text-slate-600">
            <span className={step === 'upload' ? 'font-bold text-emerald-700' : ''}>
              1. الملف وربط الأعمدة
            </span>
            <span aria-hidden="true">/</span>
            <span className={step === 'preview' ? 'font-bold text-emerald-700' : ''}>
              2. معاينة القيود المكتشفة
            </span>
            <span aria-hidden="true">/</span>
            <span className={step === 'result' ? 'font-bold text-emerald-700' : ''}>
              3. النتيجة ورقم الدفعة
            </span>
          </div>

          <button
            type="button"
            onClick={handleDownloadTemplate}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            <span>تحميل قالب Excel</span>
          </button>
        </div>

        {inlineError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
            {inlineError}
          </div>
        ) : null}

        {step === 'upload' ? (
          <div className="space-y-5">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center hover:border-emerald-600 hover:bg-emerald-50/30">
              <Upload className="mb-2 h-7 w-7 text-slate-500" />
              <span className="text-sm font-semibold text-slate-800">
                {fileName ? `الملف المختار: ${fileName}` : 'اختر ملف Excel (.xlsx أو .xls)'}
              </span>
              <span className="mt-1 text-xs text-slate-500">
                سيتم تجميع أسطر كل قيد وإنشاء القيود السليمة كمسودات مرتبطة برقم دفعة موحد
              </span>
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={(e) => void handleFileSelect(e.target.files?.[0] || null)}
              />
            </label>

            {inspection ? (
              <div className="space-y-4">
                <div>
                  <h3 className="mb-2 text-xs font-bold text-slate-700">
                    أوراق العمل المراد استيرادها ({selectedSheets.length} محددة)
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {inspection.sheets.map((s) => {
                      const checked = selectedSheets.includes(s.sheetName);
                      return (
                        <label
                          key={s.sheetName}
                          className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium ${
                            checked
                              ? 'border-emerald-700 bg-emerald-50 text-emerald-900'
                              : 'border-slate-300 bg-white text-slate-700'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSheet(s.sheetName)}
                            className="accent-emerald-700"
                          />
                          <FileSpreadsheet className="h-3.5 w-3.5" />
                          <span>{s.sheetName}</span>
                          <span className="font-mono text-slate-500">({s.totalRawDataRows} سطر)</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {selectedSheets.length > 0 ? (
                  <div className="space-y-3 rounded-lg border border-slate-200 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-800">ربط أعمدة ورقة العمل</span>
                      {selectedSheets.length > 1 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {selectedSheets.map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => setActiveMappingSheet(s)}
                              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                                activeMappingSheet === s
                                  ? 'bg-slate-900 text-white'
                                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                              }`}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    {activeSheetMeta ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        {JOURNAL_FIELDS.map((field) => {
                          const currentMap = mappingsBySheet[activeSheetMeta.sheetName] || {};
                          const val = currentMap[field.key];
                          return (
                            <div key={field.key}>
                              <label className="mb-1 block text-xs font-medium text-slate-700">
                                {field.label} {field.required ? <span className="text-red-600">*</span> : null}
                              </label>
                              <select
                                value={val ?? ''}
                                onChange={(e) => {
                                  const nextIdx = e.target.value === '' ? null : Number(e.target.value);
                                  setMappingsBySheet((prev) => ({
                                    ...prev,
                                    [activeSheetMeta.sheetName]: {
                                      ...(prev[activeSheetMeta.sheetName] || {}),
                                      [field.key]: nextIdx,
                                    },
                                  }));
                                }}
                                className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800"
                              >
                                <option value="">— غير مربوط —</option>
                                {activeSheetMeta.columns.map((c) => (
                                  <option key={c.index} value={c.index}>
                                    {c.header}
                                    {c.sampleValues[0] ? ` (مثال: ${c.sampleValues[0]})` : ''}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {missingMappingErrors.length > 0 ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    يجب استكمال ربط الأعمدة الإلزامية في: {missingMappingErrors.join(' | ')}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  !inspection ||
                  selectedSheets.length === 0 ||
                  missingMappingErrors.length > 0
                }
                onClick={() => void handlePreview()}
                className="rounded-lg bg-emerald-700 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                {busy ? 'جاري الفحص...' : 'معاينة القيود المكتشفة'}
              </button>
            </div>
          </div>
        ) : step === 'preview' && preview ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-slate-500">الأسطر المقروءة</div>
                <div className="mt-1 font-mono text-lg font-bold text-slate-900 tabular-nums">
                  {preview.importedRows}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-slate-500">القيود المكتشفة</div>
                <div className="mt-1 font-mono text-lg font-bold text-slate-900 tabular-nums">
                  {preview.detectedEntriesCount}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-emerald-700">صالحة للإنشاء كمسودة</div>
                <div className="mt-1 font-mono text-lg font-bold text-emerald-700 tabular-nums">
                  {preview.validEntriesCount}
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-red-700">مرفوضة</div>
                <div className="mt-1 font-mono text-lg font-bold text-red-700 tabular-nums">
                  {preview.rejectedEntriesCount}
                </div>
              </div>
            </div>

            <div className="max-h-[45vh] overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-slate-700">
                  <tr>
                    <th className="px-3 py-2.5">الورقة / المجموعة</th>
                    <th className="px-3 py-2.5">التاريخ</th>
                    <th className="px-3 py-2.5">البيان</th>
                    <th className="px-3 py-2.5">مدين</th>
                    <th className="px-3 py-2.5">دائن</th>
                    <th className="px-3 py-2.5">الأسطر</th>
                    <th className="px-3 py-2.5">التحقق المحاسبي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {preview.entries.map((entry, idx) => (
                    <tr key={idx} className="align-top hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <div className="font-mono font-semibold text-slate-900">{entry.groupKey}</div>
                        <div className="text-[11px] text-slate-500">{entry.sheetName}</div>
                      </td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">
                        {entry.entryDate ? formatDate(entry.entryDate) : '-'}
                      </td>
                      <td className="px-3 py-2.5 text-slate-800 max-w-xs">{entry.description}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(entry.totalDebit)}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(entry.totalCredit)}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{entry.lines.length}</td>
                      <td className="px-3 py-2.5">
                        {entry.valid ? (
                          <span className="font-semibold text-emerald-700">صالح (سيُنشأ كمسودة)</span>
                        ) : (
                          <div className="space-y-0.5 text-red-700">
                            {entry.errors.map((err, ei) => (
                              <div key={ei}>• {err}</div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.rejectedEntriesCount > 0 ? (
              <label className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <input
                  type="checkbox"
                  checked={skipRejectedEntries}
                  onChange={(e) => setSkipRejectedEntries(e.target.checked)}
                  className="accent-emerald-700"
                />
                <span>
                  تخطي القيود المرفوضة ({preview.rejectedEntriesCount}) وإنشاء القيود الصالحة فقط كمسودات مع توثيق المرفوضات في سجل الاستيراد.
                </span>
              </label>
            ) : null}

            <div className="flex justify-between gap-2 border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => setStep('upload')}
                className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                رجوع لتعديل الربط
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  preview.detectedEntriesCount === 0 ||
                  (!skipRejectedEntries && preview.rejectedEntriesCount > 0)
                }
                onClick={() => void handleExecute()}
                className="rounded-lg bg-emerald-700 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                {busy ? 'جاري التنفيذ...' : 'تنفيذ الاستيراد وحفظ الدفعة'}
              </button>
            </div>
          </div>
        ) : step === 'result' && executeResult ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
              {executeResult.draftsCreatedCount > 0 ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
              ) : (
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
              )}
              <div className="space-y-1 text-xs">
                <p className="text-sm font-bold text-slate-900">
                  تم توثيق عملية الاستيراد برقم الدفعة:{' '}
                  <span className="font-mono">{executeResult.batch.batch_number}</span>
                </p>
                <p className="text-slate-600">
                  تم إنشاء <strong className="font-mono">{executeResult.draftsCreatedCount}</strong> قيد مسودة،
                  ورفض <strong className="font-mono">{executeResult.rejectedEntriesCount}</strong> قيد.
                </p>
                {executeResult.generatedEntryNumbers.length > 0 ? (
                  <p className="pt-1 font-mono text-slate-700">
                    أرقام القيود المنشأة: {executeResult.generatedEntryNumbers.join(' ، ')}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex justify-end border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-lg bg-emerald-700 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
              >
                إغلاق وتحديث القيود
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}
