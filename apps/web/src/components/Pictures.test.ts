import { describe, expect, it } from 'vitest';
import {
  PICTURES_METADATA_KEY,
  picturesFromMetadata,
  picturesToMetadata,
  MAX_PICTURE_DIM,
  type Picture,
} from '../components/Pictures';

const pic = (over: Partial<Picture> = {}): Picture => ({
  id: 1,
  x: 10,
  y: 20,
  w: 320,
  h: 240,
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  name: 'test.png',
  ...over,
});

describe('pictures metadata', () => {
  it('round-trips through metadata', () => {
    const pics = [pic(), pic({ id: 2, x: 5, name: 'b.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' })];
    const meta = picturesToMetadata(pics);
    const back = picturesFromMetadata(meta);
    expect(back).toEqual(pics);
  });

  it('drops corrupt entries', () => {
    const back = picturesFromMetadata([
      { id: 1, x: 0, y: 0, w: 10, h: 10, dataUrl: 'data:image/png;base64,xx', name: 'ok' },
      { id: 'bad' },
      null,
      { id: 2, x: 0, y: 0, w: 10, h: 10, dataUrl: 'not-a-data-url' },
      'string',
    ]);
    expect(back).toHaveLength(1);
    expect(back[0].id).toBe(1);
  });

  it('returns [] for non-array metadata', () => {
    expect(picturesFromMetadata(undefined)).toEqual([]);
    expect(picturesFromMetadata(null)).toEqual([]);
    expect(picturesFromMetadata({})).toEqual([]);
    expect(picturesFromMetadata('x')).toEqual([]);
  });

  it('clamps tiny dimensions', () => {
    const back = picturesFromMetadata([{ id: 1, x: 0, y: 0, w: 1, h: 2, dataUrl: 'data:image/png;base64,xx' }]);
    expect(back[0].w).toBe(8);
    expect(back[0].h).toBe(8);
  });

  it('defaults missing name', () => {
    const back = picturesFromMetadata([{ id: 1, x: 0, y: 0, w: 10, h: 10, dataUrl: 'data:image/gif;base64,xx' }]);
    expect(back[0].name).toBe('picture');
  });

  it('metadata key is namespaced', () => {
    expect(PICTURES_METADATA_KEY).toBe('icecream.pictures');
    expect(PICTURES_METADATA_KEY.startsWith('icecream.')).toBe(true);
  });

  it('max dimension bounds file size', () => {
    expect(MAX_PICTURE_DIM).toBe(1024);
  });

  it('empty picture list serializes to []', () => {
    expect(picturesToMetadata([])).toEqual([]);
    expect(picturesFromMetadata([])).toEqual([]);
  });
});
