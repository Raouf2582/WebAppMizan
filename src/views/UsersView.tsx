import React, { useCallback, useEffect, useState } from 'react';
import { Edit2, Plus, Trash2, UserCheck, UserX, Users } from 'lucide-react';
import { ConfirmModal, EmptyState, ModalShell, StatusText } from '../components/ui.tsx';
import { apiRequest } from '../lib/api.ts';
import { formatDate, ROLE_LABELS } from '../lib/format.ts';
import type { UserProfile, UserRole } from '../shared/types.ts';

export function UsersView({
  currentProfile,
  onNotify,
}: {
  currentProfile: UserProfile;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Create form
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('USER');

  // Edit modal
  const [editTarget, setEditTarget] = useState<UserProfile | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editUsername, setEditUsername] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('USER');
  const [editIsActive, setEditIsActive] = useState(true);

  // Delete confirmation modal
  const [deleteTarget, setDeleteTarget] = useState<UserProfile | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ users: UserProfile[] }>('/api/users');
      setUsers(res.users);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحميل المستخدمين.');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  function openEditModal(user: UserProfile) {
    setEditTarget(user);
    setEditFullName(user.full_name);
    setEditUsername(user.username);
    setEditPassword('');
    setEditRole(user.role);
    setEditIsActive(user.is_active);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 2 || /\s/.test(trimmedUsername)) {
      onNotify('error', 'اسم المستخدم يجب أن يكون حرفين على الأقل وبدون مسافات.');
      return;
    }
    if (password.length < 6) {
      onNotify('error', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
      return;
    }

    setSaving(true);
    try {
      await apiRequest('/api/users', {
        method: 'POST',
        body: { full_name: fullName, username: trimmedUsername, password, role },
      });
      onNotify('success', 'تم إضافة المستخدم بنجاح.');
      setModalOpen(false);
      setFullName('');
      setUsername('');
      setPassword('');
      setRole('USER');
      await loadUsers();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر إضافة المستخدم.');
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;

    const trimmedFullName = editFullName.trim();
    const trimmedUsername = editUsername.trim();
    if (trimmedFullName.length < 2) {
      onNotify('error', 'الاسم الكامل يجب أن يكون حرفين على الأقل.');
      return;
    }
    if (trimmedUsername.length < 2 || /\s/.test(trimmedUsername)) {
      onNotify('error', 'اسم المستخدم يجب أن يكون حرفين على الأقل وبدون مسافات.');
      return;
    }
    if (editPassword.length > 0 && editPassword.length < 6) {
      onNotify('error', 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
      return;
    }

    const isSelf = editTarget.id === currentProfile.id;
    const body: Record<string, unknown> = {
      full_name: trimmedFullName,
      username: trimmedUsername,
    };
    if (editPassword.length > 0) {
      body.password = editPassword;
    }
    if (!isSelf) {
      body.role = editRole;
      body.is_active = editIsActive;
    }

    setSaving(true);
    try {
      await apiRequest(`/api/users/${editTarget.id}`, {
        method: 'PATCH',
        body,
      });
      onNotify('success', `تم تحديث بيانات المستخدم "${trimmedUsername}" بنجاح.`);
      setEditTarget(null);
      setEditPassword('');
      await loadUsers();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحديث بيانات المستخدم.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      const res = await apiRequest<{ deleted: boolean; deactivated: boolean; message?: string }>(
        `/api/users/${deleteTarget.id}`,
        { method: 'DELETE' },
      );
      onNotify(
        'success',
        res.message ||
          (res.deactivated
            ? `تم تعطيل المستخدم "${deleteTarget.username}" بأمان.`
            : `تم حذف المستخدم "${deleteTarget.username}" بنجاح.`),
      );
      setDeleteTarget(null);
      await loadUsers();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر حذف المستخدم.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRoleChange(user: UserProfile, newRole: UserRole) {
    try {
      await apiRequest(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: { role: newRole },
      });
      onNotify('success', 'تم تحديث صلاحية المستخدم.');
      await loadUsers();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحديث الصلاحية.');
    }
  }

  async function handleToggleActive(user: UserProfile) {
    try {
      await apiRequest(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: { is_active: !user.is_active },
      });
      onNotify('success', user.is_active ? 'تم تعطيل حساب المستخدم.' : 'تم تفعيل حساب المستخدم.');
      await loadUsers();
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'تعذر تحديث حالة المستخدم.');
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-600">
          إدارة حسابات المستخدمين وتحديد الصلاحيات (مدير نظام / مستخدم محاسبي).
        </p>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 whitespace-nowrap"
        >
          <Plus className="h-4 w-4" />
          <span>إضافة مستخدم</span>
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">جاري تحميل قائمة المستخدمين...</div>
        ) : users.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={Users} title="لا يوجد مستخدمون" description="أضف مستخدمين للنظام." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-3">الاسم الكامل</th>
                  <th className="px-4 py-3">اسم المستخدم</th>
                  <th className="px-4 py-3">الدور</th>
                  <th className="px-4 py-3">الحالة</th>
                  <th className="px-4 py-3">تاريخ الإنشاء</th>
                  <th className="px-4 py-3">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {users.map((u) => {
                  const isSelf = u.id === currentProfile.id;
                  return (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        {u.full_name} {isSelf ? '(أنت)' : ''}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600" dir="ltr">
                        {u.username}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          disabled={isSelf}
                          value={u.role}
                          onChange={(e) => handleRoleChange(u, e.target.value as UserRole)}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 disabled:bg-slate-100 disabled:text-slate-500"
                        >
                          <option value="ADMIN">{ROLE_LABELS.ADMIN}</option>
                          <option value="USER">{ROLE_LABELS.USER}</option>
                        </select>
                      </td>
                      <td className="px-4 py-3">
                        <StatusText
                          variant={u.is_active ? 'active' : 'inactive'}
                          label={u.is_active ? 'نشط' : 'معطل'}
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500 tabular-nums">
                        {formatDate(u.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openEditModal(u)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                            <span>تعديل</span>
                          </button>
                          {!isSelf ? (
                            <button
                              type="button"
                              onClick={() => handleToggleActive(u)}
                              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                                u.is_active
                                  ? 'border-amber-200 text-amber-800 hover:bg-amber-50'
                                  : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                              }`}
                            >
                              {u.is_active ? (
                                <>
                                  <UserX className="h-3.5 w-3.5" />
                                  <span>تعطيل</span>
                                </>
                              ) : (
                                <>
                                  <UserCheck className="h-3.5 w-3.5" />
                                  <span>تفعيل</span>
                                </>
                              )}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={isSelf}
                            title={isSelf ? 'لا يمكنك حذف حسابك الشخصي' : 'حذف المستخدم'}
                            onClick={() => setDeleteTarget(u)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>حذف</span>
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

      {/* Create User Modal */}
      <ModalShell open={modalOpen} title="إضافة مستخدم جديد" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">الاسم الكامل</label>
            <input
              type="text"
              required
              minLength={2}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">اسم المستخدم</label>
            <input
              type="text"
              required
              minLength={2}
              autoComplete="off"
              dir="ltr"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="مثال: accountant1"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-left text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">كلمة المرور (6 أحرف على الأقل)</label>
            <input
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-left text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">الصلاحية</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            >
              <option value="USER">مستخدم محاسبي (USER)</option>
              <option value="ADMIN">مدير النظام (ADMIN)</option>
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
              {saving ? 'جاري الإنشاء...' : 'إضافة المستخدم'}
            </button>
          </div>
        </form>
      </ModalShell>

      {/* Edit User Modal */}
      <ModalShell
        open={!!editTarget}
        title={`تعديل بيانات المستخدم — ${editTarget?.username || ''}`}
        onClose={() => setEditTarget(null)}
      >
        <form onSubmit={handleEditSave} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">الاسم الكامل</label>
            <input
              type="text"
              required
              minLength={2}
              value={editFullName}
              onChange={(e) => setEditFullName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">اسم المستخدم</label>
            <input
              type="text"
              required
              minLength={2}
              autoComplete="off"
              dir="ltr"
              value={editUsername}
              onChange={(e) => setEditUsername(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-left text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              كلمة المرور الجديدة (اختياري — اتركها فارغة للإبقاء على الحالية)
            </label>
            <input
              type="password"
              minLength={editPassword.length > 0 ? 6 : undefined}
              autoComplete="new-password"
              dir="ltr"
              value={editPassword}
              onChange={(e) => setEditPassword(e.target.value)}
              placeholder="6 أحرف على الأقل عند التغيير"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-left text-sm focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">الصلاحية</label>
              <select
                disabled={editTarget?.id === currentProfile.id}
                value={editRole}
                onChange={(e) => setEditRole(e.target.value as UserRole)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
              >
                <option value="USER">مستخدم محاسبي (USER)</option>
                <option value="ADMIN">مدير النظام (ADMIN)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">حالة الحساب</label>
              <select
                disabled={editTarget?.id === currentProfile.id}
                value={editIsActive ? 'ACTIVE' : 'INACTIVE'}
                onChange={(e) => setEditIsActive(e.target.value === 'ACTIVE')}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-emerald-700 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
              >
                <option value="ACTIVE">نشط</option>
                <option value="INACTIVE">معطل</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => setEditTarget(null)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {saving ? 'جاري الحفظ...' : 'حفظ التعديلات'}
            </button>
          </div>
        </form>
      </ModalShell>

      {/* Delete User Confirmation Modal */}
      <ConfirmModal
        open={!!deleteTarget}
        title="تأكيد حذف المستخدم"
        message={`هل أنت متأكد من حذف المستخدم "${deleteTarget?.full_name || ''}" (اسم المستخدم: ${deleteTarget?.username || ''})؟ في حال ارتباط المستخدم بسجلات محاسبية قائمة سيتم تعطيل حسابه بأمان للحفاظ على سلامة البيانات المالية.`}
        confirmLabel="حذف المستخدم"
        danger
        loading={saving}
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
