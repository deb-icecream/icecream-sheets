/**
 * Render an engine TypedValue as plain text (for dialogs reading the grid).
 * TypedValue is a tagged union: {kind, value} scalars, {kind:'error', code}
 * errors, and {kind:'image', src, alt} images.
 */
import type { TypedValue } from '@icecream-sheets/engine';

export function typedValueText(value: TypedValue): string {
  switch (value.kind) {
    case 'error':
      return value.code;
    case 'image':
      return value.alt ?? '';
    default: {
      const v = value.value;
      if (v === null || v === undefined) return '';
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      return String(v);
    }
  }
}
