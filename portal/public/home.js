// The home page: sign-in, "create new" tiles and the user's files.
'use strict';

const $ = (id) => document.getElementById(id);
let files = [];
let filter = 'all';

function openEditor(name, app, isNew) {
  const q = new URLSearchParams({ app });
  if (name) q.set('file', name);
  if (isNew) q.set('new', '1');
  location.href = 'edit.html?' + q;
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function formatDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Heute, ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function render() {
  const list = $('files');
  const q = $('search').value.trim().toLowerCase();
  const shown = files.filter((f) => (filter === 'all' || appFor(f.name) === filter) && (!q || f.name.toLowerCase().includes(q)));
  list.replaceChildren();
  const head = document.createElement('div');
  head.className = 'row head';
  head.innerHTML = '<span></span><span>Name</span><span>Geändert</span><span>Größe</span><span></span>';
  list.append(head);
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = files.length ? 'Keine Treffer.' : 'Noch keine Dateien. Erstelle eine neue oder ziehe Dateien hierher.';
    list.append(empty);
    return;
  }
  for (const f of shown) {
    const app = appFor(f.name);
    const row = document.createElement('div');
    row.className = 'row';
    row.tabIndex = 0;
    let icon;
    if (app) {
      icon = document.createElement('img');
      icon.src = `icons/${app}.png`;
      icon.alt = '';
    } else {
      icon = document.createElement('span');
      icon.className = 'ficon';
      icon.textContent = extOf(f.name).slice(0, 4).toUpperCase();
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;
    name.title = f.name;
    const date = document.createElement('span');
    date.className = 'meta';
    date.textContent = formatDate(f.modified);
    const size = document.createElement('span');
    size.className = 'meta size';
    size.textContent = formatSize(f.size);
    const actions = document.createElement('span');
    actions.className = 'actions';
    const button = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ghost ' + cls;
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      actions.append(b);
    };
    button('Laden', '', () => (location.href = fileUrl(f.name) + '?download'));
    button('Umbenennen', '', () => rename(f.name));
    button('Löschen', 'danger', () => remove(f.name));
    row.append(icon, name, date, size, actions);
    const open = () => (app ? openEditor(f.name, app) : (location.href = fileUrl(f.name) + '?download'));
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => e.key === 'Enter' && e.target === row && open());
    list.append(row);
  }
}

async function refresh() {
  files = await (await api('api/files')).json();
  render();
}

async function rename(name) {
  const to = prompt('Neuer Name:', name);
  if (!to || to === name) return;
  try {
    await api(fileUrl(name) + '/rename', { method: 'POST', json: { to: to.trim() } });
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

async function remove(name) {
  if (!confirm(`„${name}“ endgültig löschen?`)) return;
  try {
    await api(fileUrl(name), { method: 'DELETE' });
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

async function upload(list) {
  for (const file of list) {
    try {
      await api(fileUrl(file.name) + '?mode=create', { method: 'PUT', body: file });
      toast(`„${file.name}“ hochgeladen`);
    } catch (e) {
      toast(`${file.name}: ${e.message}`);
    }
  }
  await refresh();
}

async function showApp(user) {
  $('login').hidden = true;
  $('app').hidden = false;
  $('user-name').textContent = user;
  $('avatar').textContent = user.slice(0, 1);
  await refresh();
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-form').user.focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  $('login-error').textContent = '';
  try {
    const res = await api('api/login', { method: 'POST', json: { user: form.user.value.trim(), password: form.password.value } });
    const { user } = await res.json();
    form.password.value = '';
    const next = new URLSearchParams(location.search).get('next');
    if (next && /^edit\.html\?/.test(next)) location.href = next;
    else showApp(user);
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('api/logout', { method: 'POST' });
  showLogin();
});

document.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => openEditor(null, b.dataset.new, true)));
document.querySelectorAll('[data-filter]').forEach((b) =>
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  }),
);
$('search').addEventListener('input', render);
$('upload').addEventListener('click', () => $('upload-input').click());
$('upload-input').addEventListener('change', (e) => {
  upload([...e.target.files]);
  e.target.value = '';
});

// Drag files anywhere on the page to upload them.
let dragDepth = 0;
const dragging = (e) => !$('app').hidden && [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => {
  if (!dragging(e)) return;
  dragDepth++;
  $('drop').hidden = false;
});
addEventListener('dragleave', (e) => {
  if (!dragging(e)) return;
  if (--dragDepth <= 0) $('drop').hidden = true;
});
addEventListener('dragover', (e) => dragging(e) && e.preventDefault());
addEventListener('drop', (e) => {
  if (!dragging(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  upload([...e.dataTransfer.files]);
});

(async () => {
  const res = await fetch('api/me', { credentials: 'same-origin' });
  if (res.ok) showApp((await res.json()).user);
  else showLogin();
})();
