import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  ShieldCheck,
  SkipForward,
  XCircle,
} from 'lucide-react';
import { apiRequest, streamBulkJournalPost } from '../lib/api.ts';
import { formatDate, formatMoney, JOURNAL_STATUS_LABELS } from '../lib/format.ts';
import type {
  BulkJournalPostAuditLog,
  BulkJournalPostFilter,
  BulkJournalPostMode,
  BulkJournalPostOutcome,
  BulkJournalPostPreviewResponse,
  BulkJournalPostSummary,
} from '../shared/types.ts';
import { EmptyState, ModalShell, StatusText } from './ui.tsx';

interface ProgressState {
  processed: number;
  total: number;
  postedCount: number;
  failedCount: number;
  skippedCount: number;
  currentEntryNumber: string;
}

function OutcomeLabel({ outcome }: { outcome: BulkJournalPostOutcome }) {
  if (outcome === 'POSTED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span>تم الترحيل</span>
      </span>
    );
  }
  if (outcome === 'SKIPPED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 whitespace-nowrap">
        <SkipForward className="h-3.5 w-3.5 shrink-0" />
        <span>تم التخطي</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 whitespace-nowrap">
      <XCircle className="h-3.5 w-3.5 shrink-0" />
      <span>فشل الترحيل</span>
    </span>
  );
}

export function BulkJournalPostModal({
  open,
  mode,
  selectedIds,
  filters,
  preview,
  onClose,
  onCompleted,
  onNotify,
}: {
  open: boolean;
  mode: BulkJournalPostMode;
  selectedIds: string[];
  filters: BulkJournalPostFilter;
  preview: BulkJournalPostPreviewResponse | null;
  onClose: () => void;
  onCompleted: (summary: BulkJournalPostSummary) => void;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [stage, setStage] = useState<'confirm' | 'running' | 'report'>('confirm');
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [summary, setSummary] = useState<BulkJournalPostSummary | null>(null);

  useEffect(() => {
    if (open) {
      setStage('confirm');
      setProgress(null);
      setSummary(null);
    }
  }, [open, preview]);

  async function handleExecute() {
    if (!preview) return;
    setStage('running');
    setProgress({
      processed: 0,
      total: preview.totalTargeted,
      postedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      currentEntryNumber: preview.entries[0]?.entry_number || '',
    });

    try {
      const payload =
        mode === 'SELECTED'
          ? {
              mode: 'SELECTED' as const,
              entryIds: selectedIds,
              confirm: true as const,
              stream: true,
            }
          : {
              mode: 'ALL_DRAFTS' as const,
              filters,
              confirm: true as const,
              stream: true,
            };

      const finalSummary = await streamBulkJournalPost<ProgressState, BulkJournalPostSummary>(
        payload,
        (ev) => {
          setProgress({
            processed: ev.processed,
            total: ev.total,
            postedCount: ev.postedCount,
            failedCount: ev.failedCount,
            skippedCount: ev.skippedCount,
            currentEntryNumber: ev.currentEntryNumber,
          });
        },
      );

      setSummary(finalSummary);
      setStage('report');
      onCompleted(finalSummary);

      if (finalSummary.failedCount === 0 && finalSummary.postedCount > 0) {
        onNotify(
          'success',
          `تم ترحيل ${finalSummary.postedCount} قيد بنجاح في العملية رقم ${finalSummary.operationNumber}.`,
        );
      } else if (finalSummary.postedCount > 0) {
        onNotify(
          'info',
          `تم ترحيل ${finalSummary.postedCount} قيد، وفشل ${finalSummary.failedCount} قيد. راجع تقرير النتائج.`,
        );
      } else if (finalSummary.failedCount > 0) {
        onNotify(
          'error',
          `لم يتم ترحيل أي قيد؛ فشل ترحيل ${finalSummary.failedCount} قيد لعدم استيفاء شروط التحقق.`,
        );
      }
    } catch (err) {
      setStage('confirm');
      onNotify(
        'error',
        err instanceof Error ? err.message : 'تعذر تنفيذ عملية الترحيل الجماعي.',
      );
    }
  }

  const modalTitle =
    stage === 'report'
      ? `تقرير نتائج الترحيل الجماعي (${summary?.operationNumber || ''})`
      : stage === 'running'
        ? 'جاري تنفيذ الترحيل الجماعي للقيود...'
        : mode === 'ALL_DRAFTS'
          ? 'تأكيد ترحيل جميع القيود المسودة'
          : 'تأكيد الترحيل الجماعي للقيود المحددة';

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
      : 0;

  return (
    <ModalShell
      open={open && !!preview}
      title={modalTitle}
      onClose={() => {
        if (stage !== 'running') onClose();
      }}
      maxWidth="max-w-4xl"
    >
      {preview && stage === 'confirm' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-3">
            <div>
              <div className="text-xs text-slate-500">نطاق العملية</div>
              <div className="mt-1 font-semibold text-slate-900">
                {mode === 'ALL_DRAFTS' ? 'جميع المسودات المؤهلة' : 'القيود المحددة يدوياً'}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">إجمالي القيود المستهدفة</div>
              <div className="mt-1 font-mono text-base font-bold text-slate-900 tabular-nums">
                {preview.totalTargeted} قيد
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">مسودات جاهزة للتحقق والترحيل</div>
              <div className="mt-1 font-mono text-base font-bold text-emerald-700 tabular-nums">
                {preview.eligibleDraftCount} مسودة
              </div>
            </div>

            {mode === 'ALL_DRAFTS' &&
            (filters.search?.trim() || filters.startDate || filters.endDate) ? (
              <div className="sm:col-span-3 border-t border-slate-200 pt-3 text-xs text-slate-600">
                وفق الفلاتر المطبقة:{' '}
                {filters.search?.trim() ? `بحث "${filters.search.trim()}" · ` : ''}
                {filters.startDate ? `من ${filters.startDate} · ` : ''}
                {filters.endDate ? `إلى ${filters.endDate}` : ''}
              </div>
            ) : null}
          </div>

          {preview.alreadyPostedCount > 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <span>
                يوجد عدد ({preview.alreadyPostedCount}) قيد مرحّل مسبقاً ضمن النطاق، وسيتم تخطيه
                تلقائياً أثناء التنفيذ لمنع تكرار الحركات أو الأرصدة.
              </span>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span className="font-semibold text-slate-800">
                القيود المشمولة في العملية ({preview.entries.length})
              </span>
              <span>سيتم تطبيق كامل قواعد التوازن والفترة والحسابات على كل قيد بشكل مستقل</span>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">رقم القيد</th>
                    <th className="px-3 py-2.5">التاريخ</th>
                    <th className="px-3 py-2.5">البيان</th>
                    <th className="px-3 py-2.5">المبلغ</th>
                    <th className="px-3 py-2.5">الحالة الحالية</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {preview.entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono font-bold text-slate-900 whitespace-nowrap">
                        {entry.entry_number}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                        {formatDate(entry.entry_date)}
                      </td>
                      <td className="px-3 py-2 text-slate-800 max-w-xs truncate">
                        {entry.description}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-900 tabular-nums whitespace-nowrap">
                        {formatMoney(entry.total_debit)}
                      </td>
                      <td className="px-3 py-2">
                        <StatusText
                          variant={entry.status === 'POSTED' ? 'posted' : 'draft'}
                          label={JOURNAL_STATUS_LABELS[entry.status]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="button"
              disabled={preview.entries.length === 0}
              onClick={handleExecute}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {mode === 'ALL_DRAFTS'
                ? `تأكيد ترحيل جميع المسودات (${preview.eligibleDraftCount})`
                : `تأكيد ترحيل القيود المحددة (${preview.totalTargeted})`}
            </button>
          </div>
        </div>
      ) : null}

      {stage === 'running' && progress ? (
        <div className="space-y-5 py-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-slate-900">
              جاري التحقق من القيود وترحيلها بشكل مستقل...
            </span>
            <span className="font-mono font-bold text-emerald-700 tabular-nums">
              {progress.processed} / {progress.total} ({progressPct}%)
            </span>
          </div>

          <div className="h-3 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-emerald-700 transition-all duration-150"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-center text-xs">
            <div>
              <div className="text-slate-500">تم ترحيلها</div>
              <div className="mt-1 font-mono text-base font-bold text-emerald-700 tabular-nums">
                {progress.postedCount}
              </div>
            </div>
            <div>
              <div className="text-slate-500">فشل ترحيلها</div>
              <div className="mt-1 font-mono text-base font-bold text-red-700 tabular-nums">
                {progress.failedCount}
              </div>
            </div>
            <div>
              <div className="text-slate-500">تم تخطيها</div>
              <div className="mt-1 font-mono text-base font-bold text-amber-700 tabular-nums">
                {progress.skippedCount}
              </div>
            </div>
          </div>

          {progress.currentEntryNumber ? (
            <div className="text-center text-xs text-slate-500">
              القيد قيد المعالجة:{' '}
              <span className="font-mono font-semibold text-slate-800">
                {progress.currentEntryNumber}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {stage === 'report' && summary ? (
        <div className="space-y-5">
          {/* Structured Results Summary Table */}
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2.5">البيان</th>
                  <th className="px-4 py-2.5 text-left w-32">العدد</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                <tr>
                  <td className="px-4 py-2.5 font-medium text-slate-800">إجمالي القيود المحددة</td>
                  <td className="px-4 py-2.5 text-left font-mono font-bold text-slate-900 tabular-nums">
                    {summary.totalSelected}
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-medium text-emerald-800">
                    القيود التي تم ترحيلها بنجاح
                  </td>
                  <td className="px-4 py-2.5 text-left font-mono font-bold text-emerald-700 tabular-nums">
                    {summary.postedCount}
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-medium text-red-800">القيود التي فشل ترحيلها</td>
                  <td className="px-4 py-2.5 text-left font-mono font-bold text-red-700 tabular-nums">
                    {summary.failedCount}
                  </td>
                </tr>
                <tr>
                  <td className="px-4 py-2.5 font-medium text-amber-800">القيود التي تم تخطيها</td>
                  <td className="px-4 py-2.5 text-left font-mono font-bold text-amber-700 tabular-nums">
                    {summary.skippedCount}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>
              رقم عملية الترحيل في سجل التدقيق:{' '}
              <span className="font-mono font-bold text-slate-900">
                {summary.operationNumber}
              </span>
            </span>
            <span>القيود الفاشلة بقيت بحالة مسودة ويمكن تصحيحها وإعادة محاولة ترحيلها</span>
          </div>

          {/* Per-Entry Results Breakdown */}
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
            <table className="w-full text-right text-xs">
              <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                <tr>
                  <th className="px-3 py-2.5">رقم القيد</th>
                  <th className="px-3 py-2.5">التاريخ</th>
                  <th className="px-3 py-2.5">المبلغ</th>
                  <th className="px-3 py-2.5">الحالة</th>
                  <th className="px-3 py-2.5">التفاصيل / سبب الفشل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {summary.results.map((item, idx) => (
                  <tr key={`${item.entry_id}-${idx}`} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-mono font-bold text-slate-900 whitespace-nowrap">
                      {item.entry_number}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                      {item.entry_date ? formatDate(item.entry_date) : '-'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-900 tabular-nums whitespace-nowrap">
                      {formatMoney(item.total_debit)}
                    </td>
                    <td className="px-3 py-2.5">
                      <OutcomeLabel outcome={item.outcome} />
                    </td>
                    <td className="px-3 py-2.5 text-slate-700">{item.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              إغلاق التقرير
            </button>
          </div>
        </div>
      ) : null}
    </ModalShell>
  );
}

export function BulkPostAuditLogsModal({
  open,
  onClose,
  onNotify,
}: {
  open: boolean;
  onClose: () => void;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [logs, setLogs] = useState<BulkJournalPostAuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<BulkJournalPostAuditLog | null>(null);

  async function loadLogs() {
    setLoading(true);
    try {
      const res = await apiRequest<{ logs?: BulkJournalPostAuditLog[] }>(
        '/api/journals/bulk-post/audit-logs',
      );
      setLogs(Array.isArray(res.logs) ? res.logs : []);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'تعذر تحميل سجل عمليات الترحيل الجماعي.',
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      setSelectedLog(null);
      loadLogs();
    }
  }, [open]);

  function formatDateTime(iso: string) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  return (
    <ModalShell
      open={open}
      title="سجل تدقيق عمليات الترحيل الجماعي للقيود"
      onClose={onClose}
      maxWidth="max-w-5xl"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>توثيق كامل لكل عملية ترحيل جماعي مع المستخدم والتوقيت وعدد القيود الناجحة والفاشلة.</span>
          <button
            type="button"
            onClick={loadLogs}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>تحديث</span>
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">جاري تحميل السجل...</div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="لا توجد عمليات ترحيل جماعي مسجلة"
            description="عند تنفيذ أي عملية ترحيل جماعي للقيود المسودة سيتم توثيقها هنا تلقائياً."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-right text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                <tr>
                  <th className="px-3 py-2.5">رقم العملية</th>
                  <th className="px-3 py-2.5">النطاق</th>
                  <th className="px-3 py-2.5">المستهدف</th>
                  <th className="px-3 py-2.5">الناجحة</th>
                  <th className="px-3 py-2.5">الفاشلة</th>
                  <th className="px-3 py-2.5">المتخطاة</th>
                  <th className="px-3 py-2.5">المستخدم</th>
                  <th className="px-3 py-2.5">التوقيت</th>
                  <th className="px-3 py-2.5">التفاصيل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 font-mono font-bold text-slate-900 whitespace-nowrap">
                      {log.operation_number}
                    </td>
                    <td className="px-3 py-2.5 text-slate-700 whitespace-nowrap">
                      {log.mode === 'ALL_DRAFTS' ? 'جميع المسودات' : 'قيود محددة'}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">{log.total_targeted}</td>
                    <td className="px-3 py-2.5 font-mono font-semibold text-emerald-700 tabular-nums">
                      {log.posted_count}
                    </td>
                    <td className="px-3 py-2.5 font-mono font-semibold text-red-700 tabular-nums">
                      {log.failed_count}
                    </td>
                    <td className="px-3 py-2.5 font-mono font-semibold text-amber-700 tabular-nums">
                      {log.skipped_count}
                    </td>
                    <td className="px-3 py-2.5 text-slate-800 whitespace-nowrap">
                      {log.admin?.full_name || '-'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-slate-600 tabular-nums whitespace-nowrap" dir="ltr">
                      {formatDateTime(log.created_at)}
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedLog((cur) => (cur?.id === log.id ? null : log))
                        }
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
                      >
                        {selectedLog?.id === log.id ? 'إخفاء' : 'عرض القيود'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selectedLog ? (
          <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between text-xs font-bold text-slate-900">
              <span>تفاصيل قيود العملية {selectedLog.operation_number}</span>
              <span className="font-mono text-slate-500">
                {selectedLog.results.length} قيد
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto rounded border border-slate-200 bg-white">
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2">رقم القيد</th>
                    <th className="px-3 py-2">التاريخ</th>
                    <th className="px-3 py-2">المبلغ</th>
                    <th className="px-3 py-2">الحالة</th>
                    <th className="px-3 py-2">البيان / السبب</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {selectedLog.results.map((r, i) => (
                    <tr key={`${r.entry_id}-${i}`}>
                      <td className="px-3 py-2 font-mono font-semibold text-slate-900">
                        {r.entry_number}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-600">
                        {r.entry_date ? formatDate(r.entry_date) : '-'}
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums">
                        {formatMoney(r.total_debit)}
                      </td>
                      <td className="px-3 py-2">
                        <OutcomeLabel outcome={r.outcome} />
                      </td>
                      <td className="px-3 py-2 text-slate-700">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="flex justify-end border-t border-slate-200 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            إغلاق
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
