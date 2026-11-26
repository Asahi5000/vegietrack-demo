import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bell, Check, CheckCheck, ChevronRight, PackageX, X } from 'lucide-react';
import { useDashboardData } from '../context/DashboardDataContext';

const notificationStyles = {
  low_stock: { icon: AlertTriangle, badge: 'Low stock', classes: 'bg-amber-50 text-amber-800 ring-amber-200' },
  out_of_stock: { icon: PackageX, badge: 'Out of stock', classes: 'bg-red-50 text-red-800 ring-red-200' },
  expiring_soon: { icon: AlertTriangle, badge: 'Expiring soon', classes: 'bg-orange-50 text-orange-800 ring-orange-200' },
  spoiled: { icon: PackageX, badge: 'Spoiled product', classes: 'bg-orange-50 text-orange-800 ring-orange-200' },
  inventory_alert: { icon: AlertTriangle, badge: 'Inventory alert', classes: 'bg-amber-50 text-amber-800 ring-amber-200' },
  system: { icon: Bell, badge: 'System', classes: 'bg-primary-50 text-primary-800 ring-primary-200' },
};

function AlertBadge({ type }) {
  const style = notificationStyles[type] || notificationStyles.system;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${style.classes}`}>
      <Icon size={13} aria-hidden="true" />
      {style.badge}
    </span>
  );
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recently detected' : date.toLocaleString();
}

export default function NotificationCenter() {
  const navigate = useNavigate();
  const {
    error,
    loading,
    notifications,
    unreadCount,
    popupQueue,
    fetchDashboard,
    markAsRead,
    markAllAsRead,
    dismissPopup,
  } = useDashboardData();
  const [open, setOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState(null);
  const triggerRef = useRef(null);
  const dropdownRef = useRef(null);
  const popupCloseRef = useRef(null);
  const previousPopupIdRef = useRef(null);

  const notificationById = useMemo(
    () => new Map(notifications.map((item) => [item.id, item])),
    [notifications],
  );
  const activePopup = popupQueue[0];
  const activePopupId = activePopup?.id;
  const currentPopup = activePopup ? notificationById.get(activePopup.id) : null;

  useEffect(() => {
    if (activePopupId) {
      popupCloseRef.current?.focus();
      previousPopupIdRef.current = activePopupId;
    } else if (previousPopupIdRef.current) {
      previousPopupIdRef.current = null;
      triggerRef.current?.focus();
    }
  }, [activePopupId]);

  useEffect(() => {
    if (!open) return undefined;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const headerBottom = trigger.closest('header')?.getBoundingClientRect().bottom || bounds.bottom;
      const top = Math.max(bounds.bottom + 8, headerBottom + 8);
      const panelWidth = Math.max(0, Math.min(400, window.innerWidth - 24, bounds.right - 12));
      setDropdownPosition({
        top,
        right: Math.max(12, window.innerWidth - bounds.right),
        width: panelWidth,
        maxHeight: `calc(100dvh - ${top + 12}px)`,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!activePopupId) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [activePopupId]);

  useEffect(() => {
    if (!open && !activePopupId) return undefined;
    const handlePointerDown = (event) => {
      if (
        open
        && !triggerRef.current?.contains(event.target)
        && !dropdownRef.current?.contains(event.target)
      ) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (activePopupId) dismissPopup();
        else setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, activePopupId, dismissPopup]);

  const viewDetails = (notification, fromPopup = false) => {
    if (notification?.id) markAsRead(notification.id);
    setOpen(false);
    if (fromPopup) dismissPopup();
    if (notification?.productId) {
      navigate('/inventory', { state: { notificationProductId: notification.productId } });
    } else {
      navigate('/inventory');
    }
  };

  const dismissCurrent = () => {
    dismissPopup();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative inline-flex min-h-10 min-w-10 items-center justify-center rounded-xl text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-offset-1"
      >
        <Bell size={20} strokeWidth={1.9} aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-[19px] min-w-[19px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white" aria-hidden="true">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && dropdownPosition && createPortal(
        <div
          ref={dropdownRef}
          role="dialog"
          aria-label="Notifications"
          style={{
            position: 'fixed',
            top: dropdownPosition.top,
            right: dropdownPosition.right,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
            zIndex: 60,
          }}
          className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3.5">
            <div>
              <h2 className="font-semibold text-gray-900">Notifications</h2>
              <p className="mt-0.5 text-xs text-gray-500">{unreadCount} unread</p>
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllAsRead}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-primary-700 hover:bg-primary-50"
              >
                <CheckCheck size={14} aria-hidden="true" /> Mark all read
              </button>
            )}
          </div>

          {loading && notifications.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500" role="status">Loading notifications...</div>
          ) : error && notifications.length === 0 ? (
            <div className="p-5 text-center">
              <p className="text-sm text-red-700" role="alert">Unable to load notifications.</p>
              <button type="button" onClick={fetchDashboard} className="mt-2 text-sm font-medium text-primary-700 hover:underline">
                Try again
              </button>
            </div>
          ) : notifications.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-gray-100 text-gray-500">
                <Bell size={20} aria-hidden="true" />
              </span>
              <p className="mt-3 text-sm font-medium text-gray-800">No new notifications</p>
              <p className="mt-1 text-xs text-gray-500">You’re all caught up.</p>
            </div>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {notifications.map((notification) => (
                <li key={notification.id} className={`border-b border-gray-100 last:border-0 ${notification.read ? '' : 'bg-primary-50/50'}`}>
                  <div className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <AlertBadge type={notification.type} />
                        {!notification.read && <span className="h-2 w-2 rounded-full bg-primary-600" aria-label="Unread" />}
                      </div>
                      {notification.active
                        ? <span className="text-[11px] font-medium text-gray-500">Active</span>
                        : <span className="text-[11px] text-gray-400">Resolved</span>}
                    </div>
                    <p className="mt-2 text-sm font-semibold text-gray-900">{notification.title}</p>
                    <p className="mt-1 text-sm leading-5 text-gray-600">{notification.message}</p>
                    <p className="mt-2 text-[11px] text-gray-400">{formatDateTime(notification.detectedAt)}</p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => viewDetails(notification)}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-primary-700 hover:text-primary-900"
                      >
                        View details <ChevronRight size={14} aria-hidden="true" />
                      </button>
                      {!notification.read && (
                        <button
                          type="button"
                          onClick={() => markAsRead(notification.id)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                        >
                          <Check size={13} aria-hidden="true" /> Mark as read
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>,
        document.body,
      )}

      {currentPopup && createPortal(
        <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto bg-gray-950/45 p-4 backdrop-blur-[1px]" role="presentation">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="new-notification-title"
            aria-describedby="new-notification-message"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const focusable = event.currentTarget.querySelectorAll('button:not(:disabled)');
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
            className="relative z-[100] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[480px] animate-notification-in overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-2xl"
          >
            <div className="flex items-start gap-3 border-b border-gray-100 px-4 py-4 sm:px-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                <AlertTriangle size={21} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 break-words">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="new-notification-title" className="font-semibold text-gray-900">New Alert</h2>
                  {activePopup.total > 1 && (
                    <span className="text-xs text-gray-500">{activePopup.position} of {activePopup.total}</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">{formatDateTime(currentPopup.detectedAt)}</p>
              </div>
              <button ref={popupCloseRef} type="button" onClick={dismissCurrent} aria-label="Dismiss notification" className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-offset-1">
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="space-y-3 break-words px-4 py-4 sm:px-5">
              <AlertBadge type={currentPopup.type} />
              <div>
                <h3 className="break-words font-semibold text-gray-900">{currentPopup.title}</h3>
                <p id="new-notification-message" className="mt-1 text-sm leading-6 text-gray-600">{currentPopup.message}</p>
              </div>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-gray-100 bg-gray-50/70 px-4 py-4 sm:flex-row sm:justify-end sm:px-5">
              <button
                type="button"
                onClick={dismissCurrent}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {popupQueue.length > 1 ? 'Dismiss' : 'Close'}
              </button>
              <button
                type="button"
                onClick={() => viewDetails(currentPopup, true)}
                className="rounded-lg bg-primary-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-800"
              >
                View details
              </button>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
