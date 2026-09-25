// Public editorial content only. Never import the leader client into this module.
export const KJV_VERSE = 'But be ye doers of the word, and not hearers only, deceiving your own selves.';
export const VERSE_SOURCE = 'https://www.biblegateway.com/passage/?search=James%201%3A22&version=KJV';
const plain = (value, max = 500) => typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max) : '';
export function sanitizeContent(raw, today = new Date().toISOString().slice(0, 10)) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const events = (Array.isArray(data.events) ? data.events : []).slice(0, 100).flatMap(event => {
    if (!event || event.published !== true || !/^\d{4}-\d{2}-\d{2}$/.test(event.date || '')) return [];
    const parsed = new Date(event.date + 'T12:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== event.date || event.date < today) return [];
    const title = plain(event.title, 100);
    return title ? [{title, date: event.date, time: plain(event.time, 60), location: plain(event.location, 160), description: plain(event.description)}] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  return {events, reflection: plain(data.reflection, 800) || 'Where could you put faith into practice today? Look for one small way to serve, encourage, or listen. Start there.', verse: KJV_VERSE, source: VERSE_SOURCE};
}
