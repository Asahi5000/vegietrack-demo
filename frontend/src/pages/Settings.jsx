import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';

const FIXED_CURRENCY = 'PHP';

export default function Settings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState({ store_name: '', store_address: '', currency: FIXED_CURRENCY, tax_rate: '0' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');

  const loadSettings = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await api.get('/settings');
      setSettings((prev) => ({ ...prev, ...res.data, currency: FIXED_CURRENCY }));
    } catch (err) {
      if (!err.isAuthError) setLoadError('Unable to load settings. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSettings(); }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      await api.put('/settings', settings);
      setMessage('Settings saved successfully');
    } catch (err) {
      if (err.isAuthError) return;
      setMessage(err.response?.data?.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500" role="status">Loading settings...</div>;

  const isAdmin = user?.role === 'admin' && !user?.demo_mode;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900">Settings</h1>
        <p className="mt-1 text-gray-500 text-sm">Configure your store and application preferences</p>
      </div>

      <form onSubmit={handleSave} className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 sm:p-6 space-y-4">
        {loadError && (
          <div className="flex flex-wrap items-center justify-between gap-2 bg-red-50 border border-red-200 text-red-800 text-sm rounded-lg px-3 py-2" role="alert">
            <span>{loadError}</span>
            <button type="button" onClick={loadSettings} className="font-semibold underline underline-offset-2">Retry</button>
          </div>
        )}
        {message && (
          <div className={`${message.startsWith('Failed') ? 'bg-red-50 border-red-200 text-red-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'} border text-sm rounded-lg px-3 py-2`} role={message.startsWith('Failed') ? 'alert' : 'status'}>
            {message}
          </div>
        )}
        {user?.demo_mode ? (
          <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg px-3 py-2">
            Settings are read-only in the public demo.
          </div>
        ) : !isAdmin && (
          <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm rounded-lg px-3 py-2">
            Only administrators can modify these settings.
          </div>
        )}
        <div>
          <label htmlFor="store-name" className="block text-sm font-medium text-gray-700 mb-1">Store Name</label>
          <input id="store-name" disabled={!isAdmin} value={settings.store_name || ''} onChange={(e) => setSettings({ ...settings, store_name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100" />
        </div>
        <div>
          <label htmlFor="store-address" className="block text-sm font-medium text-gray-700 mb-1">Store Address</label>
          <input id="store-address" disabled={!isAdmin} value={settings.store_address || ''} onChange={(e) => setSettings({ ...settings, store_address: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="store-currency" className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
            <input id="store-currency" disabled value={FIXED_CURRENCY}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100" />
          </div>
          <div>
            <label htmlFor="tax-rate" className="block text-sm font-medium text-gray-700 mb-1">Tax Rate (%)</label>
            <input id="tax-rate" disabled={!isAdmin} type="number" step="0.01" value={settings.tax_rate || ''} onChange={(e) => setSettings({ ...settings, tax_rate: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-100" />
          </div>
        </div>
        {isAdmin && (
          <div className="flex justify-end pt-2">
            <button type="submit" disabled={saving} className="flex items-center justify-center w-full sm:w-auto gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-60">
              <Save size={16} /> {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
