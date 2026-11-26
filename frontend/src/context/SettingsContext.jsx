import { createContext, useContext, useEffect, useState } from 'react';
import api from '../api/axios';
import { useAuth } from './AuthContext';

const SettingsContext = createContext(null);
const FIXED_CURRENCY = 'PHP';

export function SettingsProvider({ children }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState({ store_name: '', store_address: '', currency: FIXED_CURRENCY, tax_rate: '0' });

  useEffect(() => {
    if (!user) return;
    api.get('/settings')
      .then((res) => setSettings((prev) => ({ ...prev, ...res.data, currency: FIXED_CURRENCY })))
      .catch(() => {});
  }, [user]);

  return (
    <SettingsContext.Provider value={{ settings, setSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
