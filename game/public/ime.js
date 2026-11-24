// Typing Chinese, Japanese and Korean in a browser: an input method (IME) only ever works in an
// editable element, never on the game's canvas. While the game has a text field taking text it
// says so through `window.__rogue_ime.typing(on, x, y)`, and a hidden textarea at (x, y) takes the
// keyboard: what the IME composes shows in it, and what it commits goes to the canvas as one key
// whose name is the text, in order with the keys around it. Every other key is handed on to the
// canvas as it came, so Enter, Escape, Backspace and plain letters work as before. The canvas is told of no focus change in between: the game would read
// one as the window losing focus (its sound, its held keys).

const box = document.createElement('textarea');
box.setAttribute('aria-hidden', 'true');
box.autocomplete = 'off';
box.spellcheck = false;
box.tabIndex = -1;
// Invisible but focusable until a composition shows it, at the field, where the IME's list opens.
box.style.cssText = 'position:fixed;left:0;top:0;width:2em;height:1.6em;margin:0;padding:1px 4px;'
  + 'border:1px solid #b48a3c;border-radius:2px;outline:none;resize:none;overflow:hidden;'
  + 'white-space:pre;field-sizing:content;min-width:2em;font:16px sans-serif;line-height:1.6em;'
  + 'color:#fff;background:rgba(0,0,0,.85);z-index:10;opacity:0;pointer-events:none;';

let want = false;
let composing = false;

const canvas = () => document.getElementById('benilla');

function show(on) {
  box.style.opacity = on ? '1' : '0';
}

function clear() {
  box.value = '';
}

// Text the IME committed, to the canvas as a key named by it: the game reads a key's name as the
// text it types.
function commit(text) {
  if (!text) return;
  for (const type of ['keydown', 'keyup']) {
    canvas()?.dispatchEvent(new KeyboardEvent(type, { key: text, bubbles: true, cancelable: true }));
  }
}

// A key the IME is not using goes to the canvas, as a key pressed there would.
function forward(e) {
  if (e.isComposing || e.keyCode === 229 || composing) return;
  e.preventDefault();
  e.stopPropagation();
  canvas()?.dispatchEvent(new KeyboardEvent(e.type, {
    key: e.key,
    code: e.code,
    location: e.location,
    repeat: e.repeat,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
  }));
}

box.addEventListener('keydown', forward);
box.addEventListener('keyup', forward);
box.addEventListener('compositionstart', () => {
  composing = true;
  show(true);
});
box.addEventListener('compositionend', (e) => {
  composing = false;
  commit(e.data);
  show(false);
  // The committed text leaves the box at once, so the next composition starts in an empty one.
  clear();
});
// Text typed in without a composition (an emoji or symbol panel); keys the canvas got never land.
// Firefox puts a composition's text in after its end: that leaves the box too.
box.addEventListener('input', (e) => {
  if (e.isComposing || composing) return;
  if (e.inputType === 'insertText' && e.data) commit(e.data);
  clear();
});
// Losing the page's focus while typing is the canvas losing it; a click on the canvas gives it
// back to the box while the field still takes text.
box.addEventListener('blur', (e) => {
  const c = canvas();
  if (e.relatedTarget === c) {
    if (want) setTimeout(() => want && box.focus({ preventScroll: true }), 0);
    return;
  }
  composing = false;
  show(false);
  c?.dispatchEvent(new FocusEvent('blur'));
});
box.addEventListener('focus', (e) => {
  if (e.relatedTarget !== canvas()) canvas()?.dispatchEvent(new FocusEvent('focus'));
});

// Back on the page with a field still taking text.
window.addEventListener('focus', () => {
  if (want && document.activeElement !== box) box.focus({ preventScroll: true });
});

// The canvas's focus moving to the box and back is no focus change to the game.
for (const type of ['blur', 'focus', 'focusin', 'focusout']) {
  window.addEventListener(type, (e) => {
    if (e.target === canvas() && e.relatedTarget === box) e.stopImmediatePropagation();
  }, true);
}

window.__rogue_ime = {
  // A field takes text (`on`), at (x, y) in the canvas's CSS px.
  typing(on, x, y) {
    want = !!on;
    if (want) {
      const r = canvas()?.getBoundingClientRect();
      box.style.left = `${Math.round((r?.left || 0) + x)}px`;
      box.style.top = `${Math.round((r?.top || 0) + y)}px`;
      if (document.activeElement !== box && document.hasFocus()) box.focus({ preventScroll: true });
    } else if (document.activeElement === box) {
      composing = false;
      show(false);
      clear();
      canvas()?.focus({ preventScroll: true });
    }
  },
};

document.body.appendChild(box);
