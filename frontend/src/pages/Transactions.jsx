import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Plus, X, Trash2, Ban, Undo2, Search, Eye, FileDown, ChevronLeft, ChevronRight, Calendar, RotateCcw } from 'lucide-react';
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

// Display invoice/cart quantities with exactly 2 decimals (e.g. 250.0000 -> 250.00)
const formatQty = (val) => {
  if (val === '' || val === null || val === undefined) return '-';
  const num = Number(val);
  if (!Number.isFinite(num)) return val;
  return num.toFixed(2);
};

// Sales Unit multipliers come from a DECIMAL(10,4) column and arrive
// zero-padded (e.g. "20.0000", "0.5000"). Convert to a number to strip the
// padding, then whole numbers show 2 decimals (20.0000 -> "20.00") while
// real fractions keep their exact value (0.5000 -> "0.5", 0.0010 -> "0.001"
// for gram units) so no meaningful decimal is rounded away.
const formatMultiplier = (val) => {
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  return Number.isInteger(num) ? num.toFixed(2) : String(num);
};

export default function Transactions() {
  const { settings } = useSettings();
  const { user } = useAuth();
  const location = useLocation();
  const isCashier = user?.role === 'cashier';
  // Voiding and deleting rewrite the sales history, so the buttons are only shown
  // to admins and managers (the API enforces the same rule).
  const canManageTransactions = !user?.demo_mode && (user?.role === 'admin' || user?.role === 'manager');
  const [transactions, setTransactions] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // all | sale | supplier
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [appliedDates, setAppliedDates] = useState({ from: '', to: '' });
  const [showModal, setShowModal] = useState(false);
  const [viewTx, setViewTx] = useState(null);
  const [error, setError] = useState('');

  const [customerName, setCustomerName] = useState('Walk-in Customer');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [discount, setDiscount] = useState(0);
  const [cartItems, setCartItems] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState('');
  const [qty, setQty] = useState(1);
  const [selectedUnitId, setSelectedUnitId] = useState(''); // Track selected unit by DB id
  const [isSubmitting, setIsSubmitting] = useState(false); // Guard against duplicate form submissions

  const loadData = async (dates = appliedDates) => {
    setLoading(true);
    try {
      const [txRes, prodRes] = await Promise.all([
        api.get('/transactions', {
          params: {
            ...(dates.from ? { from: `${dates.from} 00:00:00` } : {}),
            ...(dates.to ? { to: `${dates.to} 23:59:59` } : {}),
          },
        }),
        api.get('/products'),
      ]);
      setTransactions(txRes.data);
      setProducts(prodRes.data.filter((p) => p.status === 'active'));
    } catch (err) {
      if (err.isAuthError) return;
      setError('Failed to load transactions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const openNewSaleModal = () => {
    setCustomerName('Walk-in Customer');
    setPaymentMethod('cash');
    setDiscount(0);
    setCartItems([]);
    setSelectedProduct('');
    setQty(1);
    setError('');
    setShowModal(true);
  };

  // Open the New Sale modal when navigated from Dashboard shortcut button
  useEffect(() => {
    if (location.state?.openNewSale) {
      openNewSaleModal();
    }
  }, []);

  const addItemToCart = () => {
    if (!selectedProduct) {
      setError('Product is required before adding an item');
      return;
    }
    if (Number(qty) <= 0) {
      setError('Quantity must be greater than zero');
      return;
    }
    const product = products.find((p) => String(p.id) === String(selectedProduct));
    if (!product) return;
    
    // Get the selected unit (default to product's default unit)
    let unit = '';
    const matchedUnit = (product.units || []).find((u) => String(u.id) === String(selectedUnitId));
    if (matchedUnit) {
      unit = matchedUnit.unit;
    }
    if (!unit && product.default_unit) {
      unit = product.default_unit.unit;
    }
    if (!unit) {
      unit = product.base_unit || 'kg';
    }
    
    // Get conversion rate for selected unit
    let conversionRate = 1;
    if (product.units && product.units.length > 0) {
      const unitData = matchedUnit || product.units.find((u) => u.unit === unit);
      if (unitData) {
        conversionRate = unitData.multiplier_to_base;
      } else {
        // Unit not found in product.units, try to find it anyway
        console.warn(`Unit ${unit} not found in product ${product.id} units`);
      }
    }
    
    // Calculate price for the selected unit
    // If product price is per kg and we're selling in packs (0.5 kg/pack),
    // then price per pack = price per kg × 0.5
    const selUnit = matchedUnit || (product.units || []).find((u) => u.unit === unit);
    const unitPrice = selUnit && selUnit.price !== null && selUnit.price !== undefined && selUnit.price !== ''
      ? Number(selUnit.price)
      : Number(product.price) * conversionRate;
    
    // Calculate base quantity for stock validation
    const baseQuantity = Number(qty) * conversionRate;
    
    const existing = cartItems.find((i) => i.product_id === product.id);
    const alreadyInCartBase = existing ? Number(existing.quantity) * (existing.conversion_rate || 1) : 0;
    const requestedTotalBase = alreadyInCartBase + baseQuantity;
    
    // Validate stock using base_quantity (not selling quantity)
    if (requestedTotalBase > Number(product.stock_quantity)) {
      const availableInUnit = product.stock_quantity / conversionRate;
      setError(`${product.name} exceeds the stock limit. Available: ${product.stock_quantity} ${product.base_unit} (${availableInUnit.toFixed(2)} ${unit})`);
      return;
    }
    
    setError('');
    
    if (existing) {
      setCartItems(cartItems.map((i) => i.product_id === product.id 
        ? { 
            ...i, 
            quantity: Number(i.quantity) + Number(qty),
            base_quantity: Number(i.base_quantity) + baseQuantity
          } 
        : i
      ));
    } else {
      setCartItems([...cartItems, { 
        product_id: product.id, 
        product_name: product.name, 
        quantity: Number(qty), 
        unit_price: unitPrice,  // Use calculated unit price
        unit: unit,
        conversion_rate: conversionRate,
        base_quantity: baseQuantity
      }]);
    }
    
    setSelectedProduct('');
    setQty(1);
    setSelectedUnitId('');
  };

  const removeItem = (productId) => {
    setCartItems(cartItems.filter((i) => i.product_id !== productId));
  };

  const subtotal = cartItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
  const taxRate = Number(settings?.tax_rate || 0);
  const taxableAmount = Math.max(subtotal - Number(discount || 0), 0);
  const tax = taxableAmount * (taxRate / 100);
  const total = taxableAmount + tax;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return; // Guard: prevent duplicate form submissions
    setError('');
    if (cartItems.length === 0) {
      setError('At least one product is required for the sale');
      return;
    }
    setIsSubmitting(true);
    try {
      await api.post('/transactions', {
        customer_name: customerName,
        payment_method: paymentMethod,
        discount: Number(discount) || 0,
        tax,
        items: cartItems,
      });
      setShowModal(false);
      window.dispatchEvent(new CustomEvent('stockUpdated'));
      loadData();
    } catch (err) {
      if (err.isAuthError) return;
      setError(err.response?.data?.message || 'Failed to record transaction');
    } finally {
      setIsSubmitting(false);
    }
  };

  const viewDetails = async (tx) => {
    try {
      const res = await api.get(`/transactions/${tx.id}`);
      setViewTx(res.data);
    } catch (err) {
      if (err.isAuthError) return;
      alert('Failed to load transaction details');
    }
  };

  // Void keeps the transaction for auditing but marks it invalid — every sales
  // figure filters status='completed', so it drops out of revenue and profit.
  // Only completed transactions can be voided (and only once).
  const handleVoid = async (tx) => {
    if (!window.confirm(`Void ${tx.invoice_no}? The record stays in the list marked as voided and is excluded from all sales totals.`)) return;
    try {
      await api.patch(`/transactions/${tx.id}/void`);
      loadData();
    } catch (err) {
      if (err.isAuthError) return;
      alert(err.response?.data?.message || 'Failed to void transaction');
    }
  };

  // Unvoid is the counterpart of void: the transaction goes back to completed and
  // counts in the sales totals again.
  const handleUnvoid = async (tx) => {
    if (!window.confirm(`Unvoid ${tx.invoice_no}? It will count again in all sales totals.`)) return;
    try {
      await api.patch(`/transactions/${tx.id}/unvoid`);
      loadData();
    } catch (err) {
      if (err.isAuthError) return;
      alert(err.response?.data?.message || 'Failed to unvoid transaction');
    }
  };

  // Delete removes the transaction and its item lines permanently (admin/manager only).
  const handleDelete = async (tx) => {
    if (!window.confirm(`Delete ${tx.invoice_no}? The transaction and its items are removed permanently. This cannot be undone.`)) return;
    try {
      await api.delete(`/transactions/${tx.id}`);
      loadData();
    } catch (err) {
      if (err.isAuthError) return;
      alert(err.response?.data?.message || 'Failed to delete transaction');
    }
  };

  const formatCurrency = (val) => formatCurrencyWithSymbol(val, settings?.currency);

  const applyDateFilter = (from = dateFrom, to = dateTo) => {
    const dates = { from, to };
    setAppliedDates(dates);
    loadData(dates);
  };

  const clearDateFilter = () => {
    setDateFrom('');
    setDateTo('');
    applyDateFilter('', '');
  };

  const formatDateInput = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const applyPreset = (preset) => {
    const today = new Date();
    const end = formatDateInput(today);
    let start = end;
    if (preset === 'week') {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      start = formatDateInput(weekStart);
    } else if (preset === 'month') {
      start = formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
    } else if (preset === 'year') {
      start = formatDateInput(new Date(today.getFullYear(), 0, 1));
    }
    setDateFrom(start);
    setDateTo(end);
    applyDateFilter(start, end);
  };

  const filtered = transactions.filter((t) => {
    const matchesSearch = t.invoice_no.toLowerCase().includes(search.toLowerCase()) ||
      (t.customer_name || '').toLowerCase().includes(search.toLowerCase());
    const matchesType =
      typeFilter === 'all' ||
      (typeFilter === 'sale' && t.transaction_type !== 'restock') ||
      (typeFilter === 'supplier' && t.transaction_type === 'restock');
    return matchesSearch && matchesType;
  });

  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  useEffect(() => {
    setPage(1);
  }, [search, typeFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleExportListPDF = () => {
    const columns = ['Invoice No.', 'Customer', 'Cashier', 'Payment', 'Total', 'Date'];
    const rows = filtered.map((t) => [
      t.invoice_no,
      t.customer_name,
      t.cashier_username || '-',
      t.transaction_type === 'restock' ? `Restock - ${t.supplier_name || 'Supplier'}` : t.payment_method,
      formatCurrencyForPDF(t.total, settings?.currency),
      new Date(t.created_at).toLocaleString(),
    ]);
    const totalAmount = filtered.reduce((sum, t) => sum + Number(t.total || 0), 0);
    exportTableToPDF('Transaction History', columns, rows, 'transaction-history', `${filtered.length} transaction(s) | Total: ${formatCurrencyForPDF(totalAmount, settings?.currency)}`, settings);
  };

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900">Transaction History</h1>
          <p className="mt-1 text-gray-500 text-sm">{isCashier ? 'View your sales and record new transactions' : 'View past sales and record new transactions'}</p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <button
            onClick={handleExportListPDF}
            className="flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 px-4 py-2 rounded-lg font-medium text-sm"
          >
            <FileDown size={18} /> Export PDF
          </button>
          <button
            onClick={openNewSaleModal}
            className="flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg font-medium text-sm"
          >
            <Plus size={18} /> New Sale
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-3 sm:p-4 flex flex-col sm:flex-row sm:flex-wrap gap-3">
        <div className="relative flex-1 min-w-0 sm:min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search transactions by invoice or customer"
            placeholder="Search by invoice or customer..."
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div className="flex flex-wrap gap-1.5 sm:gap-2 items-center w-full sm:w-auto" role="group" aria-label="Filter by type">
          {[
            ['all', 'All'],
            ['sale', 'Sale'],
            ['supplier', 'Supplier'],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTypeFilter(value)}
              aria-pressed={typeFilter === value}
              className={`px-3 py-2 rounded-lg text-sm font-medium ${typeFilter === value ? 'bg-primary-600 text-white' : 'bg-white border border-gray-300 hover:bg-gray-50 text-gray-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Calendar size={17} /> Filter by date
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">From</label>
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <button onClick={() => applyDateFilter()} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white">
            <Calendar size={16} /> Apply Filter
          </button>
          <button onClick={clearDateFilter} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50 text-gray-700">
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
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-gray-50">
              <tr className="text-left text-gray-500">
                <th className="py-3 px-4">Invoice No.</th>
                <th className="py-3 px-4">Customer</th>
                {!isCashier && <th className="py-3 px-4">Cashier</th>}
                <th className="py-3 px-4">Payment</th>
                <th className="py-3 px-4">Total</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={isCashier ? 7 : 8} className="text-center py-6 text-gray-400">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={isCashier ? 7 : 8} className="text-center py-6 text-gray-400">No transactions found</td></tr>
              ) : paginated.map((t) => (
                <tr key={t.id} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="py-3 px-4 font-medium text-gray-800">{String(t.invoice_no || '').slice(0, 10)}</td>
                  <td className="py-3 px-4">{t.customer_name}</td>
                  {!isCashier && <td className="py-3 px-4">{t.cashier_username || '-'}</td>}
                  <td className="py-3 px-4 capitalize">{t.transaction_type === 'restock' ? `Restock · ${t.supplier_name || 'Supplier'}` : t.payment_method}</td>
                  <td className="py-3 px-4 font-medium">{formatCurrency(t.total)}</td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${t.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                        t.status === 'voided' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                      }`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-gray-500">{new Date(t.created_at).toLocaleString()}</td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => viewDetails(t)} title="View details" aria-label={`View transaction ${t.invoice_no}`} className="p-2 rounded-lg hover:bg-primary-50 text-primary-700">
                        <Eye size={16} />
                      </button>
                      {/* Voiding is only meaningful while the sale still counts. */}
                      {canManageTransactions && t.status === 'completed' && (
                        <button onClick={() => handleVoid(t)} title="Void transaction" aria-label={`Void transaction ${t.invoice_no}`} className="p-2 rounded-lg hover:bg-amber-50 text-amber-700">
                          <Ban size={16} />
                        </button>
                      )}
                      {/* A voided sale can be restored, so it counts in the totals again. */}
                      {canManageTransactions && t.status === 'voided' && (
                        <button onClick={() => handleUnvoid(t)} title="Unvoid transaction" aria-label={`Restore transaction ${t.invoice_no}`} className="p-2 rounded-lg hover:bg-emerald-50 text-emerald-700">
                          <Undo2 size={16} />
                        </button>
                      )}
                      {canManageTransactions && (
                        <button onClick={() => handleDelete(t)} title="Delete transaction" aria-label={`Delete transaction ${t.invoice_no}`} className="p-2 rounded-lg hover:bg-red-50 text-red-700">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm text-gray-600">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous transaction page"
                disabled={page === 1}
                className="p-1.5 rounded-lg border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-gray-600">Page {page} of {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                aria-label="Next transaction page"
                disabled={page === totalPages}
                className="p-1.5 rounded-lg border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* New Sale Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="new-sale-title" className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100">
              <h2 id="new-sale-title" className="font-semibold text-lg text-gray-900">New Sale</h2>
              <button type="button" onClick={() => setShowModal(false)} aria-label="Close new sale" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2" role="alert">{error}</div>}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Customer Name</label>
                  <input value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
                  <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                    <option value="cash">Cash</option>
                    <option value="gcash">GCash</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>

              <div className="border border-gray-200 rounded-lg p-4 space-y-3">
                <p className="text-sm font-medium text-gray-700">Add Product</p>
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                  <div className="sm:col-span-4">
                    <label className="block text-xs text-gray-500 mb-1">Product</label>
                    <select value={selectedProduct} onChange={(e) => {
                      const productId = e.target.value;
                      setSelectedProduct(productId);
                      const product = products.find((p) => String(p.id) === productId);
                      if (product?.default_unit) {
                        const du = product.units?.find((u) => u.is_default === 1); setSelectedUnitId(du ? String(du.id) : '');
                      } else if (product) {
                        { const bu = product.units?.find((u) => u.unit.toLowerCase() === String(product.base_unit || 'kg').toLowerCase()); setSelectedUnitId(bu ? String(bu.id) : ''); }
                      } else {
                        setSelectedUnitId('');
                      }
                    }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                      <option value="">Select product</option>
                      {products.map((p) => (<option key={p.id} value={p.id}>{p.name} - ₱{Number(p.price).toFixed(2)}/{p.base_unit} (Stock: {formatStock(p.stock_quantity)} {p.base_unit})</option>))}
                    </select>
                  </div>
                  
                  {selectedProduct && products.find((p) => String(p.id) === selectedProduct)?.units && (
                    <div className="col-span-6 sm:col-span-3">
                      <label className="block text-xs text-gray-500 mb-1">Sales Unit</label>
                      <select value={selectedUnitId} onChange={(e) => setSelectedUnitId(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                        {products.find((p) => String(p.id) === selectedProduct)?.units?.filter((u) => u.is_sales_unit !== 0).map((u) => (
                          <option key={u.id} value={u.id}>{'Per ' + (u.label || u.unit) + (Number(u.multiplier_to_base) !== 1 ? ' (1 ' + u.unit + ' = ' + formatMultiplier(u.multiplier_to_base) + ' ' + (products.find((p) => String(p.id) === selectedProduct)?.base_unit || '') + ')' : ' (base unit)')}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  
                  <div className="col-span-6 sm:col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Qty</label>
                    <input type="number" min="0.01" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                  </div>
                  
                  <div className="col-span-6 sm:col-span-2">
                    <label className="block text-xs text-gray-500 mb-1">Unit</label>
                    <div className="w-full px-2 py-2 border border-gray-200 rounded-lg bg-gray-50 text-xs sm:text-sm text-gray-600 text-center truncate min-h-[38px] flex items-center justify-center">
                      {products.find((p) => String(p.id) === String(selectedProduct))?.units?.find((u) => String(u.id) === String(selectedUnitId))?.label
                        || products.find((p) => String(p.id) === String(selectedProduct))?.units?.find((u) => String(u.id) === String(selectedUnitId))?.unit
                        || '-'}
                    </div>
                  </div>
                  
                  <div className="col-span-6 sm:col-span-1 flex justify-end">
                    <button type="button" onClick={addItemToCart} className="w-full px-3 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium">
                      Add
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {cartItems.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-4">No items added yet</p>
                ) : cartItems.map((item) => (
                  <div key={item.product_id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                    <div>
                      <p className="font-medium text-gray-800">{item.product_name}</p>
                      <p className="text-gray-500 text-xs">{formatQty(item.quantity)} {item.unit || item.base_unit} x {formatCurrency(item.unit_price)} · base: {formatQty(item.base_quantity)} {item.base_unit}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{formatCurrency(item.quantity * item.unit_price)}</span>
                      <button type="button" onClick={() => removeItem(item.product_id)} aria-label={`Remove ${item.product_name} from sale`} className="p-2 rounded-lg text-red-600 hover:bg-red-50">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-gray-100 pt-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Subtotal</span>
                  <span className="font-medium">{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Discount</span>
                  <input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)}
                    className="w-28 px-2 py-1 border border-gray-300 rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
                {taxRate > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-600">Tax ({taxRate}%)</span>
                    <span className="font-medium">{formatCurrency(tax)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-base font-bold">
                  <span>Total</span>
                  <span>{formatCurrency(total)}</span>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100">
                  Cancel
                </button>
                <button type="submit" disabled={isSubmitting} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed text-white">
                  {isSubmitting ? 'Saving...' : 'Complete Sale'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View Details Modal */}
      {viewTx && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="invoice-details-title" className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 id="invoice-details-title" className="font-semibold text-lg text-gray-900">Invoice {viewTx.invoice_no}</h2>
              <button type="button" onClick={() => setViewTx(null)} aria-label="Close invoice details" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100">
                <X size={20} />
              </button>
            </div>
            <div className="p-6 space-y-4 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-gray-600">
                <p><span className="font-medium text-gray-800">Customer:</span> {viewTx.customer_name}</p>
                <p><span className="font-medium text-gray-800">Cashier:</span> {viewTx.cashier_username || '-'}</p>
                <p><span className="font-medium text-gray-800">Payment:</span> {viewTx.payment_method}</p>
                <p><span className="font-medium text-gray-800">Date:</span> {new Date(viewTx.created_at).toLocaleString()}</p>
              </div>
              <div className="space-y-2">
                {viewTx.items.map((item) => (
                  <div key={item.id} className="flex justify-between border-b border-gray-50 pb-2">
                    <span>{item.product_name} x{formatQty(item.quantity)}{item.unit ? ' ' + item.unit : ''}</span>
                    <span className="font-medium">{formatCurrency(item.line_total)}</span>
                  </div>
                ))}
              </div>
              <div className="border-t border-gray-100 pt-3 space-y-1">
                <div className="flex justify-between"><span>Subtotal</span><span>{formatCurrency(viewTx.subtotal)}</span></div>
                <div className="flex justify-between"><span>Discount</span><span>-{formatCurrency(viewTx.discount)}</span></div>
                <div className="flex justify-between font-bold text-base"><span>Total</span><span>{formatCurrency(viewTx.total)}</span></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
