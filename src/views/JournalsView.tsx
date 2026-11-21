import Decimal from 'decimal.js';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  CheckCheck,
  CheckCircle2,
  Edit2,
  Eye,
  History,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  BulkJournalPostModal,
  BulkPostAuditLogsModal,
} from '../components/BulkJournalPostModal.tsx';
import { JournalImportModal } from '../components/JournalImportModal.tsx';
import {
  ConfirmModal,
  EmptyState,
  ModalShell,
  StatusText,
} from '../components/ui.tsx';
import { apiRequest } from '../lib/api.ts';
import {
  formatDate,
  formatMoney,
  JOURNAL_SOURCE_LABELS,
  JOURNAL_STATUS_LABELS,
} from '../lib/format.ts';
import type {
  Account,
  BulkJournalPostMode,
  BulkJournalPostPreviewResponse,
  CostCenter,
  JournalEntry,
  JournalStatus,
  UserProfile,
} from '../shared/types.ts';

interface LineDraft {
  account_id: string;
  debit: string;
  credit: string;
  description: string;
}

const emptyLine = (): LineDraft => ({
  account_id: '',
  debit: '',
  credit: '',
  description: '',
});

export function JournalsView({
  profile,
  onNotify,
  focusedEntryId,
  onClearFocusedEntry,
}: {
  profile: UserProfile;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
  focusedEntryId?: string | null;
  onClearFocusedEntry?: () => void;
}) {
  const isAdmin = profile.role === 'ADMIN';
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 15;
  const [loading, setLoading] = useState(true);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<JournalStatus | 'ALL'>('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Form modal
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [headerCostCenterId, setHeaderCostCenterId] = useState('');
  const [description, setDescription] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine()]);
  const [saving, setSaving] = useState(false);

  // Detail modal
  const [detailEntry, setDetailEntry] = useState<JournalEntry | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);

  // Confirmations & Reversal modal
  const [postTarget, setPostTarget] = useState<JournalEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JournalEntry | null>(null);
  const [deleteVoucherAction, setDeleteVoucherAction] = useState<'KEEP_DRAFT' | 'DELETE_VOUCHER'>('KEEP_DRAFT');
  const [reverseTarget, setReverseTarget] = useState<JournalEntry | null>(null);
  const [reverseDate, setReverseDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Bulk Posting State (Admin only)
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkPreviewLoading, setBulkPreviewLoading] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<BulkJournalPostMode>('SELECTED');
  const [bulkPreview, setBulkPreview] = useState<BulkJournalPostPreviewResponse | null>(null);
  const [bulkAuditOpen, setBulkAuditOpen] = useState(false);

  const postableAccounts = useMemo(
    () => accounts.filter((a) => a.status === 'ACTIVE' && a.is_postable),
    [accounts],
  );
  const activeCostCenters = useMemo(
    () => costCenters.filter((c) => c.status === 'ACTIVE'),
    [costCenters],
  );
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const headerCostCenterRequired = useMemo(
    () => lines.some((l) => l.account_id && accountMap.get(l.account_id)?.cost_center_required),
    [lines, accountMap],
  );

  const loadMetadata = useCallback(async () => {
    try {
      const [accRes, ccRes] = await Promise.all([
        apiRequest<{ accounts?: Account[] }>('/api/accounts'),
        apiRequest<{ costCenters?: CostCenter[] }>('/api/cost-centers'),
      ]);
      setAccounts(Array.isArray(accRes.accounts) ? accRes.accounts : []);
      setCostCenters(Array.isArray(ccRes.costCenters) ? ccRes.costCenters : []);
    } catch {
      // handled on main fetch if needed
    }
  }, []);

  const loadJournals = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (search.trim()) params.set('search', search.trim());

      const res = await apiRequest<{ entries?: JournalEntry[]; total?: number }>(
        `/api/journals?${params.toString()}`,
      );
      setEntries(Array.isArray(res.entries) ? res.entries : []);
      setTotal(typeof res.total === 'number' ? res.total : 0);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل القيود اليومية.');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, startDate, endDate, search, onNotify]);

  useEffect(() => {
    loadMetadata();
  }, [loadMetadata]);

  useEffect(() => {
    loadJournals();
  }, [loadJournals]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const pageDraftIds = useMemo(
    () => entries.filter((e) => e.status === 'DRAFT').map((e) => e.id),
    [entries],
  );
  const allPageDraftsSelected =
    pageDraftIds.length > 0 && pageDraftIds.every((id) => selectedSet.has(id));
  const somePageDraftsSelected =
    pageDraftIds.some((id) => selectedSet.has(id)) && !allPageDraftsSelected;

  function toggleRowSelection(entry: JournalEntry) {
    if (!isAdmin || entry.status !== 'DRAFT') return;
    setSelectedIds((prev) =>
      prev.includes(entry.id) ? prev.filter((id) => id !== entry.id) : [...prev, entry.id],
    );
  }

  function selectAllPageDrafts() {
    if (!isAdmin || pageDraftIds.length === 0) return;
    setSelectedIds((prev) => Array.from(new Set([...prev, ...pageDraftIds])));
  }

  function toggleHeaderSelectAll() {
    if (!isAdmin || pageDraftIds.length === 0) return;
    if (allPageDraftsSelected) {
      const pageSet = new Set(pageDraftIds);
      setSelectedIds((prev) => prev.filter((id) => !pageSet.has(id)));
    } else {
      selectAllPageDrafts();
    }
  }

  function clearSelection() {
    setSelectedIds([]);
  }

  async function openBulkPostPreview(mode: BulkJournalPostMode) {
    if (!isAdmin) return;
    if (mode === 'SELECTED' && selectedIds.length === 0) {
      onNotify('info', 'يرجى تحديد قيد مسودة واحد على الأقل.');
      return;
    }
    if (mode === 'ALL_DRAFTS' && statusFilter === 'POSTED') {
      onNotify(
        'info',
        'الفلتر الحالي محدد على القيود المرحّلة فقط؛ يرجى اختيار «كل الحالات» أو «مسودة» لترحيل المسودات.',
      );
      return;
    }

    setBulkPreviewLoading(true);
    try {
      const payload =
        mode === 'SELECTED'
          ? { mode: 'SELECTED', entryIds: selectedIds }
          : {
              mode: 'ALL_DRAFTS',
              filters: {
                search: search.trim(),
                startDate,
                endDate,
              },
            };

      const res = await apiRequest<{ preview: BulkJournalPostPreviewResponse }>(
        '/api/journals/bulk-post/preview',
        {
          method: 'POST',
          body: payload,
        },
      );

      if (res.preview.totalTargeted === 0) {
        onNotify('info', 'لا توجد قيود مسودة مؤهلة للترحيل ضمن النطاق الحالي.');
        return;
      }

      setBulkMode(mode);
      setBulkPreview(res.preview);
      setBulkModalOpen(true);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'تعذر تجهيز معاينة الترحيل الجماعي.',
      );
    } finally {
      setBulkPreviewLoading(false);
    }
  }

  useEffect(() => {
    if (!focusedEntryId) return;
    let active = true;
    (async () => {
      try {
        const res = await apiRequest<{ entry: JournalEntry }>(`/api/journals/${focusedEntryId}`);
        if (active) {
          setDetailEntry(res.entry);
        }
      } catch (err) {
        if (active) {
          onNotify(
            'error',
            err instanceof Error ? err.message : 'تعذر فتح تفاصيل القيد المطلوب.',
          );
        }
      } finally {
        if (active) {
          onClearFocusedEntry?.();
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [focusedEntryId, onClearFocusedEntry, onNotify]);

  const totals = useMemo(() => {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const line of lines) {
      if (line.debit && !Number.isNaN(Number(line.debit))) {
        debit = debit.plus(new Decimal(line.debit));
      }
      if (line.credit && !Number.isNaN(Number(line.credit))) {
        credit = credit.plus(new Decimal(line.credit));
      }
    }
    const diff = debit.minus(credit).abs();
    return {
      debit: debit.toDecimalPlaces(2).toNumber(),
      credit: credit.toDecimalPlaces(2).toNumber(),
      diff: diff.toDecimalPlaces(2).toNumber(),
      balanced: debit.gt(0) && debit.eq(credit),
    };
  }, [lines]);

  function openNewModal() {
    setEditingId(null);
    setEntryDate(new Date().toISOString().slice(0, 10));
    setHeaderCostCenterId('');
    setDescription('');
    setReferenceNumber('');
    setLines([emptyLine(), emptyLine()]);
    setFormOpen(true);
  }

  async function openEditModal(entry: JournalEntry) {
    try {
      const res = await apiRequest<{ entry: JournalEntry }>(`/api/journals/${entry.id}`);
      const full = res.entry;
      setEditingId(full.id);
      setEntryDate(full.entry_date);
      setHeaderCostCenterId(
        full.cost_center_id || full.lines?.find((l) => l.cost_center_id)?.cost_center_id || '',
      );
      setDescription(full.description);
      setReferenceNumber(full.reference_number || '');
      setLines(
        (full.lines || []).map((l) => ({
          account_id: l.account_id,
          debit: Number(l.debit) > 0 ? String(l.debit) : '',
          credit: Number(l.credit) > 0 ? String(l.credit) : '',
          description: l.description || '',
        })),
      );
      setFormOpen(true);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل تفاصيل القيد.');
    }
  }

  async function openReverseModal(entry: JournalEntry) {
    if (!isAdmin) return;
    if (entry.reversal_entry) {
      onNotify(
        'info',
        `تم إنشاء قيد عكسي لهذا القيد مسبقاً برقم (${entry.reversal_entry.entry_number}).`,
      );
      return;
    }
    try {
      const res = await apiRequest<{ entry: JournalEntry }>(`/api/journals/${entry.id}`);
      setReverseDate(new Date().toISOString().slice(0, 10));
      setReverseTarget(res.entry);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تجهيز القيد العكسي.');
    }
  }

  async function openDetails(entry: JournalEntry) {
    try {
      const res = await apiRequest<{ entry: JournalEntry }>(`/api/journals/${entry.id}`);
      setDetailEntry(res.entry);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل تفاصيل القيد.');
    }
  }

  function updateLine(idx: number, patch: Partial<LineDraft>) {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const next = { ...l, ...patch };
        if (patch.debit !== undefined && Number(patch.debit) > 0) {
          next.credit = '';
        } else if (patch.credit !== undefined && Number(patch.credit) > 0) {
          next.debit = '';
        }
        return next;
      }),
    );
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (headerCostCenterRequired && !headerCostCenterId) {
      onNotify('error', 'أحد الحسابات المختارة يتطلب تحديد مركز تكلفة في رأس القيد.');
      return;
    }

    setSaving(true);
    try {
      const normalizedCostCenterId = headerCostCenterId || null;
      const payloadLines = lines.map((l) => ({
        account_id: l.account_id,
        cost_center_id: normalizedCostCenterId,
        debit: l.debit ? Number(l.debit) : 0,
        credit: l.credit ? Number(l.credit) : 0,
        description: l.description || null,
      }));

      const body = {
        entry_date: entryDate,
        description,
        reference_number: referenceNumber || null,
        cost_center_id: normalizedCostCenterId,
        lines: payloadLines,
      };

      if (editingId) {
        await apiRequest(`/api/journals/${editingId}`, { method: 'PATCH', body });
        onNotify('success', 'تم تحديث القيد المسودة بنجاح.');
      } else {
        await apiRequest('/api/journals', { method: 'POST', body });
        onNotify('success', 'تم حفظ القيد المحاسبي كمسودة.');
      }

      setFormOpen(false);
      await loadJournals();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حفظ القيد المحاسبي.');
    } finally {
      setSaving(false);
    }
  }

  async function handlePost() {
    if (!postTarget) return;
    setSaving(true);
    try {
      await apiRequest(`/api/journals/${postTarget.id}/post`, { method: 'POST' });
      onNotify('success', `تم ترحيل القيد ${postTarget.entry_number} بنجاح.`);
      setPostTarget(null);
      await loadJournals();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر ترحيل القيد.');
    } finally {
      setSaving(false);
    }
  }

  async function handleReverseConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!reverseTarget || !isAdmin) return;
    setSaving(true);
    try {
      const res = await apiRequest<{ entry: JournalEntry }>(
        `/api/journals/${reverseTarget.id}/reverse`,
        {
          method: 'POST',
          body: { entry_date: reverseDate },
        },
      );
      onNotify(
        'success',
        `تم إنشاء القيد العكسي رقم ${res.entry.entry_number} كمسودة مرتبطة بالقيد ${reverseTarget.entry_number}.`,
      );
      setReverseTarget(null);
      await loadJournals();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر إنشاء القيد العكسي.');
    } finally {
      setSaving(false);
    }
  }

  function openDeleteModal(entry: JournalEntry) {
    if (!isAdmin) return;
    setDeleteVoucherAction('KEEP_DRAFT');
    setDeleteTarget(entry);
  }

  async function handleDelete() {
    if (!deleteTarget || !isAdmin) return;
    setSaving(true);
    try {
      const hasLinkedVoucher =
        Boolean(deleteTarget.source_voucher) || deleteTarget.source_type !== 'MANUAL';
      const res = await apiRequest<{
        deleted: boolean;
        voucherAction: 'KEEP_DRAFT' | 'DELETE_VOUCHER';
        linkedVoucherNumber: string | null;
      }>(`/api/journals/${deleteTarget.id}`, {
        method: 'DELETE',
        body: { voucher_action: deleteVoucherAction },
      });

      if (hasLinkedVoucher && res.linkedVoucherNumber) {
        if (res.voucherAction === 'DELETE_VOUCHER') {
          onNotify(
            'success',
            `تم حذف القيد رقم "${deleteTarget.entry_number}" وحذف السند المرتبط "${res.linkedVoucherNumber}" نهائياً.`,
          );
        } else {
          onNotify(
            'success',
            `تم حذف القيد رقم "${deleteTarget.entry_number}" والاحتفاظ بالسند "${res.linkedVoucherNumber}" بحالة غير مُرحّل (مسودة).`,
          );
        }
      } else {
        onNotify('success', `تم حذف القيد رقم "${deleteTarget.entry_number}" بنجاح.`);
      }

      setDeleteTarget(null);
      await loadJournals();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حذف القيد.');
    } finally {
      setSaving(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedIds([]);
                setPage(1);
              }}
              placeholder="بحث برقم القيد أو البيان..."
              className="w-56 rounded-lg border border-slate-300 py-2 pr-9 pl-3 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as JournalStatus | 'ALL');
              setSelectedIds([]);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
          >
            <option value="ALL">كل الحالات</option>
            <option value="DRAFT">مسودة</option>
            <option value="POSTED">مرحل</option>
          </select>

          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setSelectedIds([]);
              setPage(1);
            }}
            aria-label="من تاريخ"
            className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-700"
          />
          <input
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              setSelectedIds([]);
              setPage(1);
            }}
            aria-label="إلى تاريخ"
            className="rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-700"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {isAdmin ? (
            <>
              <button
                type="button"
                disabled={bulkPreviewLoading}
                onClick={() => openBulkPostPreview('ALL_DRAFTS')}
                className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 whitespace-nowrap"
              >
                <CheckCheck className="h-4 w-4" />
                <span>ترحيل جميع المسودات</span>
              </button>
              <button
                type="button"
                onClick={() => setBulkAuditOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <History className="h-4 w-4 text-slate-500" />
                <span>سجل الترحيل الجماعي</span>
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => setImportModalOpen(true)}
            className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
          >
            <Upload className="h-4 w-4 text-emerald-700" />
            <span>استيراد من Excel</span>
          </button>
          <button
            type="button"
            onClick={openNewModal}
            className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>قيد يومية جديد</span>
          </button>
        </div>
      </div>

      {/* Contextual Bulk Selection Action Bar (Admin only) */}
      {isAdmin && (selectedIds.length > 0 || pageDraftIds.length > 0) ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {selectedIds.length > 0 ? (
              <span className="font-semibold text-slate-900">
                تم تحديد{' '}
                <span className="font-mono font-bold text-emerald-700 tabular-nums">
                  {selectedIds.length}
                </span>{' '}
                قيد مسودة للترحيل الجماعي
              </span>
            ) : (
              <span className="text-xs text-slate-600">
                توجد في هذه الصفحة{' '}
                <span className="font-mono font-bold text-slate-900 tabular-nums">
                  {pageDraftIds.length}
                </span>{' '}
                قيود مسودة قابلة للتحديد والترحيل الجماعي
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {pageDraftIds.length > 0 && !allPageDraftsSelected ? (
              <button
                type="button"
                onClick={selectAllPageDrafts}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                تحديد الكل ({pageDraftIds.length})
              </button>
            ) : null}
            {selectedIds.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  إلغاء التحديد
                </button>
                <button
                  type="button"
                  disabled={bulkPreviewLoading}
                  onClick={() => openBulkPostPreview('SELECTED')}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>ترحيل المحدد ({selectedIds.length})</span>
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Table */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">جاري تحميل القيود...</div>
        ) : entries.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={BookOpen}
              title="لا توجد قيود يومية"
              description="أنشئ قيداً محاسبياً جديداً بنظام القيد المزدوج المتوازن."
              action={
                <button
                  type="button"
                  onClick={openNewModal}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                >
                  إنشاء قيد يومية
                </button>
              }
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    {isAdmin ? (
                      <th className="w-10 px-3 py-3 text-center">
                        <input
                          type="checkbox"
                          disabled={pageDraftIds.length === 0}
                          checked={allPageDraftsSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = somePageDraftsSelected;
                          }}
                          onChange={toggleHeaderSelectAll}
                          aria-label="تحديد جميع قيود المسودة في الصفحة"
                          className="h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-700 disabled:opacity-40"
                        />
                      </th>
                    ) : null}
                    <th className="px-4 py-3">رقم القيد</th>
                    <th className="px-4 py-3">التاريخ</th>
                    <th className="px-4 py-3">المصدر</th>
                    <th className="px-4 py-3">مركز التكلفة</th>
                    <th className="px-4 py-3">البيان</th>
                    <th className="px-4 py-3">المدين</th>
                    <th className="px-4 py-3">الدائن</th>
                    <th className="px-4 py-3">الحالة</th>
                    <th className="px-4 py-3">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {entries.map((je) => {
                    const canEdit =
                      je.status === 'DRAFT' &&
                      je.source_type === 'MANUAL' &&
                      (isAdmin || je.created_by === profile.id);
                    const isSelected = selectedSet.has(je.id);
                    return (
                      <tr
                        key={je.id}
                        className={isSelected ? 'bg-emerald-50/40 hover:bg-emerald-50/70' : 'hover:bg-slate-50'}
                      >
                        {isAdmin ? (
                          <td className="w-10 px-3 py-3 text-center">
                            <input
                              type="checkbox"
                              disabled={je.status !== 'DRAFT'}
                              checked={isSelected}
                              onChange={() => toggleRowSelection(je)}
                              title={
                                je.status === 'DRAFT'
                                  ? `تحديد القيد ${je.entry_number}`
                                  : 'القيد مرحّل بالفعل ولا يمكن تحديده'
                              }
                              aria-label={`تحديد القيد ${je.entry_number}`}
                              className="h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-700 disabled:cursor-not-allowed disabled:opacity-35"
                            />
                          </td>
                        ) : null}
                        <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900">
                          <div>{je.entry_number}</div>
                          {je.source_voucher ? (
                            <div className="mt-0.5 font-sans text-[11px] font-medium text-emerald-700">
                              سند {je.source_voucher.voucher_number}
                            </div>
                          ) : null}
                          {je.reversed_entry ? (
                            <div className="mt-0.5 font-sans text-[11px] font-medium text-amber-700">
                              عكس لـ {je.reversed_entry.entry_number}
                            </div>
                          ) : null}
                          {je.reversal_entry ? (
                            <div className="mt-0.5 font-sans text-[11px] font-medium text-slate-500">
                              معكوس بـ {je.reversal_entry.entry_number}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-600 tabular-nums">
                          {formatDate(je.entry_date)}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {JOURNAL_SOURCE_LABELS[je.source_type]}
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-600">
                          {je.cost_center ? `${je.cost_center.code} — ${je.cost_center.name_ar}` : '-'}
                        </td>
                        <td className="px-4 py-3 text-slate-800 max-w-xs truncate">
                          {je.description}
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-900 tabular-nums">
                          {formatMoney(je.total_debit)}
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-900 tabular-nums">
                          {formatMoney(je.total_credit)}
                        </td>
                        <td className="px-4 py-3">
                          <StatusText
                            variant={je.status === 'POSTED' ? 'posted' : 'draft'}
                            label={JOURNAL_STATUS_LABELS[je.status]}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openDetails(je)}
                              title="عرض التفاصيل"
                              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                            {canEdit ? (
                              <button
                                type="button"
                                onClick={() => openEditModal(je)}
                                title="تعديل المسودة"
                                className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                              >
                                <Edit2 className="h-4 w-4" />
                              </button>
                            ) : null}
                            {isAdmin && je.status === 'DRAFT' ? (
                              <button
                                type="button"
                                onClick={() => setPostTarget(je)}
                                title="ترحيل القيد"
                                className="rounded p-1.5 text-emerald-700 hover:bg-emerald-50"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                              </button>
                            ) : null}
                            {isAdmin && je.status === 'POSTED' ? (
                              <button
                                type="button"
                                disabled={!!je.reversal_entry}
                                onClick={() => openReverseModal(je)}
                                title={
                                  je.reversal_entry
                                    ? `تم إنشاء قيد عكسي مسبقاً (${je.reversal_entry.entry_number})`
                                    : 'إنشاء قيد عكسي'
                                }
                                className="rounded p-1.5 text-amber-700 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                              >
                                <RotateCcw className="h-4 w-4" />
                              </button>
                            ) : null}
                            {isAdmin ? (
                              <button
                                type="button"
                                onClick={() => openDeleteModal(je)}
                                title="حذف القيد"
                                className="rounded p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-600">
              <span>
                إجمالي القيود: <span className="font-mono font-semibold">{total}</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
                >
                  السابق
                </button>
                <span className="font-mono">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded border border-slate-300 px-3 py-1 disabled:opacity-40"
                >
                  التالي
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Create / Edit Journal Modal */}
      <ModalShell
        open={formOpen}
        title={editingId ? 'تعديل قيد يومية (مسودة)' : 'إنشاء قيد يومية جديد'}
        onClose={() => setFormOpen(false)}
        maxWidth="max-w-5xl"
      >
        <form onSubmit={handleSave} className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">تاريخ القيد</label>
              <input
                type="date"
                required
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-emerald-700 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                مركز التكلفة {headerCostCenterRequired ? '(إلزامي)*' : '(اختياري)'}
              </label>
              <select
                required={headerCostCenterRequired}
                value={headerCostCenterId}
                onChange={(e) => setHeaderCostCenterId(e.target.value)}
                className={`w-full rounded-lg border bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none ${
                  headerCostCenterRequired && !headerCostCenterId
                    ? 'border-amber-500'
                    : 'border-slate-300'
                }`}
              >
                <option value="">
                  {headerCostCenterRequired ? 'اختر مركز التكلفة (إلزامي)*' : 'بدون مركز تكلفة'}
                </option>
                {activeCostCenters.map((cc) => (
                  <option key={cc.id} value={cc.id}>
                    {cc.code} — {cc.name_ar}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">الرقم المرجعي (اختياري)</label>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">البيان العام للقيد</label>
              <input
                type="text"
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="شرح القيد المحاسبي..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-3 py-2.5">الحساب</th>
                  <th className="px-3 py-2.5 w-32">مدين</th>
                  <th className="px-3 py-2.5 w-32">دائن</th>
                  <th className="px-3 py-2.5">ملاحظة السطر</th>
                  <th className="px-3 py-2.5 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {lines.map((line, idx) => (
                  <tr key={idx}>
                    <td className="p-2">
                      <select
                        required
                        value={line.account_id}
                        onChange={(e) => updateLine(idx, { account_id: e.target.value })}
                        className="w-full min-w-[220px] rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
                      >
                        <option value="">اختر الحساب...</option>
                        {postableAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.code} — {acc.name_ar}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        dir="ltr"
                        value={line.debit}
                        onChange={(e) => updateLine(idx, { debit: e.target.value })}
                        placeholder="0.00"
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-left font-mono text-xs tabular-nums"
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        dir="ltr"
                        value={line.credit}
                        onChange={(e) => updateLine(idx, { credit: e.target.value })}
                        placeholder="0.00"
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-left font-mono text-xs tabular-nums"
                      />
                    </td>
                    <td className="p-2">
                      <input
                        type="text"
                        value={line.description}
                        onChange={(e) => updateLine(idx, { description: e.target.value })}
                        placeholder="بيان السطر..."
                        className="w-full rounded border border-slate-300 px-2.5 py-1.5 text-xs"
                      />
                    </td>
                    <td className="p-2 text-center">
                      {lines.length > 2 ? (
                        <button
                          type="button"
                          onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-700"
                          aria-label="حذف السطر"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-200 bg-slate-50 text-xs font-bold">
                <tr>
                  <td colSpan={1} className="px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => setLines((prev) => [...prev, emptyLine()])}
                      className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>إضافة سطر</span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-slate-900 tabular-nums">
                    {formatMoney(totals.debit)}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-slate-900 tabular-nums">
                    {formatMoney(totals.credit)}
                  </td>
                  <td colSpan={2} className="px-3 py-2.5">
                    {totals.balanced ? (
                      <span className="text-emerald-700">القيد متوازن</span>
                    ) : (
                      <span className="text-red-700">
                        الفرق: <span className="font-mono">{formatMoney(totals.diff)}</span>
                      </span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving || !totals.balanced}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {saving ? 'جاري الحفظ...' : editingId ? 'تحديث المسودة' : 'حفظ كمسودة'}
            </button>
          </div>
        </form>
      </ModalShell>

      {/* Details Modal */}
      <ModalShell
        open={!!detailEntry}
        title={`تفاصيل القيد رقم ${detailEntry?.entry_number || ''}`}
        onClose={() => setDetailEntry(null)}
        maxWidth="max-w-4xl"
      >
        {detailEntry ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-5">
              <div>
                <div className="text-xs text-slate-500">التاريخ</div>
                <div className="mt-1 font-mono font-semibold">{formatDate(detailEntry.entry_date)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">الفترة المحاسبية</div>
                <div className="mt-1 font-semibold">{detailEntry.period?.name_ar || '-'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">مركز التكلفة</div>
                <div className="mt-1 font-semibold">
                  {detailEntry.cost_center
                    ? `${detailEntry.cost_center.code} — ${detailEntry.cost_center.name_ar}`
                    : '-'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">المصدر</div>
                <div className="mt-1 font-semibold">{JOURNAL_SOURCE_LABELS[detailEntry.source_type]}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">الحالة</div>
                <div className="mt-1">
                  <StatusText
                    variant={detailEntry.status === 'POSTED' ? 'posted' : 'draft'}
                    label={JOURNAL_STATUS_LABELS[detailEntry.status]}
                  />
                </div>
              </div>
              <div className="col-span-2 sm:col-span-5">
                <div className="text-xs text-slate-500">البيان</div>
                <div className="mt-1 text-slate-900">{detailEntry.description}</div>
              </div>
              {detailEntry.source_voucher ? (
                <div className="col-span-2 sm:col-span-5 border-t border-slate-200 pt-3 text-xs text-emerald-800">
                  هذا القيد ناتج عن{' '}
                  {detailEntry.source_voucher.voucher_type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'} رقم{' '}
                  <span className="font-mono font-semibold">{detailEntry.source_voucher.voucher_number}</span>{' '}
                  (الطرف: {detailEntry.source_voucher.party_name})
                </div>
              ) : null}
              {detailEntry.reversed_entry ? (
                <div className="col-span-2 sm:col-span-5 border-t border-slate-200 pt-3 text-xs text-amber-800">
                  هذا القيد عبارة عن قيد عكسي للقيد الأصلي رقم{' '}
                  <span className="font-mono font-semibold">{detailEntry.reversed_entry.entry_number}</span>{' '}
                  بتاريخ <span className="font-mono">{formatDate(detailEntry.reversed_entry.entry_date)}</span>
                </div>
              ) : null}
              {detailEntry.reversal_entry ? (
                <div className="col-span-2 sm:col-span-5 border-t border-slate-200 pt-3 text-xs text-slate-700">
                  تم عكس هذا القيد بواسطة القيد العكسي رقم{' '}
                  <span className="font-mono font-semibold">{detailEntry.reversal_entry.entry_number}</span>{' '}
                  ({JOURNAL_STATUS_LABELS[detailEntry.reversal_entry.status]}) بتاريخ{' '}
                  <span className="font-mono">{formatDate(detailEntry.reversal_entry.entry_date)}</span>
                </div>
              ) : null}
              {detailEntry.import_batch ? (
                <div className="col-span-2 sm:col-span-5 border-t border-slate-200 pt-3 text-xs text-slate-700">
                  تم استيراد هذا القيد ضمن دفعة Excel رقم{' '}
                  <span className="font-mono font-bold text-slate-900">
                    {detailEntry.import_batch.batch_number}
                  </span>{' '}
                  (الملف: {detailEntry.import_batch.file_name})
                </div>
              ) : null}
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">الحساب</th>
                    <th className="px-3 py-2.5">مركز التكلفة</th>
                    <th className="px-3 py-2.5">البيان</th>
                    <th className="px-3 py-2.5">مدين</th>
                    <th className="px-3 py-2.5">دائن</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {(detailEntry.lines || []).map((line) => (
                    <tr key={line.id}>
                      <td className="px-3 py-2.5">
                        <span className="font-mono text-xs text-slate-500">{line.account?.code}</span>{' '}
                        <span className="font-medium text-slate-900">{line.account?.name_ar}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">
                        {line.cost_center ? `${line.cost_center.code} - ${line.cost_center.name_ar}` : '-'}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">{line.description || '-'}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(line.debit)}</td>
                      <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(line.credit)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-slate-200 bg-slate-50 font-bold">
                  <tr>
                    <td colSpan={3} className="px-3 py-2.5 text-xs">الإجمالي</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(detailEntry.total_debit)}</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(detailEntry.total_credit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : null}
      </ModalShell>

      {/* Reverse Entry Confirmation Modal (Admin only) */}
      <ModalShell
        open={!!reverseTarget}
        title={`إنشاء قيد عكسي للقيد رقم ${reverseTarget?.entry_number || ''}`}
        onClose={() => setReverseTarget(null)}
        maxWidth="max-w-4xl"
      >
        {reverseTarget ? (
          <form onSubmit={handleReverseConfirm} className="space-y-4">
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-amber-200 bg-amber-50/70 p-4 text-sm sm:grid-cols-4">
              <div>
                <div className="text-xs text-slate-500">القيد الأصلي</div>
                <div className="mt-1 font-mono font-semibold text-slate-900">{reverseTarget.entry_number}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">تاريخ القيد الأصلي</div>
                <div className="mt-1 font-mono font-semibold text-slate-900">
                  {formatDate(reverseTarget.entry_date)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">مركز التكلفة</div>
                <div className="mt-1 font-semibold text-slate-900">
                  {reverseTarget.cost_center
                    ? `${reverseTarget.cost_center.code} — ${reverseTarget.cost_center.name_ar}`
                    : '-'}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">إجمالي القيد</div>
                <div className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                  {formatMoney(reverseTarget.total_debit)}
                </div>
              </div>
              <div className="col-span-2 sm:col-span-4">
                <div className="text-xs text-slate-500">البيان الأصلي</div>
                <div className="mt-1 text-slate-800">{reverseTarget.description}</div>
              </div>
            </div>

            <div className="max-w-xs">
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                تاريخ القيد العكسي
              </label>
              <input
                type="date"
                required
                value={reverseDate}
                onChange={(e) => setReverseDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-emerald-700 focus:outline-none"
              />
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-3 py-2.5">الحساب</th>
                    <th className="px-3 py-2.5">مركز التكلفة</th>
                    <th className="px-3 py-2.5">مدين (عكسي)</th>
                    <th className="px-3 py-2.5">دائن (عكسي)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {(reverseTarget.lines || []).map((line, idx) => (
                    <tr key={line.id || idx}>
                      <td className="px-3 py-2.5">
                        <span className="font-mono text-xs text-slate-500">{line.account?.code}</span>{' '}
                        <span className="font-medium text-slate-900">{line.account?.name_ar}</span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">
                        {reverseTarget.cost_center
                          ? `${reverseTarget.cost_center.code} — ${reverseTarget.cost_center.name_ar}`
                          : '-'}
                      </td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-slate-900">
                        {formatMoney(line.credit)}
                      </td>
                      <td className="px-3 py-2.5 font-mono tabular-nums text-slate-900">
                        {formatMoney(line.debit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-slate-200 bg-slate-50 font-bold">
                  <tr>
                    <td colSpan={2} className="px-3 py-2.5 text-xs">الإجمالي المتوازن</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(reverseTarget.total_credit)}</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">{formatMoney(reverseTarget.total_debit)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="text-xs text-slate-600">
              سيتم إنشاء القيد العكسي كمسودة جديدة مرتبطة بالقيد الأصلي لاتباع مسار الاعتماد والترحيل المعتاد.
            </p>

            <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                type="button"
                onClick={() => setReverseTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {saving ? 'جاري الإنشاء...' : 'تأكيد إنشاء القيد العكسي'}
              </button>
            </div>
          </form>
        ) : null}
      </ModalShell>

      <ConfirmModal
        open={!!postTarget}
        title="تأكيد ترحيل القيد المحاسبي"
        message={`هل تريد ترحيل القيد رقم "${postTarget?.entry_number}"؟ بعد الترحيل يصبح القيد نهائياً ولا يمكن تعديله أو حذفه مباشرة.`}
        confirmLabel="ترحيل القيد نهائياً"
        loading={saving}
        onConfirm={handlePost}
        onCancel={() => setPostTarget(null)}
      />

      {/* Admin Journal Delete Confirmation Modal (handles both regular and voucher-linked entries) */}
      <ModalShell
        open={!!deleteTarget}
        title="تأكيد حذف القيد المحاسبي"
        onClose={() => {
          if (!saving) setDeleteTarget(null);
        }}
        maxWidth="max-w-lg"
      >
        {deleteTarget ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-xs text-slate-500">رقم القيد</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900">
                    {deleteTarget.entry_number}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">التاريخ</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900">
                    {formatDate(deleteTarget.entry_date)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">المبلغ</div>
                  <div className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                    {formatMoney(deleteTarget.total_debit)}
                  </div>
                </div>
              </div>
              {deleteTarget.source_voucher ? (
                <div className="mt-3 border-t border-slate-200 pt-3">
                  <div className="text-xs font-semibold text-amber-800">
                    تنبيه: هذا القيد ناتج عن{' '}
                    {deleteTarget.source_voucher.voucher_type === 'RECEIPT'
                      ? 'سند قبض'
                      : 'سند صرف'}{' '}
                    مرتبط
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-700">
                    <span>
                      رقم السند:{' '}
                      <span className="font-mono font-bold text-slate-900">
                        {deleteTarget.source_voucher.voucher_number}
                      </span>
                    </span>
                    <span>الطرف: {deleteTarget.source_voucher.party_name}</span>
                  </div>
                </div>
              ) : null}
            </div>

            {deleteTarget.source_voucher || deleteTarget.source_type !== 'MANUAL' ? (
              <div className="space-y-2.5">
                <div className="text-xs font-semibold text-slate-700">
                  اختر طريقة التعامل مع السند المرتبط بهذا القيد:
                </div>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
                  <input
                    type="radio"
                    name="voucher_delete_action"
                    checked={deleteVoucherAction === 'KEEP_DRAFT'}
                    onChange={() => setDeleteVoucherAction('KEEP_DRAFT')}
                    className="mt-0.5 h-4 w-4 text-emerald-700"
                  />
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      الاحتفاظ بالسند دون القيد (تغيير حالته إلى غير مُرحّل)
                    </div>
                    <div className="mt-0.5 text-xs text-slate-600">
                      يتم حذف القيد المحاسبي وفك ارتباطه بالسند، وتعود حالة السند إلى «مسودة» لتعديله أو إعادة ترحيله لاحقاً.
                    </div>
                  </div>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-red-200 bg-red-50/40 p-3 hover:bg-red-50/70">
                  <input
                    type="radio"
                    name="voucher_delete_action"
                    checked={deleteVoucherAction === 'DELETE_VOUCHER'}
                    onChange={() => setDeleteVoucherAction('DELETE_VOUCHER')}
                    className="mt-0.5 h-4 w-4 text-red-700"
                  />
                  <div>
                    <div className="text-sm font-semibold text-red-900">
                      حذف السند الأصلي مع القيد نهائياً
                    </div>
                    <div className="mt-0.5 text-xs text-red-700">
                      يتم حذف القيد المحاسبي وحذف السند المرتبط به ({deleteTarget.source_voucher?.voucher_number || ''}) بشكل كامل من النظام.
                    </div>
                  </div>
                </label>
              </div>
            ) : (
              <p className="text-sm text-slate-700">
                هل أنت متأكد من حذف القيد رقم{' '}
                <span className="font-mono font-semibold">{deleteTarget.entry_number}</span> نهائياً؟
                {deleteTarget.status === 'POSTED'
                  ? ' سيتم حذف القيد وبنوده وتحديث أرصدة الحسابات والتقارير المالية تلقائياً.'
                  : ''}
              </p>
            )}

            <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button
                type="button"
                disabled={saving}
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleDelete}
                className="rounded-lg bg-red-700 px-5 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50"
              >
                {saving ? 'جاري الحذف...' : 'تأكيد الحذف'}
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>

      <JournalImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImported={loadJournals}
        onNotify={onNotify}
      />

      <BulkJournalPostModal
        open={bulkModalOpen}
        mode={bulkMode}
        selectedIds={selectedIds}
        filters={{
          search: search.trim(),
          startDate,
          endDate,
        }}
        preview={bulkPreview}
        onClose={() => setBulkModalOpen(false)}
        onCompleted={async () => {
          setSelectedIds([]);
          await loadJournals();
        }}
        onNotify={onNotify}
      />

      <BulkPostAuditLogsModal
        open={bulkAuditOpen}
        onClose={() => setBulkAuditOpen(false)}
        onNotify={onNotify}
      />
    </div>
  );
}
