import { useCallback, useEffect, useRef, useState } from 'react';
import type { Notification } from '@trf/shared';

const POLL_INTERVAL_MS = 30_000;

export interface NotificationList {
  items: Notification[];
  unreadCount: number;
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<NotificationList>({ items: [], unreadCount: 0 });
  const [loading, setLoading] = useState(true);
  const hasPlayedSound = useRef<Set<number>>(new Set());

  const load = useCallback(async () => {
    const res = await window.trf.request<{ items: Notification[]; unreadCount: number }>({
      method: 'GET', path: '/api/notifications',
    });
    if (res.ok && res.data) {
      setNotifications({ items: res.data.items, unreadCount: res.data.unreadCount });
    } else {
      console.error('Failed to load notifications', res);
    }
    setLoading(false);
  }, []);

  const markRead = useCallback(async (id: number) => {
    await window.trf.request({ method: 'PUT', path: `/api/notifications/${id}/read` });
    setNotifications((prev) => ({
      items: prev.items.map((n) => n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n),
      unreadCount: Math.max(prev.unreadCount - 1, 0),
    }));
  }, []);

  const markAllRead = useCallback(async () => {
    const unread = notifications.items.filter((n) => !n.isRead);
    await Promise.all(unread.map((n) => markRead(n.id)));
  }, [notifications.items, markRead]);

  // Play a sound once per new unread notification.
  useEffect(() => {
    const prevIds = hasPlayedSound.current;
    let newCount = 0;
    for (const n of notifications.items) {
      if (!n.isRead && !prevIds.has(n.id)) {
        prevIds.add(n.id);
        newCount++;
      }
    }
    if (newCount > 0) {
      void import('./sound').then((m) => m.playNotificationSound());
    }
  }, [notifications.items]);

  useEffect(() => {
    load();
    const interval = window.setInterval(load, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [load]);

  return { notifications: notifications.items, unreadCount: notifications.unreadCount, loading, markRead, markAllRead, refresh: load };
}
