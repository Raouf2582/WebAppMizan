import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  Edit2,
  FolderTree,
  History,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { AccountImportHistoryModal } from '../components/AccountImportHistoryModal.tsx';
import { AccountImportModal } from '../components/AccountImportModal.tsx';
import {
  ConfirmModal,
  EmptyState,
  ModalShell,
  StatusText,
} from '../components/ui.tsx';
import { apiRequest } from '../lib/api.ts';
import {
  ACCOUNT_TYPE_LABELS,
  ENTITY_STATUS_LABELS,
  NORMAL_BALANCE_LABELS,
} from '../lib/format.ts';
import type {
  Account,
  AccountType,
  EntityStatus,
  NormalBalance,
  UserProfile,
} from '../shared/types.ts';

interface AccountNode extends Account {
  children: AccountNode[];
}

const DEFAULT_NORMAL_BALANCE: Record<AccountType, NormalBalance> = {
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  REVENUE: 'CREDIT',
};

export function AccountsView({
  profile,
  onNotify,
}: {
  profile: UserProfile;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const isAdmin = profile.role === 'ADMIN';
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<AccountType | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'ALL'>('ALL');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [accountType, setAccountType] = useState<AccountType>('ASSET');
  const [normalBalance, setNormalBalance] = useState<NormalBalance>('DEBIT');
  const [parentId, setParentId] = useState<string>('');
  const [isPostable, setIsPostable] = useState(true);
  const [status, setStatus] = useState<EntityStatus>('ACTIVE');
  const [costCenterRequired, setCostCenterRequired] = useState(false);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ accounts?: Account[] }>('/api/accounts');
      const list = Array.isArray(res.accounts) ? res.accounts : [];
      setAccounts(list);
      setExpandedIds(new Set(list.filter((a) => !a.is_postable).map((a) => a.id)));
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل شجرة الحسابات.');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const groupAccounts = useMemo(
    () => accounts.filter((a) => !a.is_postable && a.id !== editingAccount?.id),
    [accounts, editingAccount],
  );

  const filteredIds = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = new Set<string>();
    const map = new Map(accounts.map((a) => [a.id, a]));

    for (const acc of accounts) {
      const matchSearch =
        !q || acc.code.toLowerCase().includes(q) || acc.name_ar.toLowerCase().includes(q);
      const matchType = typeFilter === 'ALL' || acc.account_type === typeFilter;
      const matchStatus = statusFilter === 'ALL' || acc.status === statusFilter;

      if (matchSearch && matchType && matchStatus) {
        matches.add(acc.id);
        let curr = acc.parent_id ? map.get(acc.parent_id) : undefined;
        while (curr) {
          matches.add(curr.id);
          curr = curr.parent_id ? map.get(curr.parent_id) : undefined;
        }
      }
    }
    return matches;
  }, [accounts, search, typeFilter, statusFilter]);

  const tree = useMemo(() => {
    const map = new Map<string, AccountNode>();
    for (const acc of accounts) {
      if (filteredIds.has(acc.id)) {
        map.set(acc.id, { ...acc, children: [] });
      }
    }
    const roots: AccountNode[] = [];
    for (const node of map.values()) {
      if (node.parent_id && map.has(node.parent_id)) {
        map.get(node.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const sortNodes = (nodes: AccountNode[]) => {
      nodes.sort((a, b) => a.code.localeCompare(b.code));
      nodes.forEach((n) => sortNodes(n.children));
    };
    sortNodes(roots);
    return roots;
  }, [accounts, filteredIds]);

  function openAddModal(defaultParentId = '') {
    setEditingAccount(null);
    setCode('');
    setNameAr('');
    const parentAcc = accounts.find((a) => a.id === defaultParentId);
    const nextType = parentAcc ? parentAcc.account_type : 'ASSET';
    setAccountType(nextType);
    setNormalBalance(DEFAULT_NORMAL_BALANCE[nextType]);
    setParentId(defaultParentId);
    setIsPostable(true);
    setStatus('ACTIVE');
    setCostCenterRequired(false);
    setModalOpen(true);
  }

  function openEditModal(acc: Account) {
    setEditingAccount(acc);
    setCode(acc.code);
    setNameAr(acc.name_ar);
    setAccountType(acc.account_type);
    setNormalBalance(acc.normal_balance);
    setParentId(acc.parent_id || '');
    setIsPostable(acc.is_postable);
    setStatus(acc.status);
    setCostCenterRequired(acc.cost_center_required);
    setModalOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        code,
        name_ar: nameAr,
        account_type: accountType,
        normal_balance: normalBalance,
        parent_id: parentId || null,
        is_postable: isPostable,
        status,
        cost_center_required: isPostable ? costCenterRequired : false,
      };

      if (editingAccount) {
        await apiRequest(`/api/accounts/${editingAccount.id}`, {
          method: 'PATCH',
          body: payload,
        });
        onNotify('success', 'تم تحديث بيانات الحساب بنجاح.');
      } else {
        await apiRequest('/api/accounts', {
          method: 'POST',
          body: payload,
        });
        onNotify('success', 'تم إضافة الحساب إلى شجرة الحسابات بنجاح.');
      }

      setModalOpen(false);
      await loadAccounts();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حفظ الحساب.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await apiRequest(`/api/accounts/${deleteTarget.id}`, { method: 'DELETE' });
      onNotify('success', 'تم حذف الحساب بنجاح.');
      if (selectedAccount?.id === deleteTarget.id) setSelectedAccount(null);
      setDeleteTarget(null);
      await loadAccounts();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حذف الحساب.');
    } finally {
      setSaving(false);
    }
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderNode(node: AccountNode, depth = 0): React.ReactNode {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedIds.has(node.id);
    const isSelected = selectedAccount?.id === node.id;

    return (
      <React.Fragment key={node.id}>
        <tr
          onClick={() => setSelectedAccount(node)}
          className={`cursor-pointer border-b border-slate-200 transition-colors ${
            isSelected ? 'bg-emerald-50/70' : 'hover:bg-slate-50'
          }`}
        >
          <td className="px-4 py-2.5">
            <div className="flex items-center gap-2" style={{ paddingRight: `${depth * 22}px` }}>
              {hasChildren || !node.is_postable ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(node.id);
                  }}
                  aria-label={isExpanded ? 'طي' : 'توسيع'}
                  className="rounded p-0.5 text-slate-500 hover:bg-slate-200"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronLeft className="h-4 w-4" />
                  )}
                </button>
              ) : (
                <span className="inline-block w-5" />
              )}
              <span className="font-mono text-xs font-semibold text-slate-700">{node.code}</span>
              <span className={!node.is_postable ? 'font-bold text-slate-900' : 'text-slate-800'}>
                {node.name_ar}
              </span>
            </div>
          </td>
          <td className="px-4 py-2.5 text-xs text-slate-600">
            {ACCOUNT_TYPE_LABELS[node.account_type]}
          </td>
          <td className="px-4 py-2.5 text-xs text-slate-600">
            {NORMAL_BALANCE_LABELS[node.normal_balance]}
          </td>
          <td className="px-4 py-2.5 text-xs text-slate-600">
            {node.is_postable ? 'حساب فرعي (يقبل الترحيل)' : 'حساب رئيسي (تجميعي)'}
          </td>
          <td className="px-4 py-2.5">
            <StatusText
              variant={node.status === 'ACTIVE' ? 'active' : 'inactive'}
              label={ENTITY_STATUS_LABELS[node.status]}
            />
          </td>
          {isAdmin ? (
            <td className="px-4 py-2.5">
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                {!node.is_postable ? (
                  <button
                    type="button"
                    onClick={() => openAddModal(node.id)}
                    title="إضافة حساب فرعي"
                    className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                  >
                    + فرعي
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => openEditModal(node)}
                  aria-label="تعديل"
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                >
                  <Edit2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(node)}
                  aria-label="حذف"
                  className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-700"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </td>
          ) : null}
        </tr>
        {isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
      </React.Fragment>
    );
  }

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
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بالرمز أو اسم الحساب..."
              className="w-60 rounded-lg border border-slate-300 py-2 pr-9 pl-3 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as AccountType | 'ALL')}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-700 focus:outline-none"
          >
            <option value="ALL">كل أنواع الحسابات</option>
            {Object.entries(ACCOUNT_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as EntityStatus | 'ALL')}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-700 focus:outline-none"
          >
            <option value="ALL">كل الحالات</option>
            <option value="ACTIVE">نشط</option>
            <option value="INACTIVE">غير نشط</option>
          </select>

          <button
            type="button"
            onClick={() => setExpandedIds(new Set(accounts.map((a) => a.id)))}
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            توسيع الكل
          </button>
          <button
            type="button"
            onClick={() => setExpandedIds(new Set())}
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            طي الكل
          </button>
        </div>

        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setHistoryModalOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
            >
              <History className="h-4 w-4" />
              <span>سجل الاستيراد</span>
            </button>
            <button
              type="button"
              onClick={() => setImportModalOpen(true)}
              className="flex items-center gap-2 rounded-lg border border-emerald-700 bg-white px-3.5 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 whitespace-nowrap"
            >
              <Upload className="h-4 w-4" />
              <span>استيراد</span>
            </button>
            <button
              type="button"
              onClick={() => openAddModal('')}
              className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 whitespace-nowrap"
            >
              <Plus className="h-4 w-4" />
              <span>إضافة حساب</span>
            </button>
          </div>
        ) : null}
      </div>

      {/* Tree & Details */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-lg border border-slate-200 bg-white overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-sm text-slate-500">جاري تحميل شجرة الحسابات...</div>
          ) : tree.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={FolderTree}
                title="شجرة الحسابات فارغة"
                description={
                  isAdmin
                    ? 'لم يتم إنشاء أي حسابات بعد. ابدأ بإضافة الحسابات الرئيسية والفرعية أو استيرادها من ملف Excel.'
                    : 'لم يقم مدير النظام بإضافة حسابات بعد.'
                }
                action={
                  isAdmin ? (
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => openAddModal('')}
                        className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                      >
                        إنشاء أول حساب
                      </button>
                      <button
                        type="button"
                        onClick={() => setImportModalOpen(true)}
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-700 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                      >
                        <Upload className="h-4 w-4" />
                        <span>استيراد من Excel</span>
                      </button>
                    </div>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr>
                    <th className="px-4 py-3">الحساب (الرمز / الاسم)</th>
                    <th className="px-4 py-3">النوع</th>
                    <th className="px-4 py-3">الطبيعة</th>
                    <th className="px-4 py-3">التصنيف</th>
                    <th className="px-4 py-3">الحالة</th>
                    {isAdmin ? <th className="px-4 py-3">إجراءات</th> : null}
                  </tr>
                </thead>
                <tbody>{tree.map((node) => renderNode(node, 0))}</tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5 h-fit">
          <h3 className="border-b border-slate-200 pb-3 text-sm font-bold text-slate-900">
            تفاصيل الحساب المحدد
          </h3>
          {selectedAccount ? (
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">رمز الحساب</dt>
                <dd className="font-mono font-semibold text-slate-900">{selectedAccount.code}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">اسم الحساب</dt>
                <dd className="font-semibold text-slate-900">{selectedAccount.name_ar}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">نوع الحساب</dt>
                <dd className="text-slate-800">{ACCOUNT_TYPE_LABELS[selectedAccount.account_type]}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">الرصيد الطبيعي</dt>
                <dd className="text-slate-800">{NORMAL_BALANCE_LABELS[selectedAccount.normal_balance]}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">قابل للترحيل</dt>
                <dd className="text-slate-800">{selectedAccount.is_postable ? 'نعم' : 'لا (حساب رئيسي)'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">إلزامية مركز التكلفة</dt>
                <dd className="text-slate-800">{selectedAccount.cost_center_required ? 'إلزامي' : 'اختياري'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">الحالة</dt>
                <dd>
                  <StatusText
                    variant={selectedAccount.status === 'ACTIVE' ? 'active' : 'inactive'}
                    label={ENTITY_STATUS_LABELS[selectedAccount.status]}
                  />
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-sm text-slate-500">اختر حساباً من الشجرة لعرض كامل خصائصه المحاسبية.</p>
          )}
        </div>
      </div>

      {/* Add / Edit Modal */}
      <ModalShell
        open={modalOpen}
        title={editingAccount ? 'تعديل بيانات الحساب' : 'إضافة حساب جديد'}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">رمز الحساب</label>
              <input
                type="text"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="مثال: 1101"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-emerald-700 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">الحساب الأب (اختياري)</label>
              <select
                value={parentId}
                onChange={(e) => {
                  const nextPid = e.target.value;
                  setParentId(nextPid);
                  const parent = accounts.find((a) => a.id === nextPid);
                  if (parent && !editingAccount) {
                    setAccountType(parent.account_type);
                    setNormalBalance(DEFAULT_NORMAL_BALANCE[parent.account_type]);
                  }
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
              >
                <option value="">بدون حساب أب (مستوى رئيسي)</option>
                {groupAccounts.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.code} — {g.name_ar}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">اسم الحساب بالعربية</label>
            <input
              type="text"
              required
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              placeholder="مثال: الصندوق الرئيسي"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">نوع الحساب</label>
              <select
                value={accountType}
                onChange={(e) => {
                  const t = e.target.value as AccountType;
                  setAccountType(t);
                  setNormalBalance(DEFAULT_NORMAL_BALANCE[t]);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
              >
                {Object.entries(ACCOUNT_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">الطبيعة المحاسبية</label>
              <select
                value={normalBalance}
                onChange={(e) => setNormalBalance(e.target.value as NormalBalance)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
              >
                <option value="DEBIT">مدين</option>
                <option value="CREDIT">دائن</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">حالة الحساب</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as EntityStatus)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
              >
                <option value="ACTIVE">نشط</option>
                <option value="INACTIVE">غير نشط</option>
              </select>
            </div>

            <div className="flex flex-col justify-center gap-2 pt-4">
              <label className="flex items-center gap-2 text-sm text-slate-800">
                <input
                  type="checkbox"
                  checked={isPostable}
                  onChange={(e) => setIsPostable(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-emerald-700"
                />
                <span>حساب فرعي قابل للترحيل</span>
              </label>

              {isPostable ? (
                <label className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    checked={costCenterRequired}
                    onChange={(e) => setCostCenterRequired(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-emerald-700"
                  />
                  <span>إلزامية تحديد مركز تكلفة عند القيد</span>
                </label>
              ) : null}
            </div>
          </div>

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {saving ? 'جاري الحفظ...' : 'حفظ الحساب'}
            </button>
          </div>
        </form>
      </ModalShell>

      <ConfirmModal
        open={!!deleteTarget}
        title="تأكيد حذف الحساب"
        message={`هل أنت متأكد من حذف الحساب "${deleteTarget?.code} - ${deleteTarget?.name_ar}"؟ لا يمكن الحذف إذا كان مرتبطاً بحركات مالية أو حسابات فرعية.`}
        confirmLabel="حذف الحساب"
        danger
        loading={saving}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {isAdmin ? (
        <>
          <AccountImportModal
            open={importModalOpen}
            onClose={() => setImportModalOpen(false)}
            onImported={loadAccounts}
            onNotify={onNotify}
          />
          <AccountImportHistoryModal
            open={historyModalOpen}
            onClose={() => setHistoryModalOpen(false)}
            onNotify={onNotify}
          />
        </>
      ) : null}
    </div>
  );
}
