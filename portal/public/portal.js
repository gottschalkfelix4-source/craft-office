// Shared by the home page and the editor: the API, the three apps and small UI helpers.
'use strict';

const APPS = {
  word: { title: 'WordCraft', label: 'Dokument', untitled: 'Neues Dokument', exts: ['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'odt', 'rtf', 'md', 'txt', 'html', 'htm'] },
  grid: { title: 'GridCraft', label: 'Tabelle', untitled: 'Neue Tabelle', exts: ['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv'] },
  deck: { title: 'DeckCraft', label: 'Präsentation', untitled: 'Neue Präsentation', exts: ['pptx', 'potx', 'ppsx', 'deckcraft'] },
};

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** `word`, `grid`, `deck`, or null for a file none of the apps opens. */
function appFor(name) {
  const ext = extOf(name);
  return Object.keys(APPS).find((k) => APPS[k].exts.includes(ext)) || null;
}

function fileUrl(name) {
  return 'api/files/' + encodeURIComponent(name);
}

async function api(path, { method = 'GET', body, json, headers = {} } = {}) {
  const init = { method, headers: { 'X-Craft': '1', ...headers }, credentials: 'same-origin' };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(path, init);
  if (res.status === 401 && !path.endsWith('/login')) {
    const back = location.pathname.endsWith('edit.html') ? '?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search) : '';
    location.href = './' + back;
    throw new Error('not signed in');
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error || message;
    } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res;
}

let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}
