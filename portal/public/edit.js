// The editor page: frames one app with `?host=parent` and is its file system. The app sends
// `<app>:ready`, `<app>:save`, `<app>:dirty` and `<app>:failed`; this page answers `ready` with
// `<app>:open` and stores every save on the server.
'use strict';

const PREFIX = { word: 'wordcraft', grid: 'gridcraft', deck: 'deckcraft' };
const MAIN_EXT = { word: 'docx', grid: 'xlsx', deck: 'pptx' };

const params = new URLSearchParams(location.search);
const app = PREFIX[params.get('app')] ? params.get('app') : appFor(params.get('file') || '') || 'word';
const prefix = PREFIX[app];
const frame = document.getElementById('frame');

/** The file on the server this editor writes to (null until a new document is first saved). */
let serverName = params.get('new') ? null : params.get('file');
/** The name the app knows the document by: what we opened it as, or what it saved it as. */
let appName = serverName;
let dirty = false;
let failed = false;
let saving = Promise.resolve();
let pendingSaves = 0;

function stem(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function setStatus(text, cls = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}

function showName() {
  const name = serverName || APPS[app].untitled;
  document.getElementById('title').textContent = name;
  document.title = `${name} – ${APPS[app].title}`;
  const dl = document.getElementById('download');
  dl.hidden = !serverName;
  if (serverName) dl.href = fileUrl(serverName) + '?download';
  const q = new URLSearchParams({ app });
  if (serverName) q.set('file', serverName);
  else q.set('new', '1');
  history.replaceState(null, '', 'edit.html?' + q);
}

function showOverlay(text) {
  const el = document.getElementById('overlay');
  el.textContent = text;
  el.hidden = !text;
}

function post(message, transfer) {
  frame.contentWindow.postMessage(message, location.origin, transfer || []);
}

async function openInApp() {
  if (!serverName) return;
  setStatus('Öffnet…');
  try {
    const bytes = await (await api(fileUrl(serverName))).arrayBuffer();
    post({ type: `${prefix}:open`, name: serverName, bytes }, [bytes]);
    setStatus('');
  } catch (e) {
    setStatus('Öffnen fehlgeschlagen', 'failed');
    showOverlay(`„${serverName}“ konnte nicht geladen werden: ${e.message}`);
  }
}

/**
 * Where a save from the app goes:
 * - `current`: overwrite the file being edited (Save of the opened document);
 * - `adopt`: a new file that becomes the one being edited (first Save of a new document, Save As,
 *   or Save converting the opened file to the app's own format, as .csv → .xlsx);
 * - `copy`: a new file beside it (exports such as PDF or PNG).
 */
function routeSave(name, saveAs) {
  if (!saveAs && serverName && name === appName) return 'current';
  const ownKind = appFor(name) === app;
  if (saveAs && ownKind) return 'adopt';
  if (!serverName && ownKind) return 'adopt';
  if (ownKind && appName && stem(name) === stem(appName) && name.toLowerCase().endsWith('.' + MAIN_EXT[app])) return 'adopt';
  return 'copy';
}

async function store(name, saveAs, bytes) {
  const route = routeSave(name, saveAs);
  const target = route === 'current' ? serverName : name;
  const mode = route === 'current' ? '' : '?mode=create';
  const res = await api(fileUrl(target) + mode, { method: 'PUT', body: bytes });
  const { name: stored } = await res.json();
  if (route === 'copy') {
    toast(`Gespeichert als „${stored}“`);
  } else {
    serverName = stored;
    appName = name;
    showName();
  }
}

function onSave({ name, saveAs, bytes }) {
  if (typeof name !== 'string' || !(bytes instanceof ArrayBuffer)) return;
  pendingSaves++;
  setStatus('Speichert…');
  saving = saving
    .then(() => store(name, !!saveAs, bytes))
    .then(() => setStatus(dirty ? 'Nicht gespeicherte Änderungen' : 'Gespeichert', dirty ? 'dirty' : ''))
    .catch((e) => {
      // The app counts the file as saved once it is handed over, so the change is only here now.
      dirty = true;
      setStatus('Speichern fehlgeschlagen', 'failed');
      alert(`„${name}“ konnte nicht gespeichert werden: ${e.message}\n\nBitte erneut speichern.`);
    })
    .finally(() => pendingSaves--);
}

addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data.type !== 'string') return;
  switch (data.type) {
    case `${prefix}:ready`:
      showOverlay('');
      openInApp();
      break;
    case `${prefix}:save`:
      onSave(data);
      break;
    case `${prefix}:dirty`:
      dirty = !!data.dirty;
      if (!pendingSaves) setStatus(dirty ? 'Nicht gespeicherte Änderungen' : serverName ? 'Gespeichert' : '', dirty ? 'dirty' : '');
      break;
    case `${prefix}:failed`:
      failed = true;
      showOverlay(`${APPS[app].title} konnte nicht starten (${data.error || 'unbekannter Fehler'}). Der Browser braucht WebGPU oder WebGL2.`);
      break;
  }
});

addEventListener('beforeunload', (e) => {
  if (!failed && (dirty || pendingSaves)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

(async () => {
  document.getElementById('app-icon').src = `icons/${app}.png`;
  document.getElementById('favicon').href = `icons/${app}.png`;
  showName();
  const { user } = await (await api('api/me')).json();
  const q = new URLSearchParams({ host: 'parent', author: user });
  if (app === 'deck' && !serverName) q.set('blank', '');
  frame.src = `apps/${app}/?${q}`;
  setStatus('Lädt…');
})();
