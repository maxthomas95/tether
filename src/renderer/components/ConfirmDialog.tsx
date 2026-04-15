import { useState, useCallback, useEffect, useRef } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmDialogProps extends ConfirmOptions {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEscapeKey(onCancel, isOpen);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const id = requestAnimationFrame(() => confirmRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="dialog-overlay"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 400 }}>
        <div className="dialog-header">
          <span>{title}</span>
          <button className="dialog-close" onClick={onCancel}>&times;</button>
        </div>
        <div className="dialog-body" style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {message}
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onCancel}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={`form-btn ${danger ? 'form-btn--danger' : 'form-btn--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    setPending((prev) => {
      prev?.resolve(true);
      return null;
    });
  }, []);

  const handleCancel = useCallback(() => {
    setPending((prev) => {
      prev?.resolve(false);
      return null;
    });
  }, []);

  const dialogProps: ConfirmDialogProps = {
    isOpen: pending !== null,
    title: pending?.title ?? '',
    message: pending?.message ?? '',
    confirmLabel: pending?.confirmLabel,
    cancelLabel: pending?.cancelLabel,
    danger: pending?.danger,
    onConfirm: handleConfirm,
    onCancel: handleCancel,
  };

  return { confirm, dialogProps };
}
