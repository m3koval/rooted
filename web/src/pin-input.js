import './pin-input.css';

// A single native password control owns the value, selection and keyboard behavior.
// Visual cells never contain the secret. No persistence and no automatic submission.
export const normalizePin = value => value.normalize('NFKC').replace(/[\s\-‐‑–—]/gu, '');
export function enhancePin(input) {
  const field = document.createElement('div'); field.className = 'pin-field';
  const cells = document.createElement('div'); cells.className = 'pin-cells'; cells.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 6; i++) cells.append(document.createElement('span'));
  const error = document.createElement('p'); error.className = 'pin-error'; error.id = `${input.id || input.name}-error`; error.setAttribute('aria-live', 'polite');
  input.type = 'password'; input.inputMode = 'numeric'; input.autocomplete = 'off'; input.spellcheck = false; input.required = true;
  for (const attr of ['pattern', 'minlength', 'maxlength', 'placeholder']) input.removeAttribute(attr);
  input.classList.add('pin-native');
  input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' '));
  input.before(field); field.append(input, cells); field.after(error);
  let touched = false;
  const message = () => /^[0-9]{6}$/.test(input.value) ? '' : 'Enter all six numbers, using digits 0–9.';
  function paint() {
    const active = Math.min(input.selectionStart ?? input.value.length, 5);
    [...cells.children].forEach((cell, i) => {
      cell.textContent = i < input.value.length ? '●' : '';
      cell.classList.toggle('is-active', i === active);
    });
  }
  function showError(text) {
    error.textContent = text; input.setAttribute('aria-invalid', String(!!text));
  }
  function sync() {
    const caret = input.selectionStart;
    const before = input.value;
    input.value = normalizePin(before);
    if (caret !== null && before !== input.value) input.setSelectionRange(normalizePin(before.slice(0, caret)).length, normalizePin(before.slice(0, caret)).length);
    input.setCustomValidity(message());
    showError(touched || input.value.length > 6 || /[^0-9]/.test(input.value) ? message() : ''); paint();
  }
  function validate() { touched = true; sync(); if (message()) { input.focus(); return false; } return true; }
  function clear() { input.value = ''; touched = false; sync(); }
  input.addEventListener('input', sync);
  input.addEventListener('paste', event => {
    if (!event.clipboardData) return;
    event.preventDefault();
    input.setRangeText(normalizePin(event.clipboardData.getData('text')), input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.addEventListener('invalid', event => { event.preventDefault(); validate(); });
  input.addEventListener('blur', () => { if (input.value) { touched = true; sync(); } });
  for (const event of ['focus', 'keyup', 'select', 'click']) input.addEventListener(event, paint);
  input.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); input.focus();
    const rect = cells.getBoundingClientRect();
    const index = Math.max(0, Math.min(input.value.length, 6, Math.floor((event.clientX - rect.left) / (rect.width / 6))));
    input.setSelectionRange(index, index); paint();
  });
  input.form?.addEventListener('reset', () => { clear(); queueMicrotask(clear); });
  sync();
  return { validate, clear, showError };
}

export function pinField(name, label) {
  const wrapper = document.createElement('div'); wrapper.className = 'pin-control';
  const caption = document.createElement('label'); caption.htmlFor = `leader-${name}`; caption.textContent = label;
  const input = document.createElement('input'); input.name = name; input.id = caption.htmlFor;
  wrapper.append(caption, input);
  return wrapper;
}
