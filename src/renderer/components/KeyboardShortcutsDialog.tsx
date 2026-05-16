import { Fragment, useEffect, useMemo, useState } from 'react';
import { onKeyActivate, stopPropagationOnKey } from '../utils/a11y';
import {
  ALL_ACTIONS,
  ACTION_LABELS,
  ACTION_GROUPS,
  ACTION_GROUP_ORDER,
  DEFAULT_KEYBINDINGS,
  formatChord,
  parseKeyEvent,
  chordEquals,
  findConflicts,
  getReservedReason,
  type KeybindingAction,
  type Chord,
  type ActionGroup,
} from '../../shared/keybindings';

interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  bindings: Record<KeybindingAction, Chord | null>;
  onChange: (action: KeybindingAction, chord: Chord | null) => void;
  onResetAll: () => void;
}

function isPureUnmodifiedLetter(chord: Chord): boolean {
  if (chord.includes('+')) return false;
  return chord.length === 1 && /^[a-z0-9]$/i.test(chord);
}

export function KeyboardShortcutsDialog({ isOpen, onClose, bindings, onChange, onResetAll }: KeyboardShortcutsDialogProps) {
  const [recording, setRecording] = useState<KeybindingAction | null>(null);

  useEffect(() => {
    if (!isOpen) setRecording(null);
  }, [isOpen]);

  useEffect(() => {
    if (!recording) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }

      const chord = parseKeyEvent(e);
      if (!chord) return;

      if (isPureUnmodifiedLetter(chord)) return;

      onChange(recording, chord);
      setRecording(null);
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recording, onChange]);

  const conflicts = useMemo(() => findConflicts(bindings), [bindings]);
  const conflictByAction = useMemo(() => {
    const map = new Map<KeybindingAction, KeybindingAction[]>();
    for (const c of conflicts) {
      for (const a of c.actions) {
        map.set(a, c.actions.filter(x => x !== a));
      }
    }
    return map;
  }, [conflicts]);

  const groupedActions = useMemo(() => {
    const grouped = new Map<ActionGroup, KeybindingAction[]>();
    for (const action of ALL_ACTIONS) {
      const g = ACTION_GROUPS[action];
      const list = grouped.get(g);
      if (list) list.push(action);
      else grouped.set(g, [action]);
    }
    return grouped;
  }, []);

  if (!isOpen) return null;

  const handleClose = () => {
    setRecording(null);
    onClose();
  };

  const renderRow = (action: KeybindingAction) => {
    const chord = bindings[action];
    const isOverridden = !chordEquals(chord, DEFAULT_KEYBINDINGS[action]);
    const isRecording = recording === action;
    const conflictWith = conflictByAction.get(action);
    const reservedReason = getReservedReason(chord);

    return (
      <tr key={action}>
        <td className="shortcuts-action">{ACTION_LABELS[action]}</td>
        <td className="shortcuts-key">
          {isRecording ? (
            <span className="shortcut-recording">Press a key… (Esc to cancel)</span>
          ) : chord ? (
            <span className="shortcut-chord-cell">
              <kbd>{formatChord(chord)}</kbd>
              {reservedReason && (
                <span className="shortcut-reserved" title={`Reserved: ${reservedReason}`} aria-label={`Reserved: ${reservedReason}`}>⚠</span>
              )}
            </span>
          ) : (
            <span className="shortcut-unbound">— unbound —</span>
          )}
          {conflictWith && conflictWith.length > 0 && !isRecording && (
            <div className="shortcut-conflict">
              Conflicts with: {conflictWith.map(a => ACTION_LABELS[a]).join(', ')}
            </div>
          )}
        </td>
        <td className="shortcut-actions-cell">
          <button
            className="form-btn shortcut-btn"
            onClick={() => setRecording(isRecording ? null : action)}
            type="button"
          >
            {isRecording ? 'Cancel' : 'Record'}
          </button>
          {chord !== null && (
            <button
              className="form-btn shortcut-btn"
              onClick={() => onChange(action, null)}
              type="button"
              title="Unbind this shortcut"
            >
              Unbind
            </button>
          )}
          {isOverridden && (
            <button
              className="form-btn shortcut-btn"
              onClick={() => onChange(action, DEFAULT_KEYBINDINGS[action])}
              type="button"
              title="Reset to default"
            >
              Reset
            </button>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="dialog-overlay" onClick={handleClose} onKeyDown={onKeyActivate(handleClose)} role="button" tabIndex={-1}>
      <div className="dialog dialog--wide" onClick={e => e.stopPropagation()} onKeyDown={stopPropagationOnKey} role="dialog" tabIndex={-1}>
        <div className="dialog-header">
          <span>Keyboard Shortcuts</span>
          <button className="dialog-close" onClick={handleClose}>&times;</button>
        </div>
        <div className="dialog-body">
          <table className="shortcuts-table shortcuts-table--editable">
            <tbody>
              {ACTION_GROUP_ORDER.map(group => {
                const actions = groupedActions.get(group);
                if (!actions || actions.length === 0) return null;
                return (
                  <Fragment key={group}>
                    <tr className="shortcuts-group-header">
                      <td colSpan={3}>{group}</td>
                    </tr>
                    {actions.map(renderRow)}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="dialog-footer">
          <button className="form-btn" onClick={onResetAll} type="button">Reset all to defaults</button>
          <button className="form-btn form-btn--primary" onClick={handleClose} type="button">Close</button>
        </div>
      </div>
    </div>
  );
}
