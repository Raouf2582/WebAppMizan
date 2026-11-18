import React, { useState } from 'react';
import { Database, KeyRound, ShieldCheck } from 'lucide-react';
import { apiRequest, setStoredToken } from '../lib/api.ts';

export function ConfigurationGate({
  schemaError,
  onRetry,
}: {
  schemaError?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-2xl rounded-lg border border-slate-200 bg-white p-8">
        <div className="mb-6 flex items-center gap-3 border-b border-slate-200 pb-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">ميزان — النظام المحاسبي المتكامل</h1>
            <p className="text-sm text-slate-500">التحقق من جاهزية قاعدة بيانات PostgreSQL</p>
          </div>
        </div>

        <div className="space-y-4 text-sm leading-relaxed text-slate-700">
          <p className="font-semibold text-slate-900">
            تعذر العثور على جداول النظام المحاسبي في قاعدة البيانات المتصلة عبر Transaction Pooler.
          </p>
          <p>
            يرجى تنفيذ ملف <span className="font-mono text-xs">supabase/schema.sql</span> في قاعدة
            بيانات Supabase ثم إعادة التحقق.
          </p>
          {schemaError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 font-mono text-xs text-red-800" dir="ltr">
              {schemaError}
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end border-t border-slate-200 pt-5">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            إعادة التحقق من الاتصال
          </button>
        </div>
      </div>
    </div>
  );
}

export function FirstTimeSetupView({ onCompleted }: { onCompleted: () => void }) {
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 2 || /\s/.test(trimmedUsername)) {
      setError('اسم المستخدم يجب أن يكون حرفين على الأقل وبدون مسافات.');
      return;
    }

    if (password.length < 6) {
      setError('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
      return;
    }

    if (password !== confirmPassword) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiRequest<{ token: string }>('/api/auth/setup', {
        method: 'POST',
        auth: false,
        body: { full_name: fullName, username: trimmedUsername, password },
      });
      setStoredToken(res.token);
      onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'حدث خطأ أثناء تهيئة مدير النظام.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-8">
        <div className="mb-6 flex items-center gap-3 border-b border-slate-200 pb-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">الإعداد الأولي للنظام المحاسبي</h1>
            <p className="text-sm text-slate-500">إنشاء حساب مدير النظام الأول (ADMIN)</p>
          </div>
        </div>

        <p className="mb-5 text-sm leading-relaxed text-slate-600">
          قاعدة البيانات فارغة تماماً. قم بإنشاء حساب مدير النظام الأول؛ وبعد إتمام هذه الخطوة سيتم إغلاق
          صفحة الإعداد الأولي تلقائياً ولن يُسمح بالتسجيل العام.
        </p>

        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">الاسم الكامل</label>
            <input
              type="text"
              required
              minLength={2}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="مثال: أحمد محمد"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">اسم المستخدم</label>
            <input
              type="text"
              required
              minLength={2}
              autoComplete="username"
              dir="ltr"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-left text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">كلمة المرور (6 أحرف على الأقل)</label>
            <input
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-left text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">تأكيد كلمة المرور</label>
            <input
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              dir="ltr"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-left text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {submitting ? 'جاري إنشاء الحساب...' : 'إنشاء حساب المدير والبدء'}
          </button>
        </form>
      </div>
    </div>
  );
}

export function LoginView({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const res = await apiRequest<{ token: string }>('/api/auth/login', {
        method: 'POST',
        auth: false,
        body: { username: username.trim(), password },
      });
      setStoredToken(res.token);
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل الدخول.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8">
        <div className="mb-6 flex items-center gap-3 border-b border-slate-200 pb-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">ميزان — النظام المحاسبي</h1>
            <p className="text-sm text-slate-500">تسجيل الدخول إلى النظام المالي</p>
          </div>
        </div>

        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">اسم المستخدم</label>
            <input
              type="text"
              required
              autoComplete="username"
              dir="ltr"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="أدخل اسم المستخدم"
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-left text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">كلمة المرور</label>
            <input
              type="password"
              required
              autoComplete="current-password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-left text-sm text-slate-900 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            {submitting ? 'جاري التحقق...' : 'دخول'}
          </button>
        </form>
      </div>
    </div>
  );
}
