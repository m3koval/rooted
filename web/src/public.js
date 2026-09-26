import './public.css';
import {sanitizeContent} from './public-content.js';
// Same-origin, static editorial content. No auth, storage, roster or private API.
async function loadPublicContent() {
  try {
    const response = await fetch('/content.json', {credentials: 'omit', cache: 'no-cache', redirect: 'error'});
    if (!response.ok) throw new Error('Public content unavailable');
    const content = sanitizeContent(await response.json());
    document.querySelector('#reflection').textContent = content.reflection;
    if (!content.events.length) return;
    const cards = content.events.map(event => {
      const card = document.createElement('article'); card.className = 'event';
      const date = document.createElement('time'); date.dateTime = event.date;
      date.textContent = new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric', year:'numeric', timeZone:'UTC'}).format(new Date(event.date+'T12:00:00Z'));
      const title = document.createElement('h3'); title.textContent = event.title;
      const details = document.createElement('p'); details.textContent = event.time;
      if (event.location) {
        if (event.time) details.append(' · ');
        if (event.mapAddress) {
          const link = document.createElement('a');
          link.textContent = event.location;
          link.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(event.mapAddress);
          link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.setAttribute('aria-label', event.location + ' — open in Google Maps');
          details.append(link);
        } else details.append(event.location);
      }
      const description = document.createElement('p'); description.textContent = event.description;
      card.append(date, title, details, description); return card;
    });
    document.querySelector('#public-events').replaceChildren(...cards);
  } catch { /* Honest static fallback stays visible; no alternate data source. */ }
}
loadPublicContent();
