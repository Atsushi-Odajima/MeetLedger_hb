import { describe, expect, it } from 'vitest';
import { nextCursorOf, totalOf, withCursor } from './hooks';
import { formatCount } from '../pages/Dashboard';

describe('cursor paging helpers', () => {
  it('reads nextCursor / total from paged responses', () => {
    expect(nextCursorOf({ items: [], nextCursor: 'abc' })).toBe('abc');
    expect(nextCursorOf({ items: [], nextCursor: null })).toBeNull();
    expect(nextCursorOf({ items: [], nextCursor: '' })).toBeNull();
    expect(nextCursorOf(undefined)).toBeNull();
    expect(totalOf({ items: [], total: 1234 })).toBe(1234);
    expect(totalOf({ items: [] })).toBeUndefined();
  });
  it('appends an encoded cursor to the list path', () => {
    expect(withCursor('/api/w/1/actions', 'a b/c')).toBe('/api/w/1/actions?cursor=a%20b%2Fc');
    expect(withCursor('/api/w/1/actions?status=open', 'x')).toBe('/api/w/1/actions?status=open&cursor=x');
  });
  it('shows capped dashboard counts as "cap+"', () => {
    expect(formatCount(12, 1000)).toBe('12');
    expect(formatCount(1000, 1000)).toBe('1000+');
    expect(formatCount(5)).toBe('5');
  });
});
