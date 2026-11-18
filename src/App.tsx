import React, { useCallback, useEffect, useState } from 'react';
import {
  ConfigurationGate,
  FirstTimeSetupView,
  LoginView,
} from './components/AuthGates.tsx';
import { Layout, type NavSection } from './components/Layout.tsx';
import { ToastContainer, type ToastMessage } from './components/ui.tsx';
import { apiRequest, clearStoredToken, getStoredToken } from './lib/api.ts';
import type { UserProfile } from './shared/types.ts';
import { AccountsView } from './views/AccountsView.tsx';
import { CostCentersView } from './views/CostCentersView.tsx';
import { DashboardView } from './views/DashboardView.tsx';
import { JournalsView } from './views/JournalsView.tsx';
import { PeriodsView } from './views/PeriodsView.tsx';
import { ReportsView } from './views/ReportsView.tsx';
import { UsersView } from './views/UsersView.tsx';
import { VouchersView } from './views/VouchersView.tsx';

interface SystemStatus {
  configured: boolean;
  schemaReady: boolean;
  initialized: boolean;
  schemaError?: string;
}

export default function App() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [booting, setBooting] = useState(true);
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const notify = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const bootstrap = useCallback(async () => {
    setBooting(true);
    try {
      const sys = await apiRequest<SystemStatus>('/api/system/status', { auth: false });
      setStatus(sys);

      if (sys.configured && sys.schemaReady && sys.initialized && getStoredToken()) {
        try {
          const me = await apiRequest<{ profile: UserProfile }>('/api/auth/me');
          setProfile(me.profile);
        } catch {
          clearStoredToken();
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'تعذر الاتصال بالخادم.');
    } finally {
      setBooting(false);
    }
  }, [notify]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  function handleLogout() {
    clearStoredToken();
    setProfile(null);
    setActiveSection('dashboard');
  }

  if (booting || !status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-medium text-slate-600">
        جاري تهيئة النظام المحاسبي...
      </div>
    );
  }

  if (!status.configured || !status.schemaReady) {
    return (
      <>
        <ConfigurationGate schemaError={status.schemaError} onRetry={bootstrap} />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  if (!status.initialized) {
    return (
      <>
        <FirstTimeSetupView onCompleted={bootstrap} />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  if (!profile) {
    return (
      <>
        <LoginView onLoggedIn={bootstrap} />
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  const safeSection: NavSection =
    (activeSection === 'periods' || activeSection === 'users') && profile.role !== 'ADMIN'
      ? 'dashboard'
      : activeSection;

  return (
    <>
      <Layout
        profile={profile}
        activeSection={safeSection}
        onSelectSection={setActiveSection}
        onLogout={handleLogout}
      >
        {safeSection === 'dashboard' ? (
          <DashboardView onNavigate={setActiveSection} onNotify={notify} />
        ) : safeSection === 'accounts' ? (
          <AccountsView profile={profile} onNotify={notify} />
        ) : safeSection === 'cost-centers' ? (
          <CostCentersView profile={profile} onNotify={notify} />
        ) : safeSection === 'journals' ? (
          <JournalsView profile={profile} onNotify={notify} />
        ) : safeSection === 'receipts' ? (
          <VouchersView voucherType="RECEIPT" profile={profile} onNotify={notify} />
        ) : safeSection === 'payments' ? (
          <VouchersView voucherType="PAYMENT" profile={profile} onNotify={notify} />
        ) : safeSection === 'reports' ? (
          <ReportsView onNotify={notify} />
        ) : safeSection === 'periods' ? (
          <PeriodsView onNotify={notify} />
        ) : (
          <UsersView currentProfile={profile} onNotify={notify} />
        )}
      </Layout>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
