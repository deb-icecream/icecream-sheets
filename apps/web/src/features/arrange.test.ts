import { describe, expect, it } from 'vitest';
import {
  alignBottom,
  alignCenterH,
  alignLeft,
  alignMiddleV,
  alignRight,
  alignTop,
  bringForward,
  bringToFront,
  distributeHorizontally,
  distributeVertically,
  flipHorizontal,
  flipVertical,
  normalizeZ,
  renameItem,
  rotate270,
  rotate90,
  sendBackward,
  sendToBack,
  toggleHidden,
  type ArrangeItem,
} from './arrange';

function items(): ArrangeItem[] {
  return [
    { id: 1, name: 'A', x: 0, y: 0, w: 10, h: 10, z: 0 },
    { id: 2, name: 'B', x: 50, y: 30, w: 20, h: 10, z: 1 },
    { id: 3, name: 'C', x: 120, y: 60, w: 10, h: 20, z: 2 },
  ];
}

describe('z-order', () => {
  it('bringForward swaps with the next item up', () => {
    const out = bringForward(items(), 1);
    expect(out.find((i) => i.id === 1)?.z).toBe(1);
    expect(out.find((i) => i.id === 2)?.z).toBe(0);
  });

  it('sendBackward swaps with the next item down', () => {
    const out = sendBackward(items(), 3);
    expect(out.find((i) => i.id === 3)?.z).toBe(1);
    expect(out.find((i) => i.id === 2)?.z).toBe(2);
  });

  it('is a no-op at the extremes', () => {
    expect(bringForward(items(), 3).map((i) => i.z)).toEqual([0, 1, 2]);
    expect(sendBackward(items(), 1).map((i) => i.z)).toEqual([0, 1, 2]);
  });

  it('bringToFront / sendToBack move to the extremes', () => {
    expect(bringToFront(items(), 1).find((i) => i.id === 1)?.z).toBe(2);
    expect(sendToBack(items(), 3).find((i) => i.id === 3)?.z).toBe(0);
  });

  it('normalizeZ compacts arbitrary z values', () => {
    const messy: ArrangeItem[] = [
      { id: 1, name: 'A', x: 0, y: 0, w: 1, h: 1, z: 10 },
      { id: 2, name: 'B', x: 0, y: 0, w: 1, h: 1, z: 3 },
    ];
    const out = normalizeZ(messy);
    expect(out.find((i) => i.id === 2)?.z).toBe(0);
    expect(out.find((i) => i.id === 1)?.z).toBe(1);
  });
});

describe('alignment', () => {
  const ids = [1, 2, 3];

  it('alignLeft aligns to the leftmost edge', () => {
    const out = alignLeft(items(), ids);
    expect(out.every((i) => i.x === 0)).toBe(true);
  });

  it('alignRight aligns to the rightmost edge', () => {
    const out = alignRight(items(), ids);
    // Rightmost edge is 130 (item 3: x=120 w=10).
    expect(out.find((i) => i.id === 1)?.x).toBe(120);
    expect(out.find((i) => i.id === 2)?.x).toBe(110);
  });

  it('alignCenterH centers on the selection midpoint', () => {
    const out = alignCenterH(items(), ids);
    // Midpoint of [0,130] is 65.
    expect(out.find((i) => i.id === 1)?.x).toBe(60);
    expect(out.find((i) => i.id === 2)?.x).toBe(55);
  });

  it('alignTop / alignMiddleV / alignBottom work on y', () => {
    expect(alignTop(items(), ids).every((i) => i.y === 0)).toBe(true);
    const mid = alignMiddleV(items(), ids);
    // Midpoint of [0,80] is 40.
    expect(mid.find((i) => i.id === 1)?.y).toBe(35);
    const bot = alignBottom(items(), ids);
    expect(bot.find((i) => i.id === 1)?.y).toBe(70);
  });

  it('only moves the selected ids', () => {
    const out = alignLeft(items(), [2]);
    expect(out.find((i) => i.id === 1)?.x).toBe(0);
    expect(out.find((i) => i.id === 2)?.x).toBe(50);
  });
});

describe('distribution', () => {
  it('distributeHorizontally spaces items evenly', () => {
    const input: ArrangeItem[] = [
      { id: 1, name: 'A', x: 0, y: 0, w: 10, h: 10, z: 0 },
      { id: 2, name: 'B', x: 15, y: 0, w: 10, h: 10, z: 1 },
      { id: 3, name: 'C', x: 90, y: 0, w: 10, h: 10, z: 2 },
    ];
    const out = distributeHorizontally(input, [1, 2, 3]);
    // Span 0..100, total width 30, gap = 70/2 = 35.
    expect(out.find((i) => i.id === 1)?.x).toBe(0);
    expect(out.find((i) => i.id === 2)?.x).toBe(45);
    expect(out.find((i) => i.id === 3)?.x).toBe(90);
  });

  it('distributeVertically spaces items evenly', () => {
    const input: ArrangeItem[] = [
      { id: 1, name: 'A', x: 0, y: 0, w: 10, h: 10, z: 0 },
      { id: 2, name: 'B', x: 0, y: 60, w: 10, h: 10, z: 1 },
      { id: 3, name: 'C', x: 0, y: 90, w: 10, h: 10, z: 2 },
    ];
    const out = distributeVertically(input, [1, 2, 3]);
    expect(out.find((i) => i.id === 1)?.y).toBe(0);
    expect(out.find((i) => i.id === 2)?.y).toBe(45);
    expect(out.find((i) => i.id === 3)?.y).toBe(90);
  });

  it('needs 3+ items', () => {
    const out = distributeHorizontally(items(), [1, 2]);
    expect(out).toEqual(items());
  });
});

describe('rotate / flip / pane', () => {
  it('rotate90 accumulates mod 360', () => {
    let out = rotate90(items(), 1);
    expect(out.find((i) => i.id === 1)?.rotation).toBe(90);
    out = rotate90(rotate90(rotate90(out, 1), 1), 1);
    expect(out.find((i) => i.id === 1)?.rotation).toBe(0);
  });

  it('rotate270 is counter-clockwise', () => {
    const out = rotate270(items(), 2);
    expect(out.find((i) => i.id === 2)?.rotation).toBe(270);
  });

  it('flips toggle', () => {
    const out = flipHorizontal(flipVertical(items(), 1), 1);
    expect(out.find((i) => i.id === 1)?.flipH).toBe(true);
    expect(out.find((i) => i.id === 1)?.flipV).toBe(true);
    expect(flipHorizontal(out, 1).find((i) => i.id === 1)?.flipH).toBe(false);
  });

  it('rename and hide work for the selection pane', () => {
    const renamed = renameItem(items(), 2, 'Chart 1');
    expect(renamed.find((i) => i.id === 2)?.name).toBe('Chart 1');
    const hidden = toggleHidden(items(), 2);
    expect(hidden.find((i) => i.id === 2)?.hidden).toBe(true);
    expect(toggleHidden(hidden, 2).find((i) => i.id === 2)?.hidden).toBe(false);
  });
});
