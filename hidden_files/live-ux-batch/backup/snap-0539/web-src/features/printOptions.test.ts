import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINT_FLAGS,
  printFlagsFromMetadata,
  printFlagsMetadataKey,
  printFlagsToMetadata,
} from './printOptions';

describe('print flags', () => {
  it('defaults to not printing gridlines/headings', () => {
    expect(DEFAULT_PRINT_FLAGS).toEqual({ printGridlines: false, printHeadings: false });
  });

  it('round-trips through metadata with a per-sheet key', () => {
    const flags = { printGridlines: true, printHeadings: false };
    expect(printFlagsFromMetadata(printFlagsToMetadata(flags))).toEqual(flags);
    expect(printFlagsMetadataKey('Sheet1')).toBe('icecream.printflags.Sheet1');
  });

  it('falls back to defaults on bad metadata', () => {
    expect(printFlagsFromMetadata(null)).toEqual(DEFAULT_PRINT_FLAGS);
    expect(printFlagsFromMetadata({ printGridlines: 'yes' })).toEqual(DEFAULT_PRINT_FLAGS);
  });
});
