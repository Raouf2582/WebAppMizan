import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit2, Layers, Plus, Search, Trash2 } from 'lucide-react';
import { ConfirmModal, EmptyState, ModalShell, StatusText } from '../components/ui.tsx';
import { apiRequest } from '../lib/api.ts';
import { ENTITY_STATUS_LABELS } from '../lib/format.ts';
import type { CostCenter, EntityStatus, UserProfile } from '../shared/types.ts';

interface CostCenterNode extends CostCenter {
  children: CostCenterNode[];
}

export function CostCentersView({
  profile,
  onNotify,
}: {
  profile: UserProfile;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const isAdmin = profile.role === 'ADMIN';
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'ALL'>('ALL');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CostCenter | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CostCenter | null>(null);
  const [saving, setSaving] = useState(false);

  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  const [status, setStatus] = useState<EntityStatus>('ACTIVE');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ costCenters?: CostCenter[] }>('/api/cost-centers');
      setCostCenters(Array.isArray(res.costCenters) ? res.costCenters : []);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل مراكز التكلفة.');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const tree = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map(costCenters.map((c) => [c.id, c]));
    const visible = new Set<string>();

    for (const cc of costCenters) {
      const matchSearch =
        !q ||
        cc.code.toLowerCase().includes(q) ||
        cc.name_ar.toLowerCase().includes(q) ||
        (cc.description || '').toLowerCase().includes(q);
      const matchStatus = statusFilter === 'ALL' || cc.status === statusFilter;
      if (matchSearch && matchStatus) {
        visible.add(cc.id);
        let curr = cc.parent_id ? map.get(cc.parent_id) : undefined;
        while (curr) {
          visible.add(curr.id);
          curr = curr.parent_id ? map.get(curr.parent_id) : undefined;
        }
      }
    }

    const nodeMap = new Map<string, CostCenterNode>();
    for (const cc of costCenters) {
      if (visible.has(cc.id)) nodeMap.set(cc.id, { ...cc, children: [] });
    }
    const roots: CostCenterNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parent_id && nodeMap.has(node.parent_id)) {
        nodeMap.get(node.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    const sortNodes = (arr: CostCenterNode[]) => {
      arr.sort((a, b) => a.code.localeCompare(b.code));
      arr.forEach((n) => sortNodes(n.children));
    };
    sortNodes(roots);
    return roots;
  }, [costCenters, search, statusFilter]);

  function openAdd(defaultParent = '') {
    setEditing(null);
    setCode('');
    setNameAr('');
    setDescription('');
    setParentId(defaultParent);
    setStatus('ACTIVE');
    setModalOpen(true);
  }

  function openEdit(cc: CostCenter) {
    setEditing(cc);
    setCode(cc.code);
    setNameAr(cc.name_ar);
    setDescription(cc.description || '');
    setParentId(cc.parent_id || '');
    setStatus(cc.status);
    setModalOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        code,
        name_ar: nameAr,
        description: description || null,
        parent_id: parentId || null,
        status,
      };
      if (editing) {
        await apiRequest(`/api/cost-centers/${editing.id}`, { method: 'PATCH', body });
        onNotify('success', 'تم تحديث مركز التكلفة بنجاح.');
      } else {
        await apiRequest('/api/cost-centers', { method: 'POST', body });
        onNotify('success', 'تم إنشاء مركز التكلفة بنجاح.');
      }
      setModalOpen(false);
      await loadData();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حفظ مركز التكلفة.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await apiRequest(`/api/cost-centers/${deleteTarget.id}`, { method: 'DELETE' });
      onNotify('success', 'تم حذف مركز التكلفة.');
      setDeleteTarget(null);
      await loadData();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حذف مركز التكلفة.');
    } finally {
      setSaving(false);
    }
  }

  function renderNode(node: CostCenterNode, depth = 0): React.ReactNode {
    return (
      <React.Fragment key={node.id}>
        <tr className="border-b border-slate-200 hover:bg-slate-50">
          <td className="px-4 py-3">
            <div className="flex items-center gap-2" style={{ paddingRight: `${depth * 22}px` }}>
              <span className="font-mono text-xs font-semibold text-slate-700">{node.code}</span>
              <span className="font-semibold text-slate-900">{node.name_ar}</span>
            </div>
          </td>
          <td className="px-4 py-3 text-sm text-slate-600">{node.description || '-'}</td>
          <td className="px-4 py-3">
            <StatusText
              variant={node.status === 'ACTIVE' ? 'active' : 'inactive'}
              label={ENTITY_STATUS_LABELS[node.status]}
            />
          </td>
          {isAdmin ? (
            <td className="px-4 py-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openAdd(node.id)}
                  className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                >
                  + فرعي
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(node)}
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
        {node.children.map((child) => renderNode(child, depth + 1))}
      </React.Fragment>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث في مراكز التكلفة..."
              className="w-60 rounded-lg border border-slate-300 py-2 pr-9 pl-3 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as EntityStatus | 'ALL')}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-700 focus:outline-none"
          >
            <option value="ALL">كل الحالات</option>
            <option value="ACTIVE">نشط</option>
            <option value="INACTIVE">غير نشط</option>
          </select>
        </div>

        {isAdmin ? (
          <button
            type="button"
            onClick={() => openAdd('')}
            className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            <Plus className="h-4 w-4" />
            <span>إضافة مركز تكلفة</span>
          </button>
        ) : null}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">جاري تحميل مراكز التكلفة...</div>
        ) : tree.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Layers}
              title="لا توجد مراكز تكلفة"
              description="أضف مراكز التكلفة (الأقسام، الفروع، المشاريع) لتتبع ربحية كل مركز عبر نفس شجرة الحسابات الموحدة."
              action={
                isAdmin ? (
                  <button
                    type="button"
                    onClick={() => openAdd('')}
                    className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                  >
                    إضافة مركز تكلفة
                  </button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-3">مركز التكلفة (الرمز / الاسم)</th>
                  <th className="px-4 py-3">الوصف</th>
                  <th className="px-4 py-3">الحالة</th>
                  {isAdmin ? <th className="px-4 py-3">إجراءات</th> : null}
                </tr>
              </thead>
              <tbody>{tree.map((n) => renderNode(n, 0))}</tbody>
            </table>
          </div>
        )}
      </div>

      <ModalShell
        open={modalOpen}
        title={editing ? 'تعديل مركز التكلفة' : 'إضافة مركز تكلفة'}
        onClose={() => setModalOpen(false)}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">الرمز</label>
              <input
                type="text"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="مثال: CC-01"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm focus:border-emerald-700 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">المركز الأب (اختياري)</label>
              <select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
              >
                <option value="">بدون مركز أب</option>
                {costCenters
                  .filter((c) => c.id !== editing?.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name_ar}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">اسم مركز التكلفة</label>
            <input
              type="text"
              required
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">الوصف (اختياري)</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">الحالة</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as EntityStatus)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            >
              <option value="ACTIVE">نشط</option>
              <option value="INACTIVE">غير نشط</option>
            </select>
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
              {saving ? 'جاري الحفظ...' : 'حفظ'}
            </button>
          </div>
        </form>
      </ModalShell>

      <ConfirmModal
        open={!!deleteTarget}
        title="تأكيد حذف مركز التكلفة"
        message={`هل تريد حذف مركز التكلفة "${deleteTarget?.name_ar}"؟`}
        confirmLabel="حذف"
        danger
        loading={saving}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
