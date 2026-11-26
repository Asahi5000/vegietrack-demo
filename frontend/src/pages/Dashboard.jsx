import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, Package, AlertTriangle, XCircle, TrendingUp, Plus, Truck, ScanLine } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { formatCurrency as formatCurrencyWithSymbol } from '../utils/currency';
import { useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';
import { useDashboardData } from '../context/DashboardDataContext';

// lucide-react has no peso-sign icon, so we render one as a simple text glyph
// styled to match the other lucide icons (same size/stroke-like appearance).
function PesoSign({ size = 22, className = '' }) {
  return (
    <span
      className={className}
      style={{ fontSize: size, lineHeight: 1, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size }}
    >
      ₱
    </span>
  );
}

function StatCard({ title, value, icon: Icon, color }) {
  const iconColor = {
    'bg-primary-600': 'bg-primary-50 text-primary-700',
    'bg-green-600': 'bg-emerald-50 text-emerald-700',
    'bg-emerald-600': 'bg-emerald-50 text-emerald-700',
    'bg-amber-600': 'bg-amber-50 text-amber-700',
    'bg-red-600': 'bg-red-50 text-red-700',
    'bg-orange-600': 'bg-orange-50 text-orange-700',
  }[color] || 'bg-gray-100 text-gray-700';

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 sm:p-5 flex items-center gap-3 sm:gap-4 min-w-0">
      <div className={`w-11 h-11 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0 ${iconColor}`}>
        <Icon size={21} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs sm:text-sm text-gray-500 truncate">{title}</p>
        <p className="text-lg sm:text-xl font-bold text-gray-800 truncate">{value}</p>
      </div>
    </div>
  );
}

const PERIOD_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'annual', label: 'Annual' },
];

function PeriodSelect({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-2 py-1 border border-gray-300 rounded-lg text-xs font-medium text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-500 shrink-0"
    >
      {PERIOD_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

export default function Dashboard() {
  const { settings } = useSettings();
  const { user } = useAuth();
  const {
    dashboardData: data,
    loading,
    error,
    fetchDashboard,
    salesPeriod,
    setSalesPeriod,
    topProductsPeriod,
    setTopProductsPeriod,
  } = useDashboardData();
  const navigate = useNavigate();
  const isCashier = user?.role === 'cashier';

  // Nudge Recharts to recompute container size after data loads (React 19 +
  // Recharts can otherwise leave ResponsiveContainer charts blank on first render).
  useEffect(() => {
    if (data) {
      const timer = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      return () => window.clearTimeout(timer);
    }
  }, [data]);

  const formatCurrency = (val) => formatCurrencyWithSymbol(val, settings?.currency);

  if (loading && !data) return (
    <div className="space-y-4 animate-pulse" aria-label="Loading dashboard" role="status">
      <div className="h-8 w-56 rounded-lg bg-gray-200" />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 rounded-xl bg-white border border-gray-100" />)}
      </div>
      <span className="sr-only">Loading dashboard data...</span>
    </div>
  );
  if (!data) return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 text-center" role="alert">
      <p className="text-sm text-gray-600">{error || 'Dashboard data is unavailable.'}</p>
      <button onClick={fetchDashboard} className="mt-3 rounded-lg bg-primary-700 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-800">
        Try again
      </button>
    </div>
  );

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900">{isCashier ? 'My Sales Dashboard' : 'Sales Dashboard'}</h1>
          <p className="mt-1 text-gray-500 text-sm">{isCashier ? 'Overview of your sales performance' : "Overview of today's performance"}</p>
        </div>
        {loading && <span className="text-xs text-gray-500" role="status">Refreshing dashboard...</span>}
      </div>
      {error && (
        <div className="flex items-center justify-between gap-3 flex-wrap rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
          <span>{error}</span>
          <button onClick={fetchDashboard} className="font-semibold underline underline-offset-2">Retry</button>
        </div>
      )}

      {/* Quick-access shortcut buttons (upper left) */}
      <div className="flex flex-wrap gap-2">
        {!isCashier && (
          <>
            <button
              onClick={() => navigate('/inventory', { state: { openScanner: true } })}
              className="flex items-center justify-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg font-medium text-sm"
            >
              <ScanLine size={18} className="shrink-0" /> Scan QR
            </button>
            <button
              onClick={() => navigate('/inventory', { state: { openAddProduct: true } })}
              className="flex items-center justify-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg font-medium text-sm"
            >
              <Plus size={18} className="shrink-0" /> Add Product
            </button>
            <button
              onClick={() => navigate('/inventory', { state: { openRestock: true } })}
              className="flex items-center justify-center gap-2 bg-white border border-amber-300 hover:bg-amber-50 text-amber-700 px-4 py-2 rounded-lg font-medium text-sm"
            >
              <Truck size={18} className="shrink-0" /> Restock Products
            </button>
          </>
        )}
        <button
          onClick={() => navigate('/transactions', { state: { openNewSale: true } })}
          className="flex items-center justify-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg font-medium text-sm"
        >
          <ShoppingCart size={18} className="shrink-0" /> New Sale
        </button>
      </div>

      <div className={`grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4 ${isCashier ? 'xl:grid-cols-4' : 'xl:grid-cols-6'}`}>
        <StatCard title={isCashier ? "My Today's Sales" : "Today's Sales"} value={formatCurrency(data.today_sales)} icon={PesoSign} color="bg-primary-600" />
        {/* Profit is an owner/manager figure — cashier accounts don't see it */}
        {!isCashier && <StatCard title="Today's Profit" value={formatCurrency(data.today_profit)} icon={TrendingUp} color="bg-green-600" />}
        <StatCard title={isCashier ? "My Today's Transactions" : "Today's Transactions"} value={data.today_transactions} icon={ShoppingCart} color="bg-emerald-600" />
        <StatCard title="Total Products" value={data.total_products} icon={Package} color="bg-amber-600" />
        <StatCard title="Low Stock Items" value={data.low_stock_count} icon={AlertTriangle} color="bg-red-600" />
        {/* Spoiled Batches stat — owner/manager only */}
        {!isCashier && <StatCard title="Spoiled Batches" value={data.spoiled_count} icon={XCircle} color="bg-orange-600" />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 min-w-0">
        {/* Profit is an owner/manager figure — cashier accounts don't see it */}
        {!isCashier && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h2 className="font-semibold text-gray-800 text-base">Profit Trend</h2>
            <PeriodSelect value={salesPeriod} onChange={setSalesPeriod} />
          </div>
          <div className="w-full min-w-0 overflow-hidden">
            <ResponsiveContainer width="99%" height={260}>
              <LineChart data={data.sales_last_7_days}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={55} />
                <Tooltip formatter={(val) => formatCurrency(val)} />
                <Line type="monotone" dataKey="profit" name="Profit" stroke="#16a34a" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>}

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h2 className="font-semibold text-gray-800 text-base">Top Products</h2>
            <PeriodSelect value={topProductsPeriod} onChange={setTopProductsPeriod} />
          </div>
          <div className="w-full min-w-0 overflow-hidden">
            <ResponsiveContainer width="99%" height={260}>
              <BarChart data={data.top_products} margin={{ bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="product_name" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={18} />
                <YAxis tick={{ fontSize: 11 }} width={55} />
                <Tooltip formatter={(val) => formatCurrency(val)} />
                <Bar dataKey="total_revenue" fill="#059669" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
        <h2 className="font-semibold text-gray-800 mb-4 text-base">Recent Transactions</h2>
        <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
          <table className="w-full text-sm min-w-[540px]">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="py-2 pr-4 whitespace-nowrap">Invoice No.</th>
                <th className="py-2 pr-4 whitespace-nowrap">Customer</th>
                <th className="py-2 pr-4 whitespace-nowrap">Payment</th>
                <th className="py-2 pr-4 whitespace-nowrap">Total</th>
                <th className="py-2 pr-4 whitespace-nowrap">Date</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_transactions.map((tx) => (
                <tr key={tx.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                  <td className="py-2 pr-4 font-medium text-gray-700 whitespace-nowrap">{String(tx.invoice_no || '').slice(0, 10)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{tx.customer_name}</td>
                  <td className="py-2 pr-4 capitalize whitespace-nowrap">{tx.payment_method}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatCurrency(tx.total)}</td>
                  <td className="py-2 pr-4 text-gray-500 whitespace-nowrap">{new Date(tx.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {data.recent_transactions.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-center text-gray-400">No transactions yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
