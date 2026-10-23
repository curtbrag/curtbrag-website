const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/scripts/site-forms.js'), 'utf8');

function setup(kind = 'ride') {
  function element(id) {
    const classes = new Set();
    return {
      id, value: '', textContent: '', style: {}, disabled: false, files: [], handlers: {},
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)),
        remove: (...xs) => xs.forEach(x => classes.delete(x)),
        toggle: (x, on) => on ? classes.add(x) : classes.delete(x), contains: x => classes.has(x) },
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      emit(name, props = {}) {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
        for (const fn of this.handlers[name] || []) fn(event);
        return event;
      },
      removeAttribute(name) { delete this[name]; },
    };
  }
  const ids = ['submit-text', 'submit-spinner', 'image-preview', 'preview-img', 'file-error', 'photo', 'description', 'char-count'];
  const nodes = Object.fromEntries(ids.map(id => [id, element(id)]));
  const form = element(kind + '-form'), button = element('submit'), window = element('window');
  nodes['submit-text'].textContent = kind === 'ride' ? 'Submit Your Ride' : 'Send Message';
  nodes['submit-spinner'].classList.add('hidden');
  nodes['image-preview'].classList.add('hidden');
  form.querySelector = selector => selector === 'button[type="submit"]' ? button : nodes[selector.slice(1)];
  if (kind === 'contact') for (const key of ids.slice(2)) delete nodes[key];
  const readers = [], timers = [];
  class FileReader {
    constructor() { this.readyState = 0; readers.push(this); }
    readAsDataURL() { this.readyState = 1; }
    abort() { this.readyState = 2; this.aborted = true; }
    finish(result = 'data:image/png;base64,test') { this.result = result; this.readyState = 2; this.onload(); }
    fail() { this.readyState = 2; this.onerror(); }
  }
  vm.runInNewContext(source, { document: { getElementById: id => id === form.id ? form : null }, window,
    FileReader, setTimeout: fn => timers.push(fn) });
  return { form, button, window, readers, nodes, timers,
    select(file) { nodes.photo.files = file ? [file] : []; nodes.photo.emit('change'); } };
}

test('oversized upload followed by cancellation does not trap submit disabled', () => {
  const s = setup();
  s.select({ size: 11 * 1024 * 1024, type: 'image/jpeg' });
  assert.match(s.nodes['file-error'].textContent, /10MB/);
  assert.equal(s.nodes.photo.value, '');
  assert.equal(s.button.disabled, false);
  s.select(null);
  assert.equal(s.nodes['file-error'].style.display, 'none');
  assert.equal(s.button.disabled, false);
});

test('changing the selection cancels an old preview and ignores a late read', () => {
  const s = setup();
  s.select({ size: 100, type: 'image/png' });
  const old = s.readers[0];
  s.select({ size: 100, type: 'text/plain' });
  assert.equal(old.aborted, true);
  old.finish();
  assert.equal(s.nodes['image-preview'].classList.contains('hidden'), true);
  assert.match(s.nodes['file-error'].textContent, /image file/);
});

test('a valid image appears and a read failure clears stale preview', () => {
  const s = setup();
  s.select({ size: 100, type: 'image/png' });
  s.readers[0].finish();
  assert.equal(s.nodes['image-preview'].classList.contains('hidden'), false);
  s.select({ size: 200, type: 'image/jpeg' });
  s.readers[1].fail();
  assert.equal(s.nodes['image-preview'].classList.contains('hidden'), true);
  assert.equal(s.nodes['preview-img'].src, undefined);
  assert.match(s.nodes['file-error'].textContent, /could not be read/);
});

for (const kind of ['contact', 'ride']) {
  test(`${kind} form restores native submission controls after browser Back`, () => {
    const s = setup(kind);
    const initial = s.nodes['submit-text'].textContent;
    const first = s.form.emit('submit');
    assert.equal(first.defaultPrevented, false, 'preserve the native form POST');
    assert.equal(s.button.disabled, true);
    assert.equal(s.nodes['submit-spinner'].classList.contains('hidden'), false);
    assert.equal(s.form.emit('submit').defaultPrevented, true, 'block duplicate submissions');
    s.window.emit('pageshow', { persisted: true });
    assert.equal(s.button.disabled, false);
    assert.equal(s.nodes['submit-text'].textContent, initial);
    assert.equal(s.nodes['submit-spinner'].classList.contains('hidden'), true);
    assert.equal(s.form.emit('submit').defaultPrevented, false);
  });
}

test('prevented submissions do not leave loading UI behind', () => {
  const s = setup('contact');
  s.form.emit('submit', { defaultPrevented: true });
  assert.equal(s.button.disabled, false);
});

test('reset cancels pending image reads, clears errors and updates the counter after native reset', () => {
  const s = setup();
  s.nodes.description.value = 'My truck'; s.nodes.description.emit('input');
  assert.equal(s.nodes['char-count'].textContent, '8');
  s.select({ size: 100, type: 'image/png' });
  s.form.emit('submit'); s.form.emit('reset'); s.nodes.description.value = '';
  s.timers.forEach(fn => fn()); s.readers[0].finish();
  assert.equal(s.nodes['char-count'].textContent, '0');
  assert.equal(s.nodes['image-preview'].classList.contains('hidden'), true);
  assert.equal(s.button.disabled, false);
});
