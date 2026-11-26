import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Wallet, X, ChevronLeft, ChevronRight, Calendar, RotateCcw } from 'lucide-react';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { formatCurrency } from '../utils/currency';

const emptyForm = { username: '', password: '', full_name: '', email: '', role: 'cashier', status: 'active', payroll: '' };
const currentDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const emptyPayrollForm = { user_id: '', period: currentDate(), amount: '', notes: '' };
const isPayrollRole = (role) => role === 'manager' || role === 'cashier';
const formatPeriod = (period) => {
  if (!period) return '-';
  const [year, month, day] = period.split('-');
  const date = new Date(Number(year), Number(month) - 1, Number(day) || 1);
  return date.toLocaleDateString(undefined, day ? { month: 'long', day: 'numeric', year: 'numeric' } : { month: 'long', year: 'numeric' });
};

export default function Users() {
  const { user: currentUser } = useAuth();
  const { settings } = useSettings();
  const [users, setUsers] = useState([]);
  const [adminEmailSettings, setAdminEmailSettings] = useState({ email: '' });
  const [payrolls, setPayrolls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showPayrollModal, setShowPayrollModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [payrollForm, setPayrollForm] = useState(emptyPayrollForm);
  const [error, setError] = useState('');
  const [payrollError, setPayrollError] = useState('');
  const [savingUser, setSavingUser] = useState(false);
  const [savingPayroll, setSavingPayroll] = useState(false);
  const PAGE_SIZE = 10;
  const isDemo = Boolean(currentUser?.demo_mode);
  const [page, setPage] = useState(1);
  const [payrollFrom, setPayrollFrom] = useState('');
  const [payrollTo, setPayrollTo] = useState('');
  const [appliedPayrollRange, setAppliedPayrollRange] = useState({ from: '', to: '' });

  const payableUsers = users.filter((u) => isPayrollRole(u.role));
  // Admin accounts keep their status locked — it cannot be edited in the form
  const editingAdmin = editingId != null && users.find((u) => String(u.id) === String(editingId))?.role === 'admin';

  const loadUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const usersRes = await api.get('/users');
      setUsers(usersRes.data);
      const admin = usersRes.data.find((account) => account.role === 'admin');
      setAdminEmailSettings({
        email: admin?.email || '',
      });
    } catch (err) {
      if (err.isAuthError) return;
      setError(err.response?.data?.message || 'Failed to load users');
    }
    try {
      const payrollsRes = await api.get('/payrolls');
      setPayrolls(payrollsRes.data);
    } catch {
      // Payrolls endpoint failed — don't block the user list from rendering
      setPayrolls([]);
    }
    setLoading(false);
  };

  useEffect(() => { loadUsers(); }, []);

  const openAddModal = () => {
    setForm({
      ...emptyForm,
      email: adminEmailSettings.email,
    });
    setEditingId(null);
    setError('');
    setShowModal(true);
  };

  const openEditModal = (u) => {
    setForm({
      username: u.username,
      password: '',
      full_name: u.full_name || '',
      email: u.role === 'admin' ? (u.email || '') : adminEmailSettings.email,
      role: u.role,
      status: u.status,
      payroll: isPayrollRole(u.role) && u.payroll != null ? String(u.payroll) : '',
    });
    setEditingId(u.id);
    setError('');
    setShowModal(true);
  };

  const openPayrollModal = (u = null) => {
    const employee = u && isPayrollRole(u.role) ? u : payableUsers[0];
    setPayrollForm({
      user_id: employee ? String(employee.id) : '',
      period: currentDate(),
      amount: employee?.payroll ? String(employee.payroll) : '',
      notes: '',
    });
    setPayrollError('');
    setShowPayrollModal(true);
  };

  const handleRoleChange = (role) => {
    setForm({ ...form, role, payroll: isPayrollRole(role) ? form.payroll : '' });
  };

  const handlePayrollEmployeeChange = (userId) => {
    const employee = users.find((u) => String(u.id) === String(userId));
    setPayrollForm({
      ...payrollForm,
      user_id: userId,
      amount: employee?.payroll ? String(employee.payroll) : payrollForm.amount,
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (savingUser) return;
    setError('');
    setSavingUser(true);
    try {
      const payload = {
        ...form,
        payroll: isPayrollRole(form.role) ? form.payroll : 0,
      };
      if (editingId) {
        await api.put(`/users/${editingId}`, payload);
      } else {
        await api.post('/users', payload);
      }
      setShowModal(false);
      loadUsers();
    } catch (err) {
      if (err.isAuthError) return;
      setError(err.response?.data?.message || 'Failed to save user');
    } finally {
      setSavingUser(false);
    }
  };

  const handlePayrollSubmit = async (e) => {
    e.preventDefault();
    if (savingPayroll) return;
    setPayrollError('');
    if (!payrollForm.user_id) {
      setPayrollError('Select an employee');
      return;
    }
    try {
      const amount = Number(payrollForm.amount);
      if (!amount || amount <= 0) {
        setPayrollError('Enter a valid amount');
        return;
      }
      setSavingPayroll(true);
      // Update the employee's daily payroll on the user record (this is what the
      // card display reads from via money(u.payroll)).
      await api.put(`/users/${payrollForm.user_id}`, { payroll: amount });
      // Also keep a dated payroll record for history/tracking.
      await api.post('/payrolls', {
        employee_id: Number(payrollForm.user_id),
        period: payrollForm.period,
        amount: amount,
        notes: payrollForm.notes,
      });
      // Refresh so the card shows the updated payroll value immediately.
      const usersRes = await api.get('/users');
      setUsers(usersRes.data);
      const payrollsRes = await api.get('/payrolls');
      setPayrolls(payrollsRes.data);
      setPage(1);
      setShowPayrollModal(false);
    } catch (err) {
      if (err.isAuthError) return;
      setPayrollError(err.response?.data?.message || 'Failed to insert payroll');
    } finally {
      setSavingPayroll(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this user?')) return;
    try {
      await api.delete(`/users/${id}`);
      loadUsers();
    } catch (err) {
      if (err.isAuthError) return;
      alert(err.response?.data?.message || 'Failed to delete user');
    }
  };

  const handleDeletePayroll = async (id) => {
    if (!window.confirm('Delete this payroll record?')) return;
    try {
      await api.delete(`/payrolls/${id}`);
      setPage(1);
      loadUsers();
    } catch (err) {
      if (err.isAuthError) return;
      alert(err.response?.data?.message || 'Failed to delete payroll');
    }
  };

  const money = (val) => formatCurrency(val, settings?.currency);

  const filteredPayrolls = payrolls.filter((payroll) => {
    const period = payroll.period?.length === 7 ? `${payroll.period}-01` : payroll.period;
    return (!appliedPayrollRange.from || period >= appliedPayrollRange.from)
      && (!appliedPayrollRange.to || period <= appliedPayrollRange.to);
  });
  const totalPayrollPages = Math.max(1, Math.ceil(filteredPayrolls.length / PAGE_SIZE));
  const paginatedPayrolls = filteredPayrolls.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900">User Management</h1>
          <p className="mt-1 text-gray-500 text-sm">Manage system users, roles, and payroll for managers and cashiers</p>
        </div>
        {!isDemo && <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <button
            onClick={() => openPayrollModal()}
            disabled={payableUsers.length === 0}
            className="flex-1 sm:flex-none justify-center flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-medium text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
                                    <Wallet size={18} /> Insert Payroll
          </button>
          <button
            onClick={openAddModal}
            className="flex-1 sm:flex-none justify-center flex items-center gap-2 bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-lg font-medium text-sm"
          >
            <Plus size={18} /> Add User
          </button>
        </div>}
      </div>

      {isDemo && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status">
          Demo user records are visible for review. Creating, editing, payroll changes, and deletion are disabled.
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="table-responsive">
          <table className="w-full text-sm min-w-[650px] whitespace-nowrap">
            <thead className="bg-gray-50">
              <tr className="text-left text-gray-500">
                <th className="py-3 px-4">Username</th>
                <th className="py-3 px-4">Full Name</th>
                <th className="py-3 px-4">Email</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Daily Payroll</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-center py-6 text-gray-400">Loading...</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-6 text-gray-400">No users found</td></tr>
              ) : users.map((u) => (
                <tr key={u.id} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="py-3 px-4 font-medium text-gray-800">{u.username}</td>
                  <td className="py-3 px-4">{u.full_name || '-'}</td>
                  <td className="py-3 px-4">{u.email || '-'}</td>
                  <td className="py-3 px-4 capitalize">{u.role}</td>
                  <td className="py-3 px-4">{isPayrollRole(u.role) ? money(u.payroll) : '-'}</td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${u.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex justify-end gap-2">
                      {!isDemo && isPayrollRole(u.role) && (
                        <button onClick={() => openPayrollModal(u)} className="p-2 rounded-lg hover:bg-emerald-50 text-emerald-700" title="Insert payroll" aria-label={`Insert payroll for ${u.full_name || u.username}`}>
                          <Wallet size={16} />
                        </button>
                      )}
                      {!isDemo && (
                        <>
                          <button onClick={() => openEditModal(u)} aria-label={`Edit ${u.username}`} className="p-2 rounded-lg hover:bg-primary-50 text-primary-700">
                            <Pencil size={16} />
                          </button>
                          <button
                            onClick={() => handleDelete(u.id)}
                            aria-label={`Delete ${u.username}`}
                            disabled={u.id === currentUser.id}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
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
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Payroll records</h2>
          <p className="text-gray-500 text-sm">Daily payroll for managers and cashiers</p>
        </div>
        <div className="flex flex-wrap items-end gap-3 px-4 sm:px-6 py-4 border-b border-gray-100">
          <div>
            <label htmlFor="payroll-from" className="block text-xs text-gray-500 mb-1">From</label>
            <input
              id="payroll-from"
              type="date"
              value={payrollFrom}
              max={payrollTo || undefined}
              onChange={(event) => setPayrollFrom(event.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label htmlFor="payroll-to" className="block text-xs text-gray-500 mb-1">To</label>
            <input
              id="payroll-to"
              type="date"
              value={payrollTo}
              min={payrollFrom || undefined}
              onChange={(event) => setPayrollTo(event.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setAppliedPayrollRange({ from: payrollFrom, to: payrollTo });
              setPage(1);
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white"
          >
            <Calendar size={16} /> Filter
          </button>
          {(payrollFrom || payrollTo) && (
            <button
              type="button"
              onClick={() => {
                setPayrollFrom('');
                setPayrollTo('');
                setAppliedPayrollRange({ from: '', to: '' });
                setPage(1);
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50 text-gray-700"
            >
              <RotateCcw size={16} /> Clear
            </button>
          )}
        </div>
        <div className="table-responsive">
          <table className="w-full text-sm min-w-[550px] whitespace-nowrap">
            <thead className="bg-gray-50">
              <tr className="text-left text-gray-500">
                <th className="py-3 px-4">Employee</th>
                <th className="py-3 px-4">Role</th>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Amount</th>
                <th className="py-3 px-4">Notes</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="text-center py-6 text-gray-400">Loading...</td></tr>
              ) : paginatedPayrolls.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-6 text-gray-400">No payroll records yet</td></tr>
              ) : paginatedPayrolls.map((p) => (
                <tr key={p.id} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="py-3 px-4 font-medium text-gray-800">{p.full_name || p.username}</td>
                  <td className="py-3 px-4 capitalize">{p.role}</td>
                  <td className="py-3 px-4">{formatPeriod(p.period)}</td>
                  <td className="py-3 px-4">{money(p.amount)}</td>
                  <td className="py-3 px-4">{p.notes || '-'}</td>
                  <td className="py-3 px-4">
                    <div className="flex justify-end">
                      {!isDemo && (
                        <button onClick={() => handleDeletePayroll(p.id)} aria-label={`Delete payroll for ${p.full_name || p.username}`} className="p-2 rounded-lg hover:bg-red-50 text-red-700">
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
        {filteredPayrolls.length > 0 && (
          <div className="flex items-center justify-between flex-wrap gap-2 px-4 py-3 border-t border-gray-100 text-sm text-gray-600">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filteredPayrolls.length)} of {filteredPayrolls.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous payroll page"
                disabled={page === 1}
                className="p-1.5 rounded-lg border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-gray-600 text-xs sm:text-sm">Page {page} of {totalPayrollPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPayrollPages, p + 1))}
                aria-label="Next payroll page"
                disabled={page === totalPayrollPages}
                className="p-1.5 rounded-lg border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="user-modal-title" className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100">
              <h2 id="user-modal-title" className="font-semibold text-lg text-gray-900">{editingId ? 'Edit User' : 'Add User'}</h2>
              <button type="button" onClick={() => setShowModal(false)} aria-label="Close user form" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 sm:p-6 space-y-4">
              {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2" role="alert">{error}</div>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                <input required disabled={!!editingId} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Password {editingId && <span className="text-xs text-gray-400">(leave blank to keep current)</span>}
                </label>
                <input type="password" required={!editingId} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input type="email" disabled={!editingAdmin} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100 disabled:text-gray-500" />
                {!editingAdmin && <p className="text-xs text-gray-400 mt-1">Managed from the admin account.</p>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                  <select value={form.role} onChange={(e) => handleRoleChange(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                    <option value="admin">Admin</option>
                    <option value="manager">Manager</option>
                    <option value="cashier">Cashier</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                  <select disabled={editingAdmin} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 ${editingAdmin ? 'bg-gray-100 cursor-not-allowed' : ''}`}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                  {editingAdmin && <p className="text-xs text-gray-400 mt-1">Admin status cannot be changed.</p>}
                </div>
              </div>
              {isPayrollRole(form.role) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Daily payroll (PHP)</label>
                  <input type="number" min="0" step="0.01" required value={form.payroll} onChange={(e) => setForm({ ...form, payroll: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100">
                  Cancel
                </button>
                <button type="submit" disabled={savingUser} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-60 disabled:cursor-not-allowed">
                  {savingUser ? 'Saving...' : editingId ? 'Save Changes' : 'Add User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showPayrollModal && (
        <div className="fixed inset-0 bg-gray-950/45 flex items-center justify-center z-50 p-3 sm:p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="payroll-modal-title" className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100">
              <h2 id="payroll-modal-title" className="font-semibold text-lg text-gray-900">Insert Payroll</h2>
              <button type="button" onClick={() => setShowPayrollModal(false)} aria-label="Close payroll form" className="p-2 rounded-lg text-gray-500 hover:bg-gray-100">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handlePayrollSubmit} className="p-4 sm:p-6 space-y-4">
              {payrollError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2" role="alert">{payrollError}</div>}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Employee</label>
                <select required value={payrollForm.user_id} onChange={(e) => handlePayrollEmployeeChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  <option value="">Select manager or cashier</option>
                  {payableUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name || u.username} ({u.role})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Pay date</label>
                <input type="date" required value={payrollForm.period} onChange={(e) => setPayrollForm({ ...payrollForm, period: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount (PHP)</label>
                <input type="number" min="0.01" step="0.01" required value={payrollForm.amount} onChange={(e) => setPayrollForm({ ...payrollForm, amount: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <input value={payrollForm.notes} onChange={(e) => setPayrollForm({ ...payrollForm, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowPayrollModal(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100">
                  Cancel
                </button>
                <button type="submit" disabled={savingPayroll} className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-60 disabled:cursor-not-allowed">
                  {savingPayroll ? 'Saving...' : 'Insert Payroll'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
