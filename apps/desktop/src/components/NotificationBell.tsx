import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Notification } from '@trf/shared';
import { useNotifications } from '../lib/notifications';
import { Icons } from './Icons';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { notifications, unreadCount, loading, markRead, markAllRead } = useNotifications();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const unread = notifications.filter((n) => !n.isRead);

  return (
    <div className="notification-bell">
      <button
        ref={buttonRef}
        type="button"
        className="notification-bell__btn"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
        title="Notifications"
        onClick={() => setOpen(!open)}
      >
        {Icons.bell}
        {unreadCount > 0 && <span className="notification-bell__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      {open && (
        <>
          <div
            className="notification-bell__backdrop"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            className="notification-bell__panel"
            role="dialog"
            aria-label="Notifications"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="notification-bell__head">
              <strong>Notifications</strong>
              {unread.length > 0 && (
                <button type="button" className="notification-bell__mark-all" onClick={() => void markAllRead()}>
                  Mark all read
                </button>
              )}
            </div>

            {loading && notifications.length === 0 ? (
              <p className="muted" style={{ padding: '8px 12px' }}>Loading…</p>
            ) : notifications.length === 0 ? (
              <p className="muted" style={{ padding: '8px 12px' }}>No notifications yet.</p>
            ) : (
              <ul className="notification-bell__list">
                {notifications.map((n) => (
                  <NotificationItem key={n.id} notification={n} markRead={markRead} onNavigate={(n) => {
                    setOpen(false);
                    if (n.relatedTrfId) navigate(`/trfs/${n.relatedTrfId}`);
                  }} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface NotificationItemProps {
  notification: Notification;
  markRead: (id: number) => void;
  onNavigate: (n: Notification) => void;
}

function NotificationItem({ notification, markRead, onNavigate }: NotificationItemProps) {
  return (
    <li
      className={`notification-bell__item ${notification.isRead ? '' : 'notification-bell__item--unread'}`}
      onClick={() => {
        if (!notification.isRead) void markRead(notification.id);
        onNavigate(notification);
      }}
    >
      <span className="notification-bell__title">{notification.title}</span>
      <span className="notification-bell__body">{notification.body}</span>
      <span className="notification-bell__time">{new Date(notification.createdAt).toLocaleString()}</span>
    </li>
  );
}
