import { useCallback, useEffect, useState } from 'react';
import type { Notification } from '@trf/shared';
import { formatDate } from './Badges';
import { Icons } from './Icons';

interface NotificationCentreProps {
  /** Optional TRF ID to filter notifications */
  trfId?: number;
  /** Whether to show only unread notifications */
  unreadOnly?: boolean;
}

interface NotificationsResponse {
  items: Notification[];
  unreadCount: number;
}

export function NotificationCentre({ trfId, unreadOnly = false }: NotificationCentreProps) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markingAllRead, setMarkingAllRead] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (unreadOnly) params.set('unread', 'true');
    if (trfId) params.set('trfId', String(trfId));
    
    const res = await window.trf.request<NotificationsResponse>({
      method: 'GET', path: `/api/notifications?${params.toString()}`,
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not load notifications.');
      return;
    }
    setNotifications(res.data?.items ?? []);
  }, [trfId, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markAsRead(id: number) {
    const res = await window.trf.request({
      method: 'PUT', path: `/api/notifications/${id}/read`,
    });
    if (res.ok) {
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n));
    }
  }

  async function markAllAsRead() {
    setMarkingAllRead(true);
    try {
      // Mark all unread notifications as read
      const unreadNotifications = notifications.filter(n => !n.isRead);
      await Promise.all(unreadNotifications.map(n => 
        window.trf.request({ method: 'PUT', path: `/api/notifications/${n.id}/read` })
      ));
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true, readAt: new Date().toISOString() })));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMarkingAllRead(false);
    }
  }

  const unreadCount = notifications.filter(n => !n.isRead).length;

  if (loading && notifications.length === 0) {
    return <div className="notification-centre"><p className="muted">Loading notifications…</p></div>;
  }

  return (
    <div className="notification-centre">
      <div className="notification-centre__header">
        <h3 className="notification-centre__title">
          Notifications
          {unreadCount > 0 && (
            <span className="notification-badge">
              <span className="notification-badge__count">{unreadCount}</span>
            </span>
          )}
        </h3>
        <div className="notification-centre__actions">
          {unreadCount > 0 && (
            <button 
              className="btn btn--tiny btn--primary" 
              onClick={markAllAsRead} 
              disabled={markingAllRead}
            >
              {markingAllRead ? 'Marking…' : 'Mark all as read'}
            </button>
          )}
        </div>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      {notifications.length === 0 ? (
        <div className="notification-empty">
          {unreadOnly 
            ? 'No unread notifications.' 
            : 'No notifications yet. You will be notified when tests are assigned to you.'}
        </div>
      ) : (
        <ul className="notification-list" role="list" aria-label="Notifications">
          {notifications.map((notification) => (
            <li 
              key={notification.id} 
              className={`notification-item ${notification.isRead ? 'read' : 'unread'}`}
              role="listitem"
            >
              {(!notification.isRead || !trfId) && (
                <button
                  className="btn btn--tiny"
                  style={{ float: 'right', marginBottom: '4px' }}
                  onClick={() => markAsRead(notification.id)}
                  disabled={notification.isRead}
                  aria-label={notification.isRead ? 'Already read' : 'Mark as read'}
                >
                  {notification.isRead ? 'Read' : 'Mark as read'}
                </button>
              )}
              <div className="notification-item__header">
                <span className="notification-item__title">{notification.title}</span>
                <span className="notification-item__time">
                  {notification.createdAt ? formatDate(notification.createdAt) : ''}
                </span>
              </div>
              <div className="notification-item__body">{notification.body}</div>
              <div className="notification-item__meta">
                {notification.relatedTrfId && (
                  <span>TRF: {notification.relatedTrfId}</span>
                )}
                {notification.type && (
                  <span>Type: {notification.type}</span>
                )}
              </div>
              {notification.link && (
                <div className="notification-item__action">
                  <a className="btn btn--tiny btn--primary" href={notification.link}>
                    {Icons.arrowRight} View Assignment
                  </a>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}