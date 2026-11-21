import React, { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  CalendarRange,
  FileSpreadsheet,
  FolderTree,
  History,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Users,
  X,
} from 'lucide-react';
import { ROLE_LABELS } from '../lib/format.ts';
import type { UserProfile } from '../shared/types.ts';

export type NavSection =
  | 'dashboard'
  | 'accounts'
  | 'cost-centers'
  | 'journals'
  | 'journal-import-history'
  | 'receipts'
  | 'payments'
  | 'reports'
  | 'periods'
  | 'users';

interface NavItem {
  id: NavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'لوحة التحكم', icon: LayoutDashboard },
  { id: 'accounts', label: 'شجرة الحسابات', icon: FolderTree },
  { id: 'cost-centers', label: 'مراكز التكلفة', icon: Layers },
  { id: 'journals', label: 'القيود اليومية', icon: BookOpen },
  { id: 'journal-import-history', label: 'سجل استيراد القيود', icon: History, adminOnly: true },
  { id: 'receipts', label: 'سندات القبض', icon: ArrowDownLeft },
  { id: 'payments', label: 'سندات الصرف', icon: ArrowUpRight },
  { id: 'reports', label: 'التقارير المالية', icon: BarChart3 },
  { id: 'periods', label: 'الفترات المحاسبية', icon: CalendarRange, adminOnly: true },
  { id: 'users', label: 'المستخدمون والصلاحيات', icon: Users, adminOnly: true },
];

export function Layout({
  profile,
  activeSection,
  onSelectSection,
  onLogout,
  children,
}: {
  profile: UserProfile;
  activeSection: NavSection;
  onSelectSection: (section: NavSection) => void;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const visibleItems = NAV_ITEMS.filter((item) => !item.adminOnly || profile.role === 'ADMIN');
  const activeItem = visibleItems.find((i) => i.id === activeSection) || visibleItems[0];

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between bg-slate-900 text-slate-100">
      <div>
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white">
              <FileSpreadsheet className="h-4 w-4" />
            </div>
            <span className="text-base font-bold tracking-tight text-white whitespace-nowrap">
              ميزان المحاسبي
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
            aria-label="إغلاق القائمة"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="space-y-1 p-3" aria-label="التنقل الرئيسي">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === activeSection;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectSection(item.id);
                  setMobileOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-emerald-700 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="border-t border-slate-800 p-4">
        <div className="mb-3 text-xs text-slate-400">
          <div className="truncate font-semibold text-slate-200">{profile.full_name}</div>
          <div className="mt-0.5 truncate">{ROLE_LABELS[profile.role]}</div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>تسجيل الخروج</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Desktop Sidebar */}
      <aside className="no-print hidden w-64 shrink-0 border-l border-slate-800 lg:block">
        <div className="sticky top-0 h-screen">{sidebarContent}</div>
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen ? (
        <div className="no-print fixed inset-0 z-50 flex lg:hidden">
          <div className="w-64 shrink-0">{sidebarContent}</div>
          <div
            className="flex-1 bg-slate-900/50"
            onClick={() => setMobileOpen(false)}
          />
        </div>
      ) : null}

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3.5 lg:px-8">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 lg:hidden"
              aria-label="فتح القائمة"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500 min-w-0">
              <span className="hidden sm:inline whitespace-nowrap">النظام المحاسبي</span>
              <span className="hidden sm:inline" aria-hidden="true">/</span>
              <h1 className="truncate text-base font-bold text-slate-900">
                {activeItem?.label}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-500 shrink-0">
            <span className="hidden md:inline whitespace-nowrap">{profile.full_name}</span>
            <span className="hidden md:inline" aria-hidden="true">·</span>
            <span className="whitespace-nowrap font-medium text-slate-700">
              {ROLE_LABELS[profile.role]}
            </span>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-8">
          <div className="mx-auto max-w-[1320px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
