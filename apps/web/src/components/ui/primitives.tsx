/**
 * Design-system primitives (#40, design doc §1.2): Button, IconButton,
 * and the animated ThinkingWave (§3.1). All styling lives in
 * design-system.css (ds-* classes) — components carry no inline styles.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface DsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 's' | 'm';
  /** Toggle state (ghost tab-style buttons). */
  on?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'm',
  on = false,
  className,
  children,
  type = 'button',
  ...rest
}: DsButtonProps) {
  const cls = [
    'ds-btn',
    `ds-btn-${variant}`,
    size === 's' ? 'ds-btn-s' : '',
    variant === 'ghost' && on ? 'ds-btn-on' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}

interface DsIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  on?: boolean;
  children: ReactNode;
}

export function IconButton({ label, on = false, className, children, type = 'button', ...rest }: DsIconButtonProps) {
  const cls = ['ds-icon-btn', on ? 'ds-icon-btn-on' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/**
 * Thinking indicator (§3.1): three dots in a staggered wave; accessible
 * label "Thinking…"; reduced-motion degrades to a gentle fade (CSS).
 */
export function ThinkingWave() {
  return (
    <span className="ds-thinking" role="status" aria-label="Thinking…">
      <span className="ds-thinking-dot" />
      <span className="ds-thinking-dot" />
      <span className="ds-thinking-dot" />
    </span>
  );
}
