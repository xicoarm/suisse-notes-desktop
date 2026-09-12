/**
 * Group history recordings by calendar day (device-local time), newest day
 * first, newest recording first inside a day. Pure — no store access — so the
 * History page stays declarative and the grouping is unit-testable.
 *
 * Labels: "today" / "yesterday" (resolved by the caller's translator) or a
 * localized long date ("Donnerstag, 11. September") for older days; the year
 * is appended only when it differs from the current year.
 */

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * @param {Array<Object>} recordings - history entries with `createdAt`
 * @param {Object} opts
 * @param {string} opts.locale - BCP-47 locale for date labels ('de', 'fr-CH', …)
 * @param {(key: string) => string} opts.t - translator for 'historyToday' / 'historyYesterday'
 * @param {Date} [opts.now] - injectable clock (tests)
 * @returns {Array<{ key: string, label: string, items: Array<Object> }>}
 */
export function groupRecordingsByDay(recordings, { locale = 'de', t = (k) => k, now = new Date() } = {}) {
  const list = Array.isArray(recordings) ? recordings : [];
  const todayKey = dayKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKey(yesterday);

  let formatter = null;
  let formatterWithYear = null;
  try {
    formatter = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
    formatterWithYear = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    formatter = null;
  }

  const groups = new Map();
  const undated = [];
  for (const rec of list) {
    const time = rec?.createdAt ? new Date(rec.createdAt).getTime() : NaN;
    if (!Number.isFinite(time)) {
      undated.push(rec);
      continue;
    }
    const date = new Date(time);
    const key = dayKey(date);
    if (!groups.has(key)) {
      let label;
      if (key === todayKey) label = t('historyToday');
      else if (key === yesterdayKey) label = t('historyYesterday');
      else if (formatter) {
        label = (date.getFullYear() === now.getFullYear() ? formatter : formatterWithYear).format(date);
      } else {
        label = key;
      }
      groups.set(key, { key, label, items: [], sortTime: time });
    }
    const group = groups.get(key);
    group.items.push(rec);
    if (time > group.sortTime) group.sortTime = time;
  }

  const out = [...groups.values()]
    .sort((a, b) => b.sortTime - a.sortTime)
    .map(({ key, label, items }) => ({
      key,
      label,
      items: [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }));
  if (undated.length > 0) {
    out.push({ key: 'undated', label: t('historyUndated'), items: undated });
  }
  return out;
}
