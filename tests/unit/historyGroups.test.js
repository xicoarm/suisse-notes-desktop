import { describe, it, expect } from 'vitest';
import { groupRecordingsByDay } from '../../src/utils/historyGroups';

const t = (k) => ({ historyToday: 'Today', historyYesterday: 'Yesterday', historyUndated: 'Undated' }[k] || k);

describe('groupRecordingsByDay', () => {
  const now = new Date(2026, 8, 12, 15, 0, 0); // Sat 12 Sep 2026, local time

  it('groups by local calendar day, newest day first, newest recording first within a day', () => {
    const recs = [
      { id: 'a', createdAt: new Date(2026, 8, 12, 9, 0).toISOString() },
      { id: 'b', createdAt: new Date(2026, 8, 12, 14, 30).toISOString() },
      { id: 'c', createdAt: new Date(2026, 8, 11, 23, 59).toISOString() },
      { id: 'd', createdAt: new Date(2026, 8, 3, 8, 0).toISOString() },
      { id: 'e', createdAt: new Date(2025, 11, 24, 8, 0).toISOString() },
    ];
    const groups = groupRecordingsByDay(recs, { locale: 'en', t, now });

    expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday', 'Thursday, September 3', 'Wednesday, December 24, 2025']);
    expect(groups[0].items.map(r => r.id)).toEqual(['b', 'a']);
    expect(groups[1].items.map(r => r.id)).toEqual(['c']);
    expect(groups.reduce((n, g) => n + g.items.length, 0)).toBe(5);
  });

  it('uses the app locale for the date label', () => {
    const recs = [{ id: 'd', createdAt: new Date(2026, 8, 3, 8, 0).toISOString() }];
    expect(groupRecordingsByDay(recs, { locale: 'de', t, now })[0].label).toBe('Donnerstag, 3. September');
    expect(groupRecordingsByDay(recs, { locale: 'fr', t, now })[0].label).toBe('jeudi 3 septembre');
  });

  it('keeps undated entries in a trailing group and tolerates empty input', () => {
    expect(groupRecordingsByDay([], { locale: 'en', t, now })).toEqual([]);
    const groups = groupRecordingsByDay([{ id: 'x' }, { id: 'y', createdAt: 'garbage' }], { locale: 'en', t, now });
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Undated');
    expect(groups[0].items.map(r => r.id)).toEqual(['x', 'y']);
  });
});
