import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/axios';
import { useAuth } from './AuthContext';
import { DashboardDataContext } from './DashboardDataContext';

const POLL_INTERVAL = 60000;
const MAX_NOTIFICATION_HISTORY = 100;

const emptyNotificationState = () => ({ records: [], shownIds: [] });

function readNotificationState(storageKey) {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return emptyNotificationState();

  try {
    const parsed = JSON.parse(saved);
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      shownIds: Array.isArray(parsed.shownIds) ? parsed.shownIds : [],
    };
  } catch {
    return emptyNotificationState();
  }
}

function mapNotifications(data) {
  const stock = Array.isArray(data.notifications) ? data.notifications : [];
  const spoiled = Array.isArray(data.spoiled_notifications) ? data.spoiled_notifications : [];

  return [...stock, ...spoiled].map((item) => {
    const type = item.type || 'system';
    const productId = item.product_id ?? 'unknown';
    const baseId = `inventory:${type}:${productId}`;
    const title = ({
      low_stock: 'Low Stock Alert',
      out_of_stock: 'Out of Stock',
      expiring_soon: 'Expiring Soon',
      spoiled: 'Spoiled Product Alert',
    })[type] || 'Inventory Alert';

    return {
      id: baseId,
      baseId,
      type,
      productId: item.product_id ?? null,
      title,
      message: item.message || 'An inventory alert needs your attention.',
    };
  });
}

export function DashboardDataProvider({ children }) {
  const { user } = useAuth();
  const storageKey = `vegietrack_notification_state_${user?.id || user?.username || 'user'}`;
  const [salesPeriod, setSalesPeriod] = useState('daily');
  const [topProductsPeriod, setTopProductsPeriod] = useState('daily');
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notificationState, setNotificationState] = useState(() => readNotificationState(storageKey));
  const [popupQueue, setPopupQueue] = useState([]);
  const notificationStateRef = useRef(notificationState);
  const requestRef = useRef(null);

  const saveNotificationState = useCallback((nextState) => {
    notificationStateRef.current = nextState;
    setNotificationState(nextState);
    localStorage.setItem(storageKey, JSON.stringify(nextState));
  }, [storageKey]);

  const fetchDashboard = useCallback(() => {
    const requestKey = `${salesPeriod}:${topProductsPeriod}`;
    if (requestRef.current?.key === requestKey) return requestRef.current.promise;

    const requestEntry = { key: requestKey, promise: null };
    requestEntry.promise = (async () => {
      try {
        const response = await api.get('/reports/dashboard', {
          params: { sales_period: salesPeriod, top_products_period: topProductsPeriod },
        });
        setDashboardData(response.data);
        setError('');

        const currentState = notificationStateRef.current;
        const existingIds = new Set(currentState.records.map((item) => item.id));
        const shownIds = new Set(currentState.shownIds);
        const now = new Date().toISOString();
        const incoming = mapNotifications(response.data).map((item) => {
          const matchingBase = (record) => (record.baseId || record.id) === item.baseId;
          const activeRecord = currentState.records.find((record) => matchingBase(record) && record.active);
          const hasHistory = currentState.records.some(matchingBase);
          const id = activeRecord?.id || (hasHistory ? `${item.baseId}:${now}` : item.baseId);
          return {
            ...item,
            id,
            detectedAt: activeRecord?.detectedAt || now,
            active: true,
          };
        });
        const incomingIds = new Set(incoming.map((item) => item.id));
        const newRecords = incoming.filter((item) => !existingIds.has(item.id));
        const recordsById = new Map(currentState.records.map((item) => [item.id, item]));

        incoming.forEach((item) => {
          const previous = recordsById.get(item.id);
          recordsById.set(item.id, { ...previous, ...item, read: previous?.read ?? false });
        });
        const nextRecords = [...recordsById.values()]
          .map((item) => incomingIds.has(item.id) ? item : { ...item, active: false })
          .sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
          .slice(0, MAX_NOTIFICATION_HISTORY);

        const newIds = newRecords.map((item) => item.id).filter((id) => !shownIds.has(id));
        const nextShownIds = [...new Set([...currentState.shownIds, ...newIds])].slice(-MAX_NOTIFICATION_HISTORY);
        const changed = JSON.stringify(currentState.records) !== JSON.stringify(nextRecords)
          || JSON.stringify(currentState.shownIds) !== JSON.stringify(nextShownIds);
        if (changed) saveNotificationState({ records: nextRecords, shownIds: nextShownIds });
        setPopupQueue((queue) => {
          const queuedIds = queue.map((item) => item.id).filter((id) => incomingIds.has(id));
          const ids = [...queuedIds, ...newIds.filter((id) => !queuedIds.includes(id))];
          return ids.map((id, index) => ({ id, position: index + 1, total: ids.length }));
        });
      } catch (requestError) {
        if (!requestError.isAuthError) setError('Failed to load dashboard data');
      } finally {
        setLoading(false);
        if (requestRef.current === requestEntry) requestRef.current = null;
      }
    })();
    requestRef.current = requestEntry;
    return requestEntry.promise;
  }, [salesPeriod, topProductsPeriod, saveNotificationState]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) fetchDashboard();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('stockUpdated', fetchDashboard);
    const interval = window.setInterval(fetchDashboard, POLL_INTERVAL);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('stockUpdated', fetchDashboard);
      window.clearInterval(interval);
    };
  }, [fetchDashboard]);

  const notifications = notificationState.records.filter((item) => item.active);
  const unreadCount = notifications.filter((item) => !item.read).length;

  const markAsRead = useCallback((id) => {
    const state = notificationStateRef.current;
    if (!state.records.some((item) => item.id === id && !item.read)) return;
    saveNotificationState({
      ...state,
      records: state.records.map((item) => item.id === id ? { ...item, read: true } : item),
    });
  }, [saveNotificationState]);

  const markAllAsRead = useCallback(() => {
    const state = notificationStateRef.current;
    if (!state.records.some((item) => !item.read)) return;
    saveNotificationState({
      ...state,
      records: state.records.map((item) => ({ ...item, read: true })),
    });
  }, [saveNotificationState]);

  const dismissPopup = useCallback(() => {
    setPopupQueue((queue) => queue.slice(1));
  }, []);

  const value = useMemo(() => ({
    dashboardData,
    loading,
    error,
    fetchDashboard,
    salesPeriod,
    setSalesPeriod,
    topProductsPeriod,
    setTopProductsPeriod,
    notifications,
    unreadCount,
    popupQueue,
    markAsRead,
    markAllAsRead,
    dismissPopup,
  }), [
    dashboardData, loading, error, fetchDashboard, salesPeriod, topProductsPeriod,
    notifications, unreadCount, popupQueue, markAsRead, markAllAsRead, dismissPopup,
  ]);

  return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>;
}
