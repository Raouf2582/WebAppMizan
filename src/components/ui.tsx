import React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Info,
  Lock,
  Unlock,
  X,
  XCircle,
} from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

export function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="no-print fixed bottom-5 left-5 z-50 flex max-w-md flex-col gap-2.5">
      {toasts.map((t) => {
        const tone =
          t.type === 'success'
            ? 'border-emerald-200 bg-white text-emerald-900'
            : t.type === 'error'
              ? 'border-red-200 bg-white text-red-900'
              : 'border-slate-200 bg-white text-slate-900';

        const Icon =
          t.type === 'success' ? CheckCircle2 : t.type === 'error' ? AlertCircle : Info;
        const iconTone =
          t.type === 'success'
            ? 'text-emerald-700'
            : t.type === 'error'
              ? 'text-red-600'
              : 'text-slate-600';

        return (
          <div
            key={t.id}
            role="status"
            className={`flex items-start gap-3 rounded-lg border px-4 py-3 shadow-md ${tone}`}
          >
            <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${iconTone}`} />
            <p className="flex-1 text-sm font-medium leading-relaxed">{t.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="إغلاق الإشعار"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function StatusText({
  variant,
  label,
}: {
  variant: 'active' | 'inactive' | 'posted' | 'draft' | 'open' | 'closed';
  label: string;
}) {
  const config: Record<
    typeof variant,
    { text: string; Icon: React.ComponentType<{ className?: string }> }
  > = {
    active: { text: 'text-emerald-700', Icon: CheckCircle2 },
    posted: { text: 'text-emerald-700', Icon: CheckCircle2 },
    open: { text: 'text-emerald-700', Icon: Unlock },
    inactive: { text: 'text-slate-500', Icon: XCircle },
    draft: { text: 'text-amber-700', Icon: Clock },
    closed: { text: 'text-red-700', Icon: Lock },
  };

  const { text, Icon } = config[variant];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap ${text}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ModalShell({
  open,
  title,
  onClose,
  children,
  maxWidth = 'max-w-xl',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  if (!open) return null;

  return (
    <div
      className="no-print fixed inset-0 z-40 flex items-center justify-center bg-slate-900/45 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`w-full ${maxWidth} max-h-[90vh] overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl`}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق النافذة"
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalShell open={open} title={title} onClose={onCancel} maxWidth="max-w-md">
      <p className="text-sm leading-relaxed text-slate-600">{message}</p>
      <div className="mt-6 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          إلغاء
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
            danger ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-700 hover:bg-emerald-800'
          }`}
        >
          {loading ? 'جاري التنفيذ...' : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
