import { useRef } from 'react';
import { onKeyActivate, stopPropagationOnKey } from '../utils/a11y';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { KeybindingsEditor } from './KeybindingsEditor';
import type { KeybindingAction, Chord } from '../../shared/keybindings';

interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  bindings: Record<KeybindingAction, Chord | null>;
  onChange: (action: KeybindingAction, chord: Chord | null) => void;
  onResetAll: () => void;
}

export function KeyboardShortcutsDialog({ isOpen, onClose, bindings, onChange, onResetAll }: Readonly<KeyboardShortcutsDialogProps>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen);
  if (!isOpen) return null;

  return (
    <div className="dialog-overlay" onClick={onClose} onKeyDown={onKeyActivate(onClose)} role="button" tabIndex={-1}>
      <div ref={dialogRef} className="dialog dialog--wide" onClick={e => e.stopPropagation()} onKeyDown={stopPropagationOnKey} role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" tabIndex={-1}>
        <div className="dialog-header">
          <span>Keyboard Shortcuts</span>
          <button className="dialog-close" aria-label="Close dialog" onClick={onClose}>&times;</button>
        </div>
        <div className="dialog-body">
          <KeybindingsEditor bindings={bindings} onChange={onChange} />
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onResetAll} type="button">Reset all to defaults</button>
          <button className="form-btn form-btn--primary" onClick={onClose} type="button">Close</button>
        </div>
      </div>
    </div>
  );
}
