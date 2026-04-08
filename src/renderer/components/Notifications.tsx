import { useCallback, useEffect, useState } from 'react';

export interface Notification {
  id: string;
  type: 'error' | 'info' | 'success';
  title: string;
  message?: string;
}

export interface NotifyOptions {
  type?: Notification['type'];
  title: string;
  message?: string;
}

let notificationCounter = 0;

/**
 * Tiny toast/notification stack. Errors auto-dismiss after 12s,
 * info/success after 5s. Click to dismiss early.
 */
export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const dismiss = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  const notify = useCallback((opts: NotifyOptions): string => {
    const id = `notif-${++notificationCounter}`;
    const next: Notification = {
      id,
      type: opts.type || 'info',
      title: opts.title,
      message: opts.message,
    };
    setNotifications(prev => [...prev, next]);
    return id;
  }, []);

  return { notifications, notify, dismiss };
}

interface NotificationsProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
}

export function Notifications({ notifications, onDismiss }: NotificationsProps) {
  return (
    <div className="notification-stack" role="status" aria-live="polite">
      {notifications.map(n => (
        <NotificationItem key={n.id} notification={n} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function NotificationItem({ notification, onDismiss }: { notification: Notification; onDismiss: (id: string) => void }) {
  const ttl = notification.type === 'error' ? 12000 : 5000;

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(notification.id), ttl);
    return () => clearTimeout(timer);
  }, [notification.id, ttl, onDismiss]);

  return (
    <div className={`notification notification--${notification.type}`}>
      <div className="notification-body">
        <div className="notification-title">{notification.title}</div>
        {notification.message && (
          <div className="notification-message">{notification.message}</div>
        )}
      </div>
      <button
        className="notification-close"
        onClick={() => onDismiss(notification.id)}
        aria-label="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}
