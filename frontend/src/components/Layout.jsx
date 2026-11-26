import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Package, Receipt, BarChart3, Users, Settings, LogOut, Menu
} from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import logoImg from '../assets/vegietrack-logo.png';
import NotificationCenter from './NotificationCenter';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/inventory', label: 'Inventory', icon: Package, hideForCashier: true },
  { to: '/transactions', label: 'Transaction History', icon: Receipt },
  { to: '/reports', label: 'Reports & Analytics', icon: BarChart3 },
  { to: '/users', label: 'User Management', icon: Users, adminOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
  );
  const currentPage = navItems.find((item) => (
    item.to === '/'
      ? location.pathname === '/'
      : location.pathname.startsWith(item.to)
  ));

  const toggleSidebar = () => {
    setSidebarOpen((s) => !s);
    // Recharts' ResponsiveContainer watches its container size via
    // ResizeObserver; nudge a single resize event after the layout change so
    // charts (e.g. on the Reports & Analytics page) repaint correctly.
    window.setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };

  const closeSidebarOnMobile = () => {
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) {
      setSidebarOpen(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-gray-50">
      {sidebarOpen && (
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close navigation menu"
          className="fixed inset-0 bg-gray-950/40 backdrop-blur-[1px] z-30 md:hidden"
        />
      )}

      <aside
        aria-label="Primary navigation"
        className={`fixed md:relative inset-y-0 left-0 z-40 flex flex-col overflow-hidden shrink-0 bg-[#17291e] text-gray-100 transition-[transform,width] duration-200 ease-out w-64 max-w-[86vw] border-r border-white/5 ${
          sidebarOpen ? 'translate-x-0 md:w-64' : '-translate-x-full md:translate-x-0 md:w-[76px]'
        }`}
      >
        <div className={`flex items-center gap-3 px-4 py-5 border-b border-white/10 shrink-0 ${sidebarOpen ? '' : 'md:justify-center md:px-2'}`}>
          <img src={logoImg} alt="VegieTrack" className="w-10 h-10 rounded-xl bg-white object-cover shrink-0" />
          <div className={`min-w-0 ${sidebarOpen ? '' : 'md:hidden'}`}>
            <p className="font-bold text-lg leading-tight whitespace-nowrap truncate tracking-tight">VegieTrack</p>
            <p className="text-[11px] text-gray-400 whitespace-nowrap truncate">Market management</p>
          </div>
        </div>
        <nav className={`flex-1 px-3 py-5 space-y-1.5 overflow-y-auto min-h-0 ${sidebarOpen ? '' : 'md:px-2'}`}>
          {navItems
            .filter((item) => (!item.adminOnly || user?.role === 'admin') && (!item.hideForCashier || user?.role !== 'cashier'))
            .map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={closeSidebarOnMobile}
                title={sidebarOpen ? undefined : label}
                aria-label={label}
                className={({ isActive }) =>
                  `group flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap focus-visible:outline-offset-2 ${
                    isActive
                      ? 'bg-primary-600 text-white shadow-sm shadow-black/15'
                      : 'text-gray-300 hover:bg-white/8 hover:text-white'
                  }`
                }
              >
                <Icon size={19} strokeWidth={1.9} className="shrink-0" />
                <span className={`truncate ${sidebarOpen ? '' : 'md:hidden'}`}>{label}</span>
              </NavLink>
            ))}
        </nav>
        <div className={`px-3 py-4 border-t border-white/10 shrink-0 ${sidebarOpen ? '' : 'md:px-2'}`}>
          {sidebarOpen && (
            <div className="px-3 pb-3 mb-2 border-b border-white/10 md:block">
              <p className="text-xs font-medium text-white truncate">{user?.full_name || user?.username}</p>
              <p className="mt-0.5 text-[11px] text-gray-400 capitalize">{user?.role}</p>
            </div>
          )}
          <button
            onClick={handleLogout}
            title={sidebarOpen ? undefined : 'Log out'}
            aria-label="Log out"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-gray-300 hover:bg-red-600/90 hover:text-white w-full whitespace-nowrap ${sidebarOpen ? '' : 'md:justify-center md:px-0'}`}
          >
            <LogOut size={18} className="shrink-0" />
            <span className={`truncate ${sidebarOpen ? '' : 'md:hidden'}`}>Log out</span>
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="relative z-40 bg-white/95 backdrop-blur border-b border-gray-200/80 px-3 sm:px-6 py-3 flex items-center justify-between shrink-0 min-w-0">
          <button
            onClick={toggleSidebar}
            className="inline-flex items-center justify-center min-w-10 min-h-10 p-2 rounded-xl hover:bg-gray-100 text-gray-600 shrink-0 focus-visible:outline-offset-1"
            aria-label={sidebarOpen ? 'Collapse navigation menu' : 'Expand navigation menu'}
            aria-expanded={sidebarOpen}
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="hidden sm:block min-w-0 mr-1">
              <p className="text-sm font-semibold text-gray-800 truncate">{currentPage?.label || 'VegieTrack'}</p>
            </div>
            <NotificationCenter />
            {user?.demo_mode && (
              <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-emerald-800 sm:inline-flex">
                Demo
              </span>
            )}
            <div className="w-9 h-9 rounded-full bg-primary-100 text-primary-800 flex items-center justify-center font-semibold uppercase shrink-0" aria-hidden="true">
              {(user?.full_name || user?.username || 'A').charAt(0)}
            </div>
            <div className="hidden sm:block min-w-0">
              <p className="text-sm font-semibold text-gray-800 truncate max-w-[150px]">{user?.full_name || user?.username}</p>
              <p className="text-xs text-gray-500 capitalize truncate">{user?.role}</p>
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 lg:p-8 min-w-0">
          {user?.demo_mode && (
            <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-950" role="status">
              <strong>Portfolio demo</strong>
              <span>Fictional data only. Sales and stock updates affect this isolated demo; administrative and destructive actions are disabled.</span>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
