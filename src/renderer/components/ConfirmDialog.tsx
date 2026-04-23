import { useState, useCallback, useEffect, useRef } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  checkbox?: {
    label: string;
    hint?: string;
    defaultChecked?: boolean;
  };
}

interface ConfirmDialogProps extends ConfirmOptions {
  isOpen: boolean;
  onConfirm: (checkboxValue: boolean) => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  danger,
  checkbox,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [checked, setChecked] = useState(checkbox?.defaultChecked ?? false);
  useEscapeKey(onCancel, isOpen);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setChecked(checkbox?.defaultChecked ?? false);
    const id = requestAnimationFrame(() => confirmRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [isOpen, checkbox?.defaultChecked]);

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
        {checkbox && (
          <div className="dialog-body" style={{ paddingTop: 0 }}>
            <label className="form-radio-label" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />
              <span>{checkbox.label}</span>
            </label>
            {checkbox.hint && <span className="form-hint" style={{ display: 'block', marginTop: 4 }}>{checkbox.hint}</span>}
          </div>
        )}
        <div className="dialog-footer">
          <button className="form-btn" onClick={onCancel}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={`form-btn ${danger ? 'form-btn--danger' : 'form-btn--primary'}`}
            onClick={() => onConfirm(checked)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: { confirmed: boolean; checkboxValue: boolean }) => void;
}

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<{ confirmed: boolean; checkboxValue: boolean }> => {
    return new Promise((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const handleConfirm = useCallback((checkboxValue: boolean) => {
    setPending((prev) => {
      prev?.resolve({ confirmed: true, checkboxValue });
      return null;
    });
  }, []);

  const handleCancel = useCallback(() => {
    setPending((prev) => {
      prev?.resolve({ confirmed: false, checkboxValue: false });
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
    checkbox: pending?.checkbox,
    onConfirm: handleConfirm,
    onCancel: handleCancel,
  };

  return { confirm, dialogProps };
}
