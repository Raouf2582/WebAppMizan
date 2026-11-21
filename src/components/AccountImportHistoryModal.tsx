import React, { useCallback, useEffect, useState } from 'react';
import { Eye, History } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type {
  AccountImportLog,
  AccountImportOperationStatus,
} from '../shared/types.ts';
import { EmptyState, ModalShell } from './ui.tsx';

const STATUS_LABELS: Record<AccountImportOperationStatus, { label: string; cls: string }> = {
  COMPLETED: { label: 'مكتمل', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  COMPLETED_WITH_SKIPS: { label: 'مكتمل مع تخطي', cls: 'text-amber-800 bg-amber-50 border-amber-200' },
  FAILED: { label: 'فشل', cls: 'text-red-700 bg-red-50 border-red-200' },
};

const OUTCOME_LABELS: Record<string, string> = {
  IMPORTED: 'تم الاستيراد',
  UPDATED: 'تم التحديث',
  SKIPPED: 'تم التخطي',
  ERROR: 'خطأ',
};

export function AccountImportHistoryModal({
  open,
  onClose,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [logs, setLogs] = useState<AccountImportLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<AccountImportLog | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ logs?: AccountImportLog[] }>('/api/accounts/import/history');
      setLogs(Array.isArray(res.logs) ? res.logs : []);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل سجل عمليات الاستيراد.');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    if (open) {
      setSelectedLog(null);
      void loadHistory();
    }
  }, [open, loadHistory]);

  async function openDetails(id: string) {
    setLoadingDetails(true);
    try {
      const res = await apiRequest<{ log: AccountImportLog }>(`/api/accounts/import/history/${id}`);
      setSelectedLog(res.log);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل تفاصيل العملية.');
    } finally {
      setLoadingDetails(false);
    }
  }

  return (
    <ModalShell
      open={open}
      title={
        selectedLog
          ? `تفاصيل عملية الاستيراد — ${selectedLog.operation_number}`
          : 'سجل عمليات استيراد دليل الحسابات'
      }
      onClose={onClose}
      maxWidth="max-w-5xl"
    >
      {selectedLog ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs">
            <div className="space-y-1">
              <p>
                الملف: <strong className="font-mono">{selectedLog.file_name}</strong> — ورقة:{' '}
                <strong>{selectedLog.sheet_name}</strong>
              </p>
              <p className="text-slate-600">
                الوضع:{' '}
                <strong>
                  {selectedLog.import_mode === 'ADD_NEW' ? 'إضافة حسابات جديدة' : 'تحديث الحسابات القائمة'}
                </strong>{' '}
                | المنفّذ: <strong>{selectedLog.performer?.full_name || '-'}</strong> | التاريخ:{' '}
                <strong className="font-mono">
                  {new Date(selectedLog.created_at).toLocaleString('en-GB')}
                </strong>
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedLog(null)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-100"
            >
              العودة لقائمة السجل
            </button>
          </div>

          {selectedLog.error_message ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              سبب فشل العملية: {selectedLog.error_message}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5 text-xs">
            <div className="rounded border border-slate-200 p-2.5">
              <span className="text-slate-500">الإجمالي</span>
              <p className="mt-0.5 text-base font-bold text-slate-900">{selectedLog.total_rows}</p>
            </div>
            <div className="rounded border border-slate-200 p-2.5">
              <span className="text-emerald-700">مضاف</span>
              <p className="mt-0.5 text-base font-bold text-emerald-700">{selectedLog.imported_count}</p>
            </div>
            <div className="rounded border border-slate-200 p-2.5">
              <span className="text-blue-700">محدّث</span>
              <p className="mt-0.5 text-base font-bold text-blue-700">{selectedLog.updated_count}</p>
            </div>
            <div className="rounded border border-slate-200 p-2.5">
              <span className="text-slate-600">متخطّى</span>
              <p className="mt-0.5 text-base font-bold text-slate-700">{selectedLog.skipped_count}</p>
            </div>
            <div className="rounded border border-slate-200 p-2.5">
              <span className="text-red-700">أخطاء</span>
              <p className="mt-0.5 text-base font-bold text-red-700">{selectedLog.error_count}</p>
            </div>
          </div>

          {Array.isArray(selectedLog.details) && selectedLog.details.length > 0 ? (
            <div className="max-h-[45vh] overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-slate-700">
                  <tr>
                    <th className="px-3 py-2">الصف</th>
                    <th className="px-3 py-2">الرمز</th>
                    <th className="px-3 py-2">اسم الحساب</th>
                    <th className="px-3 py-2">النتيجة</th>
                    <th className="px-3 py-2">الرسائل والتغييرات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {selectedLog.details.map((item, idx) => (
                    <tr key={idx} className="align-top">
                      <td className="px-3 py-2 font-mono text-slate-500">{item.excelRowNumber}</td>
                      <td className="px-3 py-2 font-mono font-semibold text-slate-900">{item.code || '-'}</td>
                      <td className="px-3 py-2 text-slate-800">{item.name_ar || '-'}</td>
                      <td className="px-3 py-2 font-semibold">
                        {OUTCOME_LABELS[item.outcome] || item.outcome}
                      </td>
                      <td className="px-3 py-2 space-y-0.5">
                        {item.messages?.map((m, mi) => (
                          <p key={mi} className="text-slate-700">• {m}</p>
                        ))}
                        {item.changes?.map((c, ci) => (
                          <p key={`c-${ci}`} className="text-blue-800">
                            • {c.label}: {c.oldValue} ← {c.newValue}
                          </p>
                        ))}
                        {(!item.messages || item.messages.length === 0) &&
                        (!item.changes || item.changes.length === 0) ? (
                          <span className="text-emerald-700">تمت المعالجة بنجاح</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-slate-500">لا توجد تفاصيل صفوف محفوظة لهذه العملية.</p>
          )}
        </div>
      ) : loading ? (
        <div className="p-8 text-center text-sm text-slate-500">جاري تحميل سجل الاستيراد...</div>
      ) : logs.length === 0 ? (
        <EmptyState
          icon={History}
          title="لا توجد عمليات استيراد سابقة"
          description="عند استيراد دليل الحسابات من ملف Excel سيتم توثيق كل عملية ونتائجها وأخطائها هنا."
        />
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-right text-xs">
            <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-slate-700">
              <tr>
                <th className="px-3 py-2.5">رقم العملية</th>
                <th className="px-3 py-2.5">الملف / الورقة</th>
                <th className="px-3 py-2.5">الوضع</th>
                <th className="px-3 py-2.5">المستخدم</th>
                <th className="px-3 py-2.5">التاريخ والوقت</th>
                <th className="px-3 py-2.5">النتائج</th>
                <th className="px-3 py-2.5">الحالة</th>
                <th className="px-3 py-2.5">التفاصيل</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {logs.map((log) => {
                const st = STATUS_LABELS[log.status] ?? STATUS_LABELS.COMPLETED;
                return (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-mono font-semibold text-slate-900">
                      {log.operation_number}
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-slate-900">{log.file_name}</p>
                      <p className="text-[11px] text-slate-500">ورقة: {log.sheet_name}</p>
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">
                      {log.import_mode === 'ADD_NEW' ? 'إضافة جديدة' : 'تحديث قائمة'}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">
                      {log.performer?.full_name || '-'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-600">
                      {new Date(log.created_at).toLocaleString('en-GB')}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">
                      إجمالي: {log.total_rows} | مضاف: {log.imported_count} | محدّث: {log.updated_count} | تخطي:{' '}
                      {log.skipped_count} | أخطاء: {log.error_count}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-block rounded border px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}>
                        {st.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        disabled={loadingDetails}
                        onClick={() => void openDetails(log.id)}
                        className="inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span>التفاصيل</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ModalShell>
  );
}
