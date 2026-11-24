// The player's save as a file in a browser: the Options screen's Saves page downloads the account
// and reads one the player picks, through `window.__rogue_saves`. The game checks a picked file
// and, once the player says yes, makes it the account; this only carries the text.

const state = {
  // Bumped when a picked file is ready for the screen to take.
  rev: 0,
};

let picked = null;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

window.__rogue_saves = {
  state,
  // Hand the sealed save to the player as a file.
  download(text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `AzerothSurvivors ${stamp()}.sav`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
  // The player picks a save file; its text waits for `take`.
  pick() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sav,.txt';
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = () => input.remove();
    input.addEventListener('cancel', done);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      done();
      if (!file) return;
      try {
        picked = { name: file.name, text: await file.text() };
        state.rev++;
      } catch (e) {
        console.warn('The save file could not be read:', e);
      }
    });
    input.click();
  },
  // The picked file, `{ name, text }`, once; null when there is none.
  take() {
    const p = picked;
    picked = null;
    return p;
  },
};
