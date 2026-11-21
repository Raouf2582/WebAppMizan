import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  FileX2,
  History,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import { EmptyState, ModalShell, StatusText } from '../components/ui.tsx';
import { apiRequest } from '../lib/api.ts';
import { formatDate, formatMoney, JOURNAL_STATUS_LABELS } from '../lib/format.ts';
import type {
  JournalImportBatch,
  JournalImportBatchDetailsResponse,
  JournalImportBatchStatus,
  JournalImportDeletionAuditLog,
} from '../shared/types.ts';

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function BatchStatusCell({ status }: { status: JournalImportBatchStatus }) {
  if (status === 'COMPLETED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span>مكتمل</span>
      </span>
    );
  }
  if (status === 'COMPLETED_WITH_SKIPS') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 whitespace-nowrap">
        <Clock className="h-3.5 w-3.5 shrink-0" />
        <span>مكتمل مع استثناءات</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 whitespace-nowrap">
      <XCircle className="h-3.5 w-3.5 shrink-0" />
      <span>فشل الاستيراد</span>
    </span>
  );
}

export function JournalImportHistoryView({
  onOpenJournalEntry,
  onNotify,
}: {
  onOpenJournalEntry: (entryId: string) => void;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<'batches' | 'audit'>('batches');

  // History list state
  const [batches, setBatches] = useState<JournalImportBatch[]>([]);
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<JournalImportBatchStatus | 'ALL'>('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<JournalImportDeletionAuditLog[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  // Modals state
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<JournalImportBatchDetailsResponse | null>(null);
  const [deleteWithEntriesTarget, setDeleteWithEntriesTarget] = useState<JournalImportBatch | null>(
    null,
  );
  const [deleteHistoryOnlyTarget, setDeleteHistoryOnlyTarget] = useState<JournalImportBatch | null>(
    null,
  );
  const [submittingDelete, setSubmittingDelete] = useState(false);

  const loadBatches = useCallback(async () => {
    setLoadingBatches(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      const qs = params.toString();
      const res = await apiRequest<{ batches?: JournalImportBatch[] }>(
        `/api/journal-imports/history${qs ? `?${qs}` : ''}`,
      );
      setBatches(Array.isArray(res.batches) ? res.batches : []);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'تعذر تحميل سجل استيراد القيود.',
      );
    } finally {
      setLoadingBatches(false);
    }
  }, [search, statusFilter, startDate, endDate, onNotify]);

  const loadAuditLogs = useCallback(async () => {
    setLoadingAudit(true);
    try {
      const res = await apiRequest<{ logs?: JournalImportDeletionAuditLog[] }>(
        '/api/journal-imports/audit-logs',
      );
      setAuditLogs(Array.isArray(res.logs) ? res.logs : []);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'تعذر تحميل سجل تدقيق عمليات الحذف.',
      );
    } finally {
      setLoadingAudit(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  useEffect(() => {
    if (activeTab === 'audit') {
      loadAuditLogs();
    }
  }, [activeTab, loadAuditLogs]);

  async function openBatchDetails(batch: JournalImportBatch) {
    setDetailLoading(true);
    setDetailData({ batch, linkedEntries: [] });
    try {
      const res = await apiRequest<JournalImportBatchDetailsResponse>(
        `/api/journal-imports/history/${batch.id}`,
      );
      setDetailData(res);
    } catch (err) {
      setDetailData(null);
      onNotify(
        'error',
        err instanceof Error ? err.message : 'تعذر تحميل تفاصيل دفعة الاستيراد.',
      );
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleConfirmDeleteWithEntries() {
    if (!deleteWithEntriesTarget) return;
    setSubmittingDelete(true);
    try {
      const res = await apiRequest<{
        deleted: boolean;
        batchNumber: string;
        affectedEntriesCount: number;
      }>(`/api/journal-imports/history/${deleteWithEntriesTarget.id}`, {
        method: 'DELETE',
        body: {
          mode: 'DELETE_BATCH_AND_ENTRIES',
          confirm: true,
        },
      });
      onNotify(
        'success',
        `تم حذف دفعة الاستيراد ${res.batchNumber} وحذف ${res.affectedEntriesCount} قيد مسودة مرتبط بها نهائياً.`,
      );
      setDeleteWithEntriesTarget(null);
      if (detailData?.batch.id === deleteWithEntriesTarget.id) {
        setDetailData(null);
      }
      await Promise.all([loadBatches(), loadAuditLogs()]);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'تعذر حذف الدفعة والقيود المرتبطة.',
      );
    } finally {
      setSubmittingDelete(false);
    }
  }

  async function handleConfirmDeleteHistoryOnly() {
    if (!deleteHistoryOnlyTarget) return;
    setSubmittingDelete(true);
    try {
      const res = await apiRequest<{
        deleted: boolean;
        batchNumber: string;
        affectedEntriesCount: number;
      }>(`/api/journal-imports/history/${deleteHistoryOnlyTarget.id}`, {
        method: 'DELETE',
        body: {
          mode: 'DELETE_HISTORY_ONLY',
          confirm: true,
        },
      });
      onNotify(
        'success',
        `تم حذف سجل دفعة الاستيراد ${res.batchNumber} مع الإبقاء على ${res.affectedEntriesCount} قيد محاسبي سليماً دون أي تعديل على دفتر الأستاذ.`,
      );
      setDeleteHistoryOnlyTarget(null);
      if (detailData?.batch.id === deleteHistoryOnlyTarget.id) {
        setDetailData(null);
      }
      await Promise.all([loadBatches(), loadAuditLogs()]);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'تعذر حذف سجل الاستيراد.',
      );
    } finally {
      setSubmittingDelete(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header & Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4">
        <div>
          <h2 className="text-base font-bold text-slate-900">
            إدارة سجل استيراد القيود من Excel
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            شاشة خاصة بمدير النظام لمتابعة دفعات الاستيراد والقيود الناتجة عنها أو حذف السجل بشكل مستقل وآمن.
          </p>
        </div>

        <div className="flex items-center rounded-lg border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => setActiveTab('batches')}
            className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              activeTab === 'batches'
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <History className="h-3.5 w-3.5" />
            <span>سجل دفعات الاستيراد</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('audit')}
            className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              activeTab === 'audit'
                ? 'bg-white text-slate-900 shadow-xs border border-slate-200'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            <span>سجل تدقيق الحذف</span>
          </button>
        </div>
      </div>

      {activeTab === 'batches' ? (
        <>
          {/* Filters Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="بحث برقم الدفعة أو اسم الملف..."
                  className="w-64 rounded-lg border border-slate-300 py-2 pr-9 pl-3 text-sm focus:border-emerald-700 focus:outline-none"
                />
              </div>

              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as JournalImportBatchStatus | 'ALL')
                }
                aria-label="حالة الاستيراد"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
              >
                <option value="ALL">كل الحالات</option>
                <option value="COMPLETED">مكتمل</option>
                <option value="COMPLETED_WITH_SKIPS">مكتمل مع استثناءات</option>
                <option value="FAILED">فشل الاستيراد</option>
              </select>

              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="من تاريخ"
                className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-700"
              />
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-label="إلى تاريخ"
                className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-700"
              />

              {(search || statusFilter !== 'ALL' || startDate || endDate) ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('');
                    setStatusFilter('ALL');
                    setStartDate('');
                    setEndDate('');
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  إعادة تعيين
                </button>
              ) : null}
            </div>

            <button
              type="button"
              onClick={loadBatches}
              disabled={loadingBatches}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingBatches ? 'animate-spin' : ''}`} />
              <span>تحديث</span>
            </button>
          </div>

          {/* Batches Table */}
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            {loadingBatches ? (
              <div className="p-8 text-center text-sm text-slate-500">
                جاري تحميل سجل دفعات الاستيراد...
              </div>
            ) : batches.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={FileSpreadsheet}
                  title="لا توجد عمليات استيراد مسجلة"
                  description="عند استيراد قيود يومية من ملفات Excel ستظهر كل دفعة هنا برقم مرجعي مستقل وكامل تفاصيلها."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-sm">
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                    <tr>
                      <th className="px-4 py-3">رقم الدفعة</th>
                      <th className="px-4 py-3">اسم الملف</th>
                      <th className="px-4 py-3">تاريخ الاستيراد</th>
                      <th className="px-4 py-3">إجمالي القيود</th>
                      <th className="px-4 py-3">المسودات</th>
                      <th className="px-4 py-3">الحالة</th>
                      <th className="px-4 py-3">الإجراءات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {batches.map((batch) => {
                      const liveTotal = batch.live_total_entries ?? batch.drafts_created_count;
                      const liveDrafts = batch.live_draft_entries ?? batch.drafts_created_count;
                      const livePosted = batch.live_posted_entries ?? 0;
                      const canDeleteWithEntries = batch.can_delete_with_entries ?? true;

                      return (
                        <tr key={batch.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-mono text-xs font-bold text-slate-900 whitespace-nowrap">
                            {batch.batch_number}
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900 max-w-xs truncate">
                              {batch.file_name}
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-500">
                              أوراق العمل ({batch.sheet_names?.length || 0}):{' '}
                              {batch.sheet_names?.join('، ') || '-'}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="font-mono text-xs text-slate-700 tabular-nums" dir="ltr">
                              {formatDateTime(batch.created_at)}
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-500">
                              بواسطة: {batch.performer?.full_name || '-'}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-900 tabular-nums">
                            <div>{batch.detected_entries_count} مكتشف</div>
                            <div className="mt-0.5 text-[11px] text-slate-500">
                              مرتبط حالياً: {liveTotal}
                              {batch.rejected_entries_count > 0
                                ? ` · مرفوض: ${batch.rejected_entries_count}`
                                : ''}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs tabular-nums">
                            <div className="font-semibold text-slate-900">
                              {liveDrafts} مسودة
                            </div>
                            {livePosted > 0 ? (
                              <div className="mt-0.5 text-[11px] font-medium text-emerald-700">
                                {livePosted} مرحّل
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-3">
                            <BatchStatusCell status={batch.status} />
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => openBatchDetails(batch)}
                                title="عرض تفاصيل الدفعة والقيود المرتبطة"
                                className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                              >
                                <Eye className="h-3.5 w-3.5" />
                                <span>التفاصيل</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteHistoryOnlyTarget(batch)}
                                title="حذف سجل الاستيراد فقط مع الإبقاء على جميع القيود المحاسبية"
                                className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50/70 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                              >
                                <FileX2 className="h-3.5 w-3.5" />
                                <span>حذف السجل فقط</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteWithEntriesTarget(batch)}
                                title={
                                  canDeleteWithEntries
                                    ? 'حذف الدفعة وجميع قيود المسودة المرتبطة بها'
                                    : batch.delete_block_reason || 'توجد قيود غير مؤهلة للحذف'
                                }
                                className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs font-medium ${
                                  canDeleteWithEntries
                                    ? 'border-red-300 bg-red-50/70 text-red-700 hover:bg-red-100'
                                    : 'border-slate-200 bg-slate-100 text-slate-500 hover:bg-slate-200'
                                }`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                <span>حذف الدفعة والقيود</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : (
        /* Audit Log Tab */
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                سجل تدقيق حذف دفعات الاستيراد
              </h3>
              <p className="text-xs text-slate-500">
                توثيق كامل لكل عملية حذف تمت على سجل الاستيراد مع المسؤول والتوقيت وأرقام القيود المتأثرة.
              </p>
            </div>
            <button
              type="button"
              onClick={loadAuditLogs}
              disabled={loadingAudit}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingAudit ? 'animate-spin' : ''}`} />
              <span>تحديث</span>
            </button>
          </div>

          {loadingAudit ? (
            <div className="p-8 text-center text-sm text-slate-500">جاري تحميل سجل التدقيق...</div>
          ) : auditLogs.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={ShieldAlert}
                title="لا توجد عمليات حذف مسجلة"
                description="عند قيام مدير النظام بحذف سجل استيراد أو حذف دفعة مع قيودها، سيتم توثيق العملية هنا تلقائياً."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-3">رقم الدفعة</th>
                    <th className="px-4 py-3">اسم الملف</th>
                    <th className="px-4 py-3">نوع الحذف</th>
                    <th className="px-4 py-3">عدد القيود المتأثرة</th>
                    <th className="px-4 py-3">أرقام القيود</th>
                    <th className="px-4 py-3">المسؤول المنفذ</th>
                    <th className="px-4 py-3">تاريخ وتوقيت الحذف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {auditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-xs font-bold text-slate-900 whitespace-nowrap">
                        {log.batch_number}
                      </td>
                      <td className="px-4 py-3 text-slate-800 max-w-xs truncate">
                        {log.file_name}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {log.deletion_type === 'DELETE_BATCH_AND_ENTRIES' ? (
                          <span className="text-xs font-semibold text-red-700">
                            حذف الدفعة والقيود معاً
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-amber-700">
                            حذف سجل الاستيراد فقط (الإبقاء على القيود)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900 tabular-nums">
                        {log.affected_entries_count}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {log.affected_entry_numbers?.length > 0
                          ? log.affected_entry_numbers.join('، ')
                          : '-'}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-800 whitespace-nowrap">
                        {log.admin?.full_name || '-'}
                      </td>
                      <td
                        className="px-4 py-3 font-mono text-xs text-slate-600 tabular-nums whitespace-nowrap"
                        dir="ltr"
                      >
                        {formatDateTime(log.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Option 3: Complete Batch Details & Linked Entries Modal */}
      <ModalShell
        open={!!detailData}
        title={`تفاصيل دفعة الاستيراد ${detailData?.batch.batch_number || ''}`}
        onClose={() => setDetailData(null)}
        maxWidth="max-w-5xl"
      >
        {detailData ? (
          <div className="space-y-5">
            {/* Batch Metadata Summary */}
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-4">
              <div>
                <div className="text-xs text-slate-500">رقم الدفعة</div>
                <div className="mt-1 font-mono font-bold text-slate-900">
                  {detailData.batch.batch_number}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">اسم ملف Excel</div>
                <div className="mt-1 font-semibold text-slate-900 truncate">
                  {detailData.batch.file_name}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">تاريخ ووقت الاستيراد</div>
                <div className="mt-1 font-mono text-xs font-semibold text-slate-900" dir="ltr">
                  {formatDateTime(detailData.batch.created_at)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">المستخدم المنفذ</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {detailData.batch.performer?.full_name || '-'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">الصفوف المستوردة</div>
                <div className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                  {detailData.batch.imported_rows}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">القيود المكتشفة</div>
                <div className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                  {detailData.batch.detected_entries_count}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">المسودات المنشأة</div>
                <div className="mt-1 font-mono font-semibold text-emerald-700 tabular-nums">
                  {detailData.batch.drafts_created_count}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">القيود المرفوضة</div>
                <div className="mt-1 font-mono font-semibold text-red-700 tabular-nums">
                  {detailData.batch.rejected_entries_count}
                </div>
              </div>
              <div className="col-span-2 sm:col-span-2">
                <div className="text-xs text-slate-500">أوراق العمل المستوردة</div>
                <div className="mt-1 text-xs font-medium text-slate-800">
                  {detailData.batch.sheet_names?.join('، ') || '-'}
                </div>
              </div>
              <div className="col-span-2 sm:col-span-2">
                <div className="text-xs text-slate-500">حالة العملية</div>
                <div className="mt-1">
                  <BatchStatusCell status={detailData.batch.status} />
                </div>
              </div>
              {detailData.batch.generated_entry_numbers?.length > 0 ? (
                <div className="col-span-2 sm:col-span-4 border-t border-slate-200 pt-3">
                  <div className="text-xs text-slate-500">أرقام القيود الناتجة عن هذه الدفعة</div>
                  <div className="mt-1 font-mono text-xs font-semibold text-slate-800">
                    {detailData.batch.generated_entry_numbers.join('، ')}
                  </div>
                </div>
              ) : null}
            </div>

            {/* Linked Live Journal Entries */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900">
                  القيود المحاسبية المرتبطة حالياً بهذه الدفعة ({detailData.linkedEntries.length})
                </h3>
                {!detailLoading && detailData.batch.can_delete_with_entries === false ? (
                  <span className="text-xs font-semibold text-red-700">
                    لا يمكن حذف هذه الدفعة مع قيودها بسبب وجود قيود مرحّلة أو مقيدة
                  </span>
                ) : null}
              </div>

              {detailLoading ? (
                <div className="rounded-lg border border-slate-200 p-6 text-center text-xs text-slate-500">
                  جاري تحميل القيود المرتبطة...
                </div>
              ) : detailData.linkedEntries.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                  لا توجد قيود يومية مرتبطة حالياً بهذه الدفعة.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-right text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                      <tr>
                        <th className="px-3 py-2.5">رقم القيد</th>
                        <th className="px-3 py-2.5">التاريخ</th>
                        <th className="px-3 py-2.5">البيان</th>
                        <th className="px-3 py-2.5">المدين</th>
                        <th className="px-3 py-2.5">الدائن</th>
                        <th className="px-3 py-2.5">الحالة</th>
                        <th className="px-3 py-2.5">الأهلية للحذف</th>
                        <th className="px-3 py-2.5">الانتقال</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {detailData.linkedEntries.map((entry) => (
                        <tr key={entry.id} className="hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-mono font-bold text-slate-900 whitespace-nowrap">
                            {entry.entry_number}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                            {formatDate(entry.entry_date)}
                          </td>
                          <td className="px-3 py-2.5 text-slate-800 max-w-xs truncate">
                            {entry.description}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-900 tabular-nums whitespace-nowrap">
                            {formatMoney(entry.total_debit)}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-slate-900 tabular-nums whitespace-nowrap">
                            {formatMoney(entry.total_credit)}
                          </td>
                          <td className="px-3 py-2.5">
                            <StatusText
                              variant={entry.status === 'POSTED' ? 'posted' : 'draft'}
                              label={JOURNAL_STATUS_LABELS[entry.status]}
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            {entry.eligible_for_delete ? (
                              <span className="text-emerald-700 font-medium">مؤهل كمسودة</span>
                            ) : (
                              <span className="text-red-700 font-medium">
                                {entry.block_reason || 'غير مؤهل'}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => {
                                setDetailData(null);
                                onOpenJournalEntry(entry.id);
                              }}
                              className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                            >
                              <ExternalLink className="h-3 w-3" />
                              <span>فتح في القيود</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Import Outcome Log Breakdown (Created & Rejected from Excel) */}
            {Array.isArray(detailData.batch.details) && detailData.batch.details.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-sm font-bold text-slate-900">
                  سجل نتائج التحقق وقت الاستيراد ({detailData.batch.details.length})
                </h3>
                <div className="max-h-60 overflow-y-auto rounded-lg border border-slate-200">
                  <table className="w-full text-right text-xs">
                    <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 font-semibold text-slate-600">
                      <tr>
                        <th className="px-3 py-2">ورقة العمل</th>
                        <th className="px-3 py-2">رقم القيد / المجموعة</th>
                        <th className="px-3 py-2">التاريخ</th>
                        <th className="px-3 py-2">البيان</th>
                        <th className="px-3 py-2">الإجمالي</th>
                        <th className="px-3 py-2">النتيجة والملاحظات</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {detailData.batch.details.map((item, idx) => (
                        <tr key={`${item.groupKey}-${idx}`}>
                          <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                            {item.sheetName}
                          </td>
                          <td className="px-3 py-2 font-mono font-semibold text-slate-900 whitespace-nowrap">
                            {item.entryNumber || item.groupKey}
                          </td>
                          <td className="px-3 py-2 font-mono text-slate-600 whitespace-nowrap">
                            {item.entryDate || '-'}
                          </td>
                          <td className="px-3 py-2 text-slate-800 max-w-[200px] truncate">
                            {item.description || '-'}
                          </td>
                          <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap">
                            {formatMoney(item.totalDebit)}
                          </td>
                          <td className="px-3 py-2">
                            {item.outcome === 'CREATED' ? (
                              <span className="font-medium text-emerald-700">
                                {item.messages.join('؛ ')}
                              </span>
                            ) : (
                              <span className="font-medium text-red-700">
                                مرفوض: {item.messages.join('؛ ')}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {/* Modal Footer Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteHistoryOnlyTarget(detailData.batch)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                >
                  <FileX2 className="h-4 w-4" />
                  <span>حذف سجل الاستيراد فقط</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteWithEntriesTarget(detailData.batch)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-100"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>حذف الدفعة والقيود</span>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setDetailData(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                إغلاق
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>

      {/* Option 1 Confirmation Modal: Delete Batch + Linked Draft Entries */}
      <ModalShell
        open={!!deleteWithEntriesTarget}
        title="تأكيد حذف دفعة الاستيراد والقيود المرتبطة"
        onClose={() => {
          if (!submittingDelete) setDeleteWithEntriesTarget(null);
        }}
        maxWidth="max-w-lg"
      >
        {deleteWithEntriesTarget ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-slate-500">رقم الدفعة</div>
                  <div className="mt-1 font-mono font-bold text-slate-900">
                    {deleteWithEntriesTarget.batch_number}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">اسم الملف</div>
                  <div className="mt-1 font-semibold text-slate-900 truncate">
                    {deleteWithEntriesTarget.file_name}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">القيود المرتبطة التي سيتم حذفها</div>
                  <div className="mt-1 font-mono font-bold text-red-700 tabular-nums">
                    {deleteWithEntriesTarget.live_total_entries ??
                      deleteWithEntriesTarget.drafts_created_count}{' '}
                    قيد
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">المسودات المؤهلة</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                    {deleteWithEntriesTarget.live_draft_entries ??
                      deleteWithEntriesTarget.drafts_created_count}{' '}
                    مسودة
                  </div>
                </div>
              </div>
            </div>

            {deleteWithEntriesTarget.can_delete_with_entries === false ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3.5 text-xs text-red-800 space-y-2">
                <div className="flex items-center gap-2 font-bold">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>عملية الحذف الشامل محظورة لحماية السلامة المحاسبية</span>
                </div>
                <p className="leading-relaxed">
                  {deleteWithEntriesTarget.delete_block_reason ||
                    'تحتوي هذه الدفعة على قيود مرحّلة أو مرتبطة بسندات أو فترات مغلقة. لا يمكن حذف الدفعة مع القيود إلا إذا كانت جميع قيودها في حالة مسودة ومفتوحة.'}
                </p>
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      const target = deleteWithEntriesTarget;
                      setDeleteWithEntriesTarget(null);
                      setDeleteHistoryOnlyTarget(target);
                    }}
                    className="rounded border border-amber-400 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50"
                  >
                    الانتقال إلى «حذف سجل الاستيراد فقط مع الإبقاء على القيود»
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50/60 p-3.5 text-xs leading-relaxed text-red-900">
                سيتم حذف سجل دفعة الاستيراد{' '}
                <span className="font-mono font-bold">{deleteWithEntriesTarget.batch_number}</span>{' '}
                وحذف عدد{' '}
                <span className="font-mono font-bold">
                  {deleteWithEntriesTarget.live_total_entries ??
                    deleteWithEntriesTarget.drafts_created_count}
                </span>{' '}
                قيد مسودة مرتبط بها وجميع سطورها بشكل نهائي في معاملة واحدة، ولن تتأثر أي قيود يدوية أو قيود دفعات أخرى.
              </div>
            )}

            <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                type="button"
                disabled={submittingDelete}
                onClick={() => setDeleteWithEntriesTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={
                  submittingDelete || deleteWithEntriesTarget.can_delete_with_entries === false
                }
                onClick={handleConfirmDeleteWithEntries}
                className="rounded-lg bg-red-700 px-5 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {submittingDelete ? 'جاري الحذف...' : 'تأكيد حذف الدفعة والقيود'}
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>

      {/* Option 2 Confirmation Modal: Delete Import History Only (Preserve All Entries) */}
      <ModalShell
        open={!!deleteHistoryOnlyTarget}
        title="تأكيد حذف سجل الاستيراد فقط"
        onClose={() => {
          if (!submittingDelete) setDeleteHistoryOnlyTarget(null);
        }}
        maxWidth="max-w-lg"
      >
        {deleteHistoryOnlyTarget ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-slate-500">رقم الدفعة</div>
                  <div className="mt-1 font-mono font-bold text-slate-900">
                    {deleteHistoryOnlyTarget.batch_number}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">اسم الملف</div>
                  <div className="mt-1 font-semibold text-slate-900 truncate">
                    {deleteHistoryOnlyTarget.file_name}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">إجمالي القيود التي ستبقى سليمة</div>
                  <div className="mt-1 font-mono font-bold text-emerald-700 tabular-nums">
                    {deleteHistoryOnlyTarget.live_total_entries ??
                      deleteHistoryOnlyTarget.drafts_created_count}{' '}
                    قيد
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">تفصيل الحالات</div>
                  <div className="mt-1 font-mono text-xs text-slate-700">
                    {deleteHistoryOnlyTarget.live_draft_entries ?? 0} مسودة ·{' '}
                    {deleteHistoryOnlyTarget.live_posted_entries ?? 0} مرحّل
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3.5 text-xs leading-relaxed text-emerald-950">
              سيتم حذف سجل دفعة الاستيراد وتفاصيل عملية الاستيراد فقط، مع{' '}
              <strong>الإبقاء على جميع القيود المحاسبية الناتجة عنها سليمة بالكامل</strong>{' '}
              (سواء كانت مسودة أو مرحّلة) لتستمر كقيود محاسبية اعتيادية دون أي تأثير على دفتر الأستاذ العام أو التقارير المالية.
            </div>

            <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                type="button"
                disabled={submittingDelete}
                onClick={() => setDeleteHistoryOnlyTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={submittingDelete}
                onClick={handleConfirmDeleteHistoryOnly}
                className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {submittingDelete ? 'جاري التنفيذ...' : 'تأكيد حذف السجل فقط'}
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>
    </div>
  );
}
