import { useState, useEffect, useRef, useCallback } from 'react';
import logoSrc from '../assets/logo.png';

// ── Types ──────────────────────────────────────────────────────────

export interface MenuItemDef {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  separator?: false;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuItem = MenuItemDef | MenuSeparator;

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

interface MenuBarProps {
  menus: MenuDef[];
}

// ── Component ──────────────────────────────────────────────────────

export function MenuBar({ menus }: MenuBarProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (openIndex === null) return;
    const handleClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenIndex(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openIndex]);

  // Close on Escape
  useEffect(() => {
    if (openIndex === null) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenIndex(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [openIndex]);

  const handleMenuClick = useCallback((index: number) => {
    setOpenIndex(prev => (prev === index ? null : index));
  }, []);

  const handleMenuEnter = useCallback((index: number) => {
    // Only switch on hover if a menu is already open
    setOpenIndex(prev => (prev !== null ? index : prev));
  }, []);

  const handleItemClick = useCallback((item: MenuItemDef) => {
    if (item.disabled) return;
    setOpenIndex(null);
    item.onClick?.();
  }, []);

  return (
    <div className="menubar" ref={barRef}>
      <img src={logoSrc} alt="Tether" className="menubar-logo" />
      <span className="menubar-title">Tether</span>
      {menus.map((menu, i) => (
        <div
          key={menu.label}
          className="menubar-menu"
          onMouseEnter={() => handleMenuEnter(i)}
        >
          <button
            className={`menubar-item ${openIndex === i ? 'menubar-item--open' : ''}`}
            onClick={() => handleMenuClick(i)}
          >
            {menu.label}
          </button>
          {openIndex === i && (
            <div className="menubar-dropdown">
              {menu.items.map((item, j) =>
                item.separator ? (
                  <div key={j} className="menubar-dropdown-sep" />
                ) : (
                  <div
                    key={j}
                    className={[
                      'menubar-dropdown-item',
                      item.disabled ? 'menubar-dropdown-item--disabled' : '',
                      item.danger ? 'menubar-dropdown-item--danger' : '',
                    ].join(' ')}
                    onClick={() => handleItemClick(item)}
                  >
                    <span className="menubar-dropdown-check">
                      {item.checked ? '\u2713' : ''}
                    </span>
                    <span className="menubar-dropdown-label">{item.label}</span>
                    {item.shortcut && (
                      <span className="menubar-dropdown-shortcut">{item.shortcut}</span>
                    )}
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
