import { useEffect, useState } from 'react';
import { FileDown, Calendar, RotateCcw, ChevronLeft, ChevronRight, Plus, X, Eye, Pencil, Trash2 } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import api from '../api/axios';
import { exportTableToPDF } from '../utils/pdfExport';
import { formatCurrency as formatCurrencyWithSymbol, formatCurrencyForPDF } from '../utils/currency';
import { useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';

// Display stock without trailing ".00" (e.g. 10.00 -> 10, 10.50 -> 10.5)
const formatStock = (val) => {
  if (val === '' || val === null || val === undefined) return '-';
  const num = Number(val);
  if (!Number.isFinite(num)) return val;
  return String(parseFloat(num.toFixed(2)));
};

const formatQuantity = (val) => {
  if (val === '' || val === null || val === undefined) return '-';
  const num = Number(val);
  if (!Number.isFinite(num)) return val;
  return String(parseFloat(num.toFixed(4)));
};

const SPOILED_PAGE_SIZE = 5;
const EXPENSE_PAGE_SIZE = 5;
const EXPENSE_FIELDS = [
  ['food', 'Food expenses'],
  ['internet', 'Internet'],
  ['water', 'Water'],
  ['electricity', 'Electricity'],
  ['store_materials', 'Store materials'],
  ['other', 'Other expenses'],
];

const getTodayDate = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};

export default function Reports() {
  const { settings } = useSettings();
  const { user } = useAuth();
  const isCashier = user?.role === 'cashier';
  const isDemo = Boolean(user?.demo_mode);
  const [salesData, setSalesData] = useState(null);
  const [inventoryData, setInventoryData] = useState([]);
  const [expensesData, setExpensesData] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const [selectedYear, setSelectedYear] = useState(String(now.getFullYear()));
  const [spoiledPage, setSpoiledPage] = useState(1);
  const [deletingSpoiledId, setDeletingSpoiledId] = useState(null);
  const [savingSpoiledId, setSavingSpoiledId] = useState(null);
  const [viewingSpoiled, setViewingSpoiled] = useState(null);
  const [editingSpoiled, setEditingSpoiled] = useState(null);
  const [spoiledEditForm, setSpoiledEditForm] = useState({ quantity: '', reason: '' });
  const [spoiledEditError, setSpoiledEditError] = useState('');
  const [spoiledListError, setSpoiledListError] = useState('');
  const [expensePage, setExpensePage] = useState(1);
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [viewingExpense, setViewingExpense] = useState(null);
  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [expenseListError, setExpenseListError] = useState('');
  const [expenseDate, setExpenseDate] = useState(getTodayDate);
  const [expenseAmounts, setExpenseAmounts] = useState(() => Object.fromEntries(EXPENSE_FIELDS.map(([field]) => [field, '0'])));
  const [savingExpense, setSavingExpense] = useState(false);
  const [expenseError, setExpenseError] = useState('');

  const loadData = async (overrides = {}) => {
    setLoading(true);
    try {
      const fromVal = overrides.from !== undefined ? overrides.from : from;
      const toVal = overrides.to !== undefined ? overrides.to : to;
      const params = {};
      // Inclusive date-range logic, identical to the Transaction History page:
      // from = start of day (00:00:00), to = end of day (23:59:59)
      if (fromVal) params.from = `${fromVal} 00:00:00`;
      if (toVal) params.to = `${toVal} 23:59:59`;
      const requests = [api.get('/reports/sales', { params })];
      if (!isCashier) {
        requests.push(api.get('/reports/inventory'));
        requests.push(api.get('/reports/expenses'));
      }
      const [salesRes, invRes, expensesRes] = await Promise.all(requests);
      // The PHP API returns SUM() aggregates as numeric strings (e.g. "4385.00"),
      // which would break Recharts' numeric axis/tooltip calculations.
      // Convert to real numbers so chart math works correctly.
      const normalized = {
        ...salesRes.data,
        sales_by_date: (salesRes.data.sales_by_date || []).map((d) => ({ ...d, total: Number(d.total), profit: Number(d.profit) })),
        sales_by_category: (salesRes.data.sales_by_category || []).map((c) => ({ ...c, total: Number(c.total) })),
        sales_by_payment: (salesRes.data.sales_by_payment || []).map((p) => ({ ...p, total: Number(p.total) })),
        financial_by_date: (salesRes.data.financial_by_date || []).map((d) => ({
          ...d,
          income: Number(d.income) || 0,
          expenses: Number(d.expenses) || 0,
          spoiled_loss: Number(d.spoiled_loss) || 0,
          net_profit: Number(d.net_profit) || 0,
        })),
        spoiled_products: (salesRes.data.spoiled_products || []).map((item) => ({
          ...item,
          quantity: Number(item.quantity) || 0,
          cost_price: Number(item.cost_price) || 0,
          total_loss: Number(item.total_loss) || 0,
        })),
        financials: salesRes.data.financials ? {
          total_income: Number(salesRes.data.financials.total_income) || 0,
          total_expenses: Number(salesRes.data.financials.total_expenses) || 0,
          total_spoiled_loss: Number(salesRes.data.financials.total_spoiled_loss) || 0,
          total_spoiled_quantity: Number(salesRes.data.financials.total_spoiled_quantity) || 0,
          net_profit: Number(salesRes.data.financials.net_profit) || 0,
        } : null,
        totals: {
          grand_total: Number(salesRes.data.totals?.grand_total),
          total_transactions: Number(salesRes.data.totals?.total_transactions),
          total_profit: Number(salesRes.data.totals?.total_profit),
        },
      };
      setSalesData(normalized);
      setInventoryData(isCashier ? [] : invRes.data);
      setExpensesData(isCashier ? [] : expensesRes.data.map((expense) => ({
        ...expense,
        expense_date: String(expense.expense_date).slice(0, 10),
        ...Object.fromEntries(EXPENSE_FIELDS.map(([field]) => [field, Number(expense[field]) || 0])),
      })));
      setSpoiledPage(1);
      setSpoiledListError('');
      setExpenseListError('');
      setLoadError('');
      return true;
    } catch (err) {
      if (err.isAuthError) return false;
      setLoadError('Unable to load reports or expenses. Check your connection and try again.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleClearFilter = () => {
    setFrom('');
    setTo('');
    loadData({ from: '', to: '' });
  };

  const formatDateInput = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const applyMonthReport = () => {
    if (!/^\d{4}-\d{2}$/.test(selectedMonth)) return;
    const [year, month] = selectedMonth.split('-').map(Number);
    const start = `${selectedMonth}-01`;
    const end = formatDateInput(new Date(year, month, 0));
    setFrom(start);
    setTo(end);
    loadData({ from: start, to: end });
  };

  const applyYearReport = () => {
    if (!/^\d{4}$/.test(selectedYear)) return;
    const start = `${selectedYear}-01-01`;
    const end = `${selectedYear}-12-31`;
    setFrom(start);
    setTo(end);
    loadData({ from: start, to: end });
  };

  const applyPreset = (preset) => {
    const today = new Date();
    let start = formatDateInput(today);
    let end = start;
    if (preset === 'week') {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      start = formatDateInput(weekStart);
    } else if (preset === 'month') {
      start = formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
      end = formatDateInput(new Date(today.getFullYear(), today.getMonth() + 1, 0));
    } else if (preset === 'year') {
      start = formatDateInput(new Date(today.getFullYear(), 0, 1));
      end = formatDateInput(new Date(today.getFullYear(), 11, 31));
    }
    setFrom(start);
    setTo(end);
    loadData({ from: start, to: end });
  };

  useEffect(() => { loadData();   }, [isCashier]);

  // Recharts' ResponsiveContainer can fail to size itself correctly on the
  // very first render (known issue with React 19), leaving charts blank.
  // Nudging a resize event after the data/layout settles forces it to
  // recompute and render properly.
  useEffect(() => {
    if (!loading) {
      const timer = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      return () => window.clearTimeout(timer);
    }
  }, [loading]);

  const formatCurrency = (val) => formatCurrencyWithSymbol(val, settings?.currency);

  const handleAddExpenses = async (event) => {
    event.preventDefault();
    setSavingExpense(true);
    setExpenseError('');
    try {
      if (editingExpenseId) {
        await api.put(`/reports/expenses/${editingExpenseId}`, { expense_date: expenseDate, ...expenseAmounts });
      } else {
        await api.post('/reports/expenses', { expense_date: expenseDate, ...expenseAmounts });
      }
      setShowExpenseModal(false);
      setEditingExpenseId(null);
      setExpenseAmounts(Object.fromEntries(EXPENSE_FIELDS.map(([field]) => [field, '0'])));
      setExpensePage(1);
      await loadData();
    } catch (err) {
      if (err.isAuthError) return;
      setExpenseError(err.response?.data?.message || 'Unable to save expenses. Please try again.');
    } finally {
      setSavingExpense(false);
    }
  };

  const handleEditExpense = (expense) => {
    setExpenseDate(expense.expense_date);
    setExpenseAmounts(Object.fromEntries(EXPENSE_FIELDS.map(([field]) => [field, String(expense[field]) ])));
    setEditingExpenseId(expense.id);
    setExpenseError('');
    setShowExpenseModal(true);
  };

  const handleDeleteExpense = async (expense) => {
    if (!window.confirm(`Delete the expense record for ${expense.expense_date}? This cannot be undone.`)) return;
    setExpenseListError('');
    try {
      await api.delete(`/reports/expenses/${expense.id}`);
      setExpensePage((page) => Math.min(page, Math.max(1, Math.ceil((expensesData.length - 1) / EXPENSE_PAGE_SIZE))));
      await loadData();
    } catch (err) {
      if (err.isAuthError) return;
      setExpenseListError(err.response?.data?.message || 'Unable to delete this expense record. Please try again.');
    }
  };

  const handleDeleteSpoiledProduct = async (item) => {
    const productName = item.product_name || 'this spoiled product';
    if (!window.confirm(`Delete the spoiled-product record for ${productName}? This cannot be undone. Inventory will not be changed.`)) return;
    setDeletingSpoiledId(item.id);
    setSpoiledListError('');
    try {
      await api.delete(`/spoiled-products/${item.id}`);
      const refreshed = await loadData();
      if (!refreshed) {
        setSpoiledListError('The record was deleted, but the reports could not be refreshed. Reload the page to see the latest data.');
      }
    } catch (err) {
      if (err.isAuthError) return;
      setSpoiledListError(err.response?.data?.message || 'Unable to delete this spoiled-product record. Please try again.');
    } finally {
      setDeletingSpoiledId(null);
    }
  };

  const handleEditSpoiledProduct = (item) => {
    setEditingSpoiled(item);
    setSpoiledEditForm({ quantity: String(item.quantity), reason: item.reason || '' });
    setSpoiledEditError('');
  };

  const handleSaveSpoiledProduct = async (event) => {
    event.preventDefault();
    const quantity = Number(spoiledEditForm.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setSpoiledEditError('Enter a quantity greater than 0.');
      return;
    }

    setSavingSpoiledId(editingSpoiled.id);
    setSpoiledEditError('');
    try {
      await api.put(`/spoiled-products/${editingSpoiled.id}`, {
        quantity,
        reason: spoiledEditForm.reason,
      });
      setEditingSpoiled(null);
      window.dispatchEvent(new CustomEvent('stockUpdated'));
      const refreshed = await loadData();
      if (!refreshed) {
        setSpoiledListError('The record was updated, but the reports could not be refreshed. Reload the page to see the latest data.');
      }
    } catch (err) {
      if (err.isAuthError) return;
      setSpoiledEditError(err.response?.data?.message || 'Unable to update this spoiled-product record. Please try again.');
    } finally {
      setSavingSpoiledId(null);
    }
  };

  const handleExportSalesPDF = () => {
    const columns = ['Date', 'Sales', 'Transactions'];
    const rows = salesData.sales_by_date.map((d) => [d.date, formatCurrencyForPDF(d.total, settings?.currency), d.count]);
    const range = from || to ? `Period: ${from || 'Start'} to ${to || 'Now'}` : 'All time';
    exportTableToPDF('Sales Report', columns, rows, 'sales-report', `${range} | Grand Total: ${formatCurrencyForPDF(salesData.totals.grand_total, settings?.currency)}`, settings);
  };

  const handleExportInventoryPDF = () => {
    const columns = ['Product', 'Category', 'Stock', 'Low Stock Level', 'Stock Value'];
    const rows = inventoryData.map((item) => [item.name, item.category_name || '-', formatStock(item.stock_quantity), formatStock(item.low_stock_threshold), formatCurrencyForPDF(item.stock_value, settings?.currency)]);
    const totalStockValue = inventoryData.reduce((sum, item) => sum + Number(item.stock_value || 0), 0);
    exportTableToPDF('Inventory Stock Report', columns, rows, 'inventory-stock-report', `${inventoryData.length} product(s) | Total Stock Value: ${formatCurrencyForPDF(totalStockValue, settings?.currency)}`, settings);
  };

  if (!salesData) return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 text-center" role={loadError ? 'alert' : 'status'}>
      <p className="text-sm text-gray-600">{loadError || 'Loading reports...'}</p>
      {loadError && <button onClick={() => loadData()} className="mt-3 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700">Try again</button>}
    </div>
  );

  const spoiledTotalPages = Math.max(1, Math.ceil(salesData.spoiled_products.length / SPOILED_PAGE_SIZE));
  const visibleSpoiledProducts = salesData.spoiled_products.slice(
    (spoiledPage - 1) * SPOILED_PAGE_SIZE,
    spoiledPage * SPOILED_PAGE_SIZE
  );
  const expenseTotalPages = Math.max(1, Math.ceil(expensesData.length / EXPENSE_PAGE_SIZE));
  const visibleExpenses = expensesData.slice(
    (expensePage - 1) * EXPENSE_PAGE_SIZE,
    expensePage * EXPENSE_PAGE_SIZE
  );

  const salesOverviewData = salesData.sales_by_date.reduce((overview, day) => [
    ...overview,
    { ...day, cumulative: (overview.at(-1)?.cumulative || 0) + day.total },
  ], []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900">Reports & Analytics</h1>
          <p className="mt-1 text-gray-500 text-sm">{isCashier ? 'Insights into your sales performance' : 'Insights into income, expenses, inventory, and spoilage'}</p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          {!isCashier && !isDemo && <button
            onClick={() => {
              setExpenseDate(getTodayDate());
              setEditingExpenseId(null);
              setExpenseAmounts(Object.fromEntries(EXPENSE_FIELDS.map(([field]) => [field, '0'])));
              setExpenseError('');
              setShowExpenseModal(true);
            }}
            className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg font-medium text-sm"
          >
            <Plus size={18} /> Add Expenses
          </button>}
          <button
            onClick={handleExportSalesPDF}
            className="flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg font-medium text-sm"
          >
            <FileDown size={18} /> Export Sales PDF
          </button>
          {!isCashier && <button
            onClick={handleExportInventoryPDF}
            className="flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg font-medium text-sm"
          >
            <FileDown size={18} /> Export Inventory PDF
          </button>}
        </div>
      </div>
      {showExpenseModal && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <form onSubmit={handleAddExpenses} role="dialog" aria-modal="true" aria-labelledby="expense-modal-title" className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-gray-100 p-5">
              <div>
                <h2 id="expense-modal-title" className="text-lg font-semibold text-gray-900">{editingExpenseId ? 'Edit expenses' : 'Add expenses'}</h2>
                <p className="mt-1 text-sm text-gray-500">Enter the store expenses for a date. Use 0 for any category without an expense.</p>
              </div>
              <button type="button" onClick={() => setShowExpenseModal(false)} aria-label="Close modal" className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label htmlFor="expense-date" className="block text-sm font-medium text-gray-700 mb-1">Expense date</label>
                <input
                  id="expense-date"
                  type="date"
                  required
                  value={expenseDate}
                  onChange={(event) => setExpenseDate(event.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {EXPENSE_FIELDS.map(([field, label]) => (
                  <div key={field}>
                    <label htmlFor={`expense-${field}`} className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
                    <input
                      id={`expense-${field}`}
                      type="number"
                      min="0"
                      max="99999999.99"
                      step="0.01"
                      required
                      value={expenseAmounts[field]}
                      onChange={(event) => setExpenseAmounts((current) => ({ ...current, [field]: event.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </div>
                ))}
              </div>
              {expenseError && <p role="alert" className="text-sm text-red-700">{expenseError}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 p-5">
              <button type="button" onClick={() => setShowExpenseModal(false)} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit" disabled={savingExpense} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-60 disabled:cursor-not-allowed">
                {savingExpense ? 'Saving...' : editingExpenseId ? 'Save changes' : 'Save expenses'}
              </button>
            </div>
          </form>
        </div>
      )}
      {loadError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{loadError}</div>}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Calendar size={17} /> Filter by date
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">From</label>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full sm:w-auto px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="w-full sm:w-auto px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <button onClick={() => loadData()} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white">
            <Calendar size={16} /> Apply Filter
          </button>
          <button onClick={handleClearFilter} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50 text-gray-700">
            <RotateCcw size={16} /> Clear Filter
          </button>
          <div className="flex flex-wrap gap-2">
            {[
              ['today', 'Today'],
              ['week', 'Week'],
              ['month', 'Month'],
              ['year', 'Year'],
            ].map(([value, label]) => (
              <button key={value} onClick={() => applyPreset(value)} className="px-3 py-2 rounded-lg text-sm border border-gray-300 hover:bg-gray-50 text-gray-700">
                {label}
              </button>
            ))}
          </div>
          {!isCashier && <div className="flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3 w-full">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Monthly report</label>
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
            <button onClick={applyMonthReport} className="px-3 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white">
              Apply Month
            </button>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Annual report year</label>
              <input
                type="number"
                min="2000"
                max="9999"
                value={selectedYear}
                onChange={(e) => setSelectedYear(e.target.value)}
                className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              />
            </div>
            <button onClick={applyYearReport} className="px-3 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white">
              Apply Year
            </button>
          </div>}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {!isCashier && salesData.financials && <>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
            <p className="text-sm text-gray-500">Total Income</p>
            <p className="mt-2 text-xl sm:text-2xl font-bold text-gray-900 break-words">{formatCurrency(salesData.financials.total_income)}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
            <p className="text-sm text-gray-500">Total Expenses</p>
            <p className="mt-2 text-xl sm:text-2xl font-bold text-gray-900 break-words">{formatCurrency(salesData.financials.total_expenses)}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
            <p className="text-sm text-gray-500">Total Spoiled Product Loss</p>
            <p className="mt-2 text-xl sm:text-2xl font-bold text-red-700 break-words">{formatCurrency(salesData.financials.total_spoiled_loss)}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
            <p className="text-sm text-gray-500">Total Spoiled Quantity</p>
            <p className="mt-2 text-xl sm:text-2xl font-bold text-gray-900 break-words">{formatQuantity(salesData.financials.total_spoiled_quantity)}</p>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
            <p className="text-sm text-gray-500">Net Profit</p>
            <p className={`mt-2 text-xl sm:text-2xl font-bold break-words ${salesData.financials.net_profit < 0 ? 'text-red-700' : 'text-primary-700'}`}>
              {formatCurrency(salesData.financials.net_profit)}
            </p>
          </div>
        </>}
        {!isCashier && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500">Total Profit</p>
          <p className="text-2xl font-bold text-green-600">{formatCurrency(salesData.totals.total_profit)}</p>
        </div>}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500">Total Transactions</p>
          <p className="text-2xl font-bold text-gray-800">{salesData.totals.total_transactions}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500">Avg. Transaction Value</p>
          <p className="text-2xl font-bold text-gray-800">
            {formatCurrency(salesData.totals.total_transactions > 0 ? salesData.totals.grand_total / salesData.totals.total_transactions : 0)}
          </p>
        </div>
      </div>

      <div className={`grid grid-cols-1 ${isCashier ? '' : 'lg:grid-cols-2'} gap-4 sm:gap-6 min-w-0`}>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
          <h2 className="font-semibold text-gray-800 mb-4">Sales Overview</h2>
          {salesOverviewData.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center text-sm text-gray-400">
              No sales data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={salesOverviewData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2c7544" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#2c7544" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} minTickGap={24} />
                <YAxis yAxisId="daily" tick={{ fontSize: 12 }} tickLine={false} width={60} />
                <YAxis yAxisId="cumulative" orientation="right" tick={{ fontSize: 12 }} tickLine={false} width={60} />
                <Tooltip formatter={(value) => formatCurrency(value)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area yAxisId="daily" type="monotone" dataKey="total" name="Daily Sales" stroke="#2c7544" strokeWidth={2} fill="url(#salesGradient)" />
                <Line yAxisId="cumulative" type="monotone" dataKey="cumulative" name="Cumulative Sales" stroke="#d97706" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {!isCashier && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0">
        <h2 className="font-semibold text-gray-800 mb-4">Income, Expenses & Spoiled Loss</h2>
        {salesData.financial_by_date.length === 0 ? (
          <div className="h-[260px] flex items-center justify-center text-sm text-gray-400">
            No financial data available for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={salesData.financial_by_date} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} minTickGap={24} />
              <YAxis tick={{ fontSize: 12 }} tickLine={false} width={70} />
              <Tooltip formatter={(val) => formatCurrency(val)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="income" name="Income" stroke="#2c7544" fill="#2c7544" fillOpacity={0.12} />
              <Line type="monotone" dataKey="expenses" name="Expenses" stroke="#f59e0b" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="spoiled_loss" name="Spoiled Loss" stroke="#dc2626" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="net_profit" name="Net Profit" stroke="#204b31" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
        </div>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 min-w-0">
        {!isCashier && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0 overflow-hidden">
          <h2 className="font-semibold text-gray-800 mb-4">Profit Trend</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={salesData.sales_by_date}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip formatter={(value) => formatCurrency(value)} />
              <Bar dataKey="profit" name="Profit" fill="#2c7544" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5 min-w-0 overflow-hidden">
          <h2 className="font-semibold text-gray-800 mb-4">Sales by Category</h2>
          {salesData.sales_by_category.length === 0 ? (
            <div className="h-[260px] flex items-center justify-center text-sm text-gray-400">
              No category sales data available
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={[...salesData.sales_by_category].sort((a, b) => b.total - a.total)}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis
                  dataKey="category"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(val) => formatCurrency(val)} />
                <Bar dataKey="total" fill="#2c7544" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5">
        <h2 className="font-semibold text-gray-800 mb-4">Sales by Payment Method</h2>
        {salesData.sales_by_payment.length ? <div className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {salesData.sales_by_payment.map((p) => (
            <div key={p.payment_method} className="bg-gray-50 rounded-xl p-4 text-center min-w-0">
              <p className="text-xs text-gray-500 capitalize">{p.payment_method}</p>
              <p className="mt-1 text-lg font-bold text-gray-900 break-words">{formatCurrency(p.total)}</p>
              <p className="text-xs text-gray-400">{p.count} transactions</p>
            </div>
          ))}
        </div> : <p className="py-6 text-center text-sm text-gray-400">No payment data available for this period</p>}
      </div>

      {!isCashier && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h2 className="font-semibold text-gray-800">Operating Expenses</h2>
            <p className="mt-1 text-sm text-gray-500">Expense records added from this report.</p>
          </div>
          <span className="text-sm text-gray-500">{expensesData.length} record{expensesData.length === 1 ? '' : 's'}</span>
        </div>
        {expenseListError && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{expenseListError}</p>}
        {expensesData.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-400">No expenses recorded yet</div>
        ) : (
          <>
            <div className="table-responsive">
              <table className="w-full text-sm min-w-[1050px] whitespace-nowrap">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="py-2 pr-4">Date</th>
                    {EXPENSE_FIELDS.map(([, label]) => <th key={label} className="py-2 pr-4">{label}</th>)}
                    <th className="py-2 pr-4">Total</th>
                    <th className="py-2 pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleExpenses.map((expense) => {
                    const total = EXPENSE_FIELDS.reduce((sum, [field]) => sum + Number(expense[field] || 0), 0);
                    return (
                      <tr key={expense.id} className="border-b border-gray-50 last:border-0">
                        <td className="py-3 pr-4 font-medium text-gray-700">{expense.expense_date}</td>
                        {EXPENSE_FIELDS.map(([field]) => <td key={field} className="py-3 pr-4">{formatCurrency(expense[field])}</td>)}
                        <td className="py-3 pr-4 font-semibold text-gray-800">{formatCurrency(total)}</td>
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => setViewingExpense(expense)} aria-label={`View expenses for ${expense.expense_date}`} title="View" className="p-2 rounded-lg text-gray-600 hover:bg-gray-100">
                              <Eye size={16} />
                            </button>
                            {!isDemo && (
                              <>
                                <button type="button" onClick={() => handleEditExpense(expense)} aria-label={`Edit expenses for ${expense.expense_date}`} title="Edit" className="p-2 rounded-lg text-primary-700 hover:bg-primary-50">
                                  <Pencil size={16} />
                                </button>
                                <button type="button" onClick={() => handleDeleteExpense(expense)} aria-label={`Delete expenses for ${expense.expense_date}`} title="Delete" className="p-2 rounded-lg text-red-700 hover:bg-red-50">
                                  <Trash2 size={16} />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 mt-4">
              <span className="text-gray-500 text-xs sm:text-sm">
                Showing {(expensePage - 1) * EXPENSE_PAGE_SIZE + 1}-{Math.min(expensePage * EXPENSE_PAGE_SIZE, expensesData.length)} of {expensesData.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setExpensePage((page) => Math.max(1, page - 1))}
                  disabled={expensePage === 1}
                  className="flex items-center gap-1 px-3 py-2 border border-gray-300 rounded-lg text-xs sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  <ChevronLeft size={16} /> Previous
                </button>
                <span className="text-gray-600 text-xs sm:text-sm">Page {expensePage} of {expenseTotalPages}</span>
                <button
                  onClick={() => setExpensePage((page) => Math.min(expenseTotalPages, page + 1))}
                  disabled={expensePage === expenseTotalPages}
                  className="flex items-center gap-1 px-3 py-2 border border-gray-300 rounded-lg text-xs sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Next <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>}

      {!isCashier && viewingExpense && <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
        <div role="dialog" aria-modal="true" aria-labelledby="view-expense-title" className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
          <div className="flex items-center justify-between border-b border-gray-100 p-5">
            <div>
              <h2 id="view-expense-title" className="text-lg font-semibold text-gray-900">Expense details</h2>
              <p className="mt-1 text-sm text-gray-500">{viewingExpense.expense_date}</p>
            </div>
            <button type="button" onClick={() => setViewingExpense(null)} aria-label="Close details" className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg">
              <X size={18} />
            </button>
          </div>
          <div className="p-5 space-y-3">
            {EXPENSE_FIELDS.map(([field, label]) => (
              <div key={field} className="flex justify-between gap-4 text-sm">
                <span className="text-gray-600">{label}</span>
                <span className="font-medium text-gray-900">{formatCurrency(viewingExpense[field])}</span>
              </div>
            ))}
            <div className="flex justify-between gap-4 border-t border-gray-100 pt-3 text-sm">
              <span className="font-semibold text-gray-700">Total</span>
              <span className="font-bold text-gray-900">
                {formatCurrency(EXPENSE_FIELDS.reduce((sum, [field]) => sum + Number(viewingExpense[field] || 0), 0))}
              </span>
            </div>
          </div>
          <div className="flex justify-end border-t border-gray-100 p-5">
            <button type="button" onClick={() => setViewingExpense(null)} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">Close</button>
          </div>
        </div>
      </div>}

      {!isCashier && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-semibold text-gray-800 mb-4">Spoiled Products</h2>
        {spoiledListError && <p role="alert" className="mb-3 text-sm text-red-700">{spoiledListError}</p>}
        {salesData.spoiled_products.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-400">No spoiled products recorded for this period</div>
        ) : (
          <div className="table-responsive">
            <table className="w-full text-sm min-w-[900px] whitespace-nowrap">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-100">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Product Name</th>
                  <th className="py-2 pr-4">Batch</th>
                  <th className="py-2 pr-4">Spoiled Quantity</th>
                  <th className="py-2 pr-4">Cost Price</th>
                  <th className="py-2 pr-4">Total Spoiled Loss</th>
                  <th className="py-2 pr-4">Reason</th>
                  <th className="py-2 pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleSpoiledProducts.map((item) => (
                  <tr key={item.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-2 pr-4">{String(item.spoiled_date || '').slice(0, 10) || '-'}</td>
                    <td className="py-2 pr-4 font-medium text-gray-700">{item.product_name || 'Product unavailable'}</td>
                    <td className="py-2 pr-4">
                      {item.batch_id ? `#${item.batch_id}${item.batch_purchase_date ? ` (${String(item.batch_purchase_date).slice(0, 10)})` : ''}` : '-'}
                    </td>
                    <td className="py-2 pr-4">{formatQuantity(item.quantity)}</td>
                    <td className="py-2 pr-4">{formatCurrency(item.cost_price)}</td>
                    <td className="py-2 pr-4 font-medium text-red-600">{formatCurrency(item.total_loss)}</td>
                    <td className="py-2 pr-4">{item.reason || '-'}</td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setViewingSpoiled(item)}
                          aria-label={`View spoiled-product record for ${item.product_name || 'product'}`}
                          title="View record"
                          className="p-2 rounded-lg text-gray-600 hover:bg-gray-100"
                        >
                          <Eye size={16} />
                        </button>
                        {!isDemo && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleEditSpoiledProduct(item)}
                              aria-label={`Edit spoiled-product record for ${item.product_name || 'product'}`}
                              title="Edit record"
                              className="p-2 rounded-lg text-primary-700 hover:bg-primary-50"
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteSpoiledProduct(item)}
                              disabled={deletingSpoiledId === item.id || savingSpoiledId === item.id}
                              aria-label={`Delete spoiled-product record for ${item.product_name || 'product'}`}
                              title="Delete record"
                              className="p-2 rounded-lg text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between gap-3 mt-4">
              <span className="text-gray-500 text-xs sm:text-sm">
                Showing {(spoiledPage - 1) * SPOILED_PAGE_SIZE + 1}-{Math.min(spoiledPage * SPOILED_PAGE_SIZE, salesData.spoiled_products.length)} of {salesData.spoiled_products.length}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSpoiledPage((page) => Math.max(1, page - 1))}
                  disabled={spoiledPage === 1}
                  className="flex items-center gap-1 px-3 py-2 border border-gray-300 rounded-lg text-xs sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  <ChevronLeft size={16} /> Previous
                </button>
                <span className="text-gray-600 text-xs sm:text-sm">Page {spoiledPage} of {spoiledTotalPages}</span>
                <button
                  onClick={() => setSpoiledPage((page) => Math.min(spoiledTotalPages, page + 1))}
                  disabled={spoiledPage === spoiledTotalPages}
                  className="flex items-center gap-1 px-3 py-2 border border-gray-300 rounded-lg text-xs sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  Next <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>}

      {viewingSpoiled && <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
        <div role="dialog" aria-modal="true" aria-labelledby="view-spoiled-title" className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
          <div className="flex items-center justify-between border-b border-gray-100 p-5">
            <div>
              <h2 id="view-spoiled-title" className="text-lg font-semibold text-gray-900">Spoiled product details</h2>
              <p className="mt-1 text-sm text-gray-500">{viewingSpoiled.product_name || 'Product unavailable'}</p>
            </div>
            <button type="button" onClick={() => setViewingSpoiled(null)} aria-label="Close details" className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg">
              <X size={18} />
            </button>
          </div>
          <div className="p-5 space-y-3">
            {[
              ['Date', String(viewingSpoiled.spoiled_date || '').slice(0, 10) || '-'],
              ['Batch', viewingSpoiled.batch_id ? `#${viewingSpoiled.batch_id}${viewingSpoiled.batch_purchase_date ? ` (${String(viewingSpoiled.batch_purchase_date).slice(0, 10)})` : ''}` : '-'],
              ['Spoiled quantity', formatQuantity(viewingSpoiled.quantity)],
              ['Cost price', formatCurrency(viewingSpoiled.cost_price)],
              ['Total spoiled loss', formatCurrency(viewingSpoiled.total_loss)],
              ['Reason', viewingSpoiled.reason || '-'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 text-sm">
                <span className="text-gray-600">{label}</span>
                <span className="font-medium text-gray-900 text-right">{value}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end border-t border-gray-100 p-5">
            <button type="button" onClick={() => setViewingSpoiled(null)} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50">Close</button>
          </div>
        </div>
      </div>}

      {editingSpoiled && <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
        <form role="dialog" aria-modal="true" aria-labelledby="edit-spoiled-title" onSubmit={handleSaveSpoiledProduct} className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
          <div className="flex items-center justify-between border-b border-gray-100 p-5">
            <div>
              <h2 id="edit-spoiled-title" className="text-lg font-semibold text-gray-900">Edit spoiled product</h2>
              <p className="mt-1 text-sm text-gray-500">{editingSpoiled.product_name || 'Product unavailable'}</p>
            </div>
            <button type="button" onClick={() => setEditingSpoiled(null)} aria-label="Close edit form" className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg">
              <X size={18} />
            </button>
          </div>
          <div className="p-5 space-y-4">
            {spoiledEditError && <p role="alert" className="text-sm text-red-700">{spoiledEditError}</p>}
            <p className="text-xs text-amber-800 rounded-lg bg-amber-50 p-3">
              Changing the quantity updates the product and purchase-batch stock.
            </p>
            <div>
              <label htmlFor="edit-spoiled-quantity" className="block text-xs font-medium text-gray-600 mb-1">Spoiled quantity</label>
              <input
                id="edit-spoiled-quantity"
                type="number"
                min="0.0001"
                step="0.0001"
                required
                value={spoiledEditForm.quantity}
                onChange={(event) => setSpoiledEditForm((form) => ({ ...form, quantity: event.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label htmlFor="edit-spoiled-reason" className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
              <textarea
                id="edit-spoiled-reason"
                rows="3"
                maxLength={255}
                value={spoiledEditForm.reason}
                onChange={(event) => setSpoiledEditForm((form) => ({ ...form, reason: event.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-gray-100 p-5">
            <button type="button" onClick={() => setEditingSpoiled(null)} disabled={savingSpoiledId === editingSpoiled.id} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={savingSpoiledId === editingSpoiled.id} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50">
              {savingSpoiledId === editingSpoiled.id ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>}

      {!isCashier && <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h2 className="font-semibold text-gray-800 mb-4">Inventory Stock Levels</h2>
        <div className="table-responsive">
          <table className="w-full text-sm min-w-[540px] whitespace-nowrap">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-100">
                <th className="py-2 pr-4">Product</th>
                <th className="py-2 pr-4">Category</th>
                <th className="py-2 pr-4">Stock</th>
                <th className="py-2 pr-4">Low Stock Level</th>
                <th className="py-2 pr-4">Stock Value</th>
              </tr>
            </thead>
            <tbody>
              {inventoryData.map((item) => (
                <tr key={item.id} className="border-b border-gray-50 last:border-0">
                  <td className="py-2 pr-4 font-medium text-gray-700">{item.name}</td>
                  <td className="py-2 pr-4">{item.category_name || '-'}</td>
                  <td className={`py-2 pr-4 ${Number(item.stock_quantity) <= Number(item.low_stock_threshold) ? 'text-red-600 font-medium' : ''}`}>
                    {formatStock(item.stock_quantity)}
                  </td>
                  <td className="py-2 pr-4">{formatStock(item.low_stock_threshold)}</td>
                  <td className="py-2 pr-4">{formatCurrency(item.stock_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>}
    </div>
  );
}
