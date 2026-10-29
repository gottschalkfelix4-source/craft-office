// Craft Office portal: login, per-user file storage and the static WordCraft / GridCraft /
// DeckCraft web builds, all on one origin so the apps' `?host=parent` bridge can reach the page.
// Node.js built-ins only.
//
//   node server.js                      start the server
//   node server.js adduser NAME [PASS]  add a user or set their password (prompts without PASS)
//   node server.js deluser NAME         remove a user (their files stay on disk)
//
// Environment: PORT (8080), DATA_DIR (./data), APPS_DIR (./apps), PUBLIC_DIR (./public),
// ADMIN_USER / ADMIN_PASSWORD (creates that user on start when no user exists yet),
// SESSION_DAYS (14), MAX_UPLOAD_MB (500).

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const APPS_DIR = path.resolve(process.env.APPS_DIR || path.join(__dirname, 'apps'));
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, 'public'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const SESSION_MS = Number(process.env.SESSION_DAYS || 14) * 86400e3;
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024;
const COOKIE = 'craft_session';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------- users ----------

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  // `docker exec … adduser` runs as root: hand the file to whoever owns the data folder (the server).
  if (process.getuid?.() === 0) {
    const { uid, gid } = fs.statSync(DATA_DIR);
    fs.chownSync(tmp, uid, gid);
  }
  fs.renameSync(tmp, USERS_FILE);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function checkPassword(user, password) {
  if (!user) {
    // Same work for unknown users, so timing doesn't tell which names exist.
    hashPassword(password);
    return false;
  }
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

function validUserName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);
}

// ---------- sessions (stateless, HMAC-signed) ----------

function sessionSecret() {
  try {
    return fs.readFileSync(SECRET_FILE);
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const secret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  }
}

let SECRET;

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function makeSession(user, stamp) {
  const value = `${Buffer.from(user).toString('base64url')}.${Date.now() + SESSION_MS}.${stamp}`;
  return `${value}.${sign(value)}`;
}

/** The user a session cookie belongs to, or null. `stamp` changes with the password, so a new password ends old sessions. */
function readSession(token, users) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const value = parts.slice(0, 3).join('.');
  const mac = Buffer.from(parts[3]);
  const expected = Buffer.from(sign(value));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  if (Number(parts[1]) < Date.now()) return null;
  const name = Buffer.from(parts[0], 'base64url').toString();
  const user = users[name];
  if (!user || user.salt.slice(0, 8) !== parts[2]) return null;
  return name;
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token, maxAgeMs) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (isHttps(req)) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// Login attempts per address: at most 10 failures in 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  failures.set(ip, list);
  return list.length >= 10;
}

// ---------- files ----------

const DOC_KINDS = {
  word: ['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'odt', 'rtf', 'md', 'txt', 'html', 'htm'],
  grid: ['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv'],
  deck: ['pptx', 'potx', 'ppsx', 'deckcraft'],
};

function kindOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const [kind, exts] of Object.entries(DOC_KINDS)) if (exts.includes(ext)) return kind;
  return 'other';
}

/** A plain file name: no folders, no hidden files, no control or reserved characters. */
function validFileName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    name === name.trim() &&
    !name.startsWith('.') &&
    !/[\/\\:*?"<>|\x00-\x1f\x7f]/.test(name)
  );
}

function userDir(user) {
  return path.join(FILES_DIR, user);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** `name`, or `name (2).ext`, `name (3).ext`… whichever is free in `dir`. */
async function freeName(dir, name) {
  if (!(await exists(path.join(dir, name)))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length).replace(/ \(\d+\)$/, '');
  for (let i = 2; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new Error('no free name');
}

async function listFiles(user) {
  const dir = userDir(user);
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const st = await fsp.stat(path.join(dir, entry.name));
    out.push({ name: entry.name, size: st.size, modified: st.mtime.toISOString(), kind: kindOf(entry.name) });
  }
  out.sort((a, b) => b.modified.localeCompare(a.modified));
  return out;
}

/** Write `req`'s body to `target` through a temporary file, so a broken upload never replaces a good file. */
async function writeBody(req, target) {
  const tmp = path.join(path.dirname(target), `.upload-${crypto.randomBytes(8).toString('hex')}`);
  const out = fs.createWriteStream(tmp, { flags: 'wx' });
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) {
          req.destroy();
          reject(Object.assign(new Error('file too large'), { status: 413 }));
          return;
        }
        if (!out.write(chunk)) req.pause();
      });
      out.on('drain', () => req.resume());
      req.on('end', resolve);
      req.on('error', reject);
      out.on('error', reject);
    });
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    await fsp.rename(tmp, target);
    return size;
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

// ---------- http helpers ----------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 64 * 1024) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  try {
    return JSON.parse(data || '{}');
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Only this site may frame its pages (the editor frames the apps).
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

/** Serve a file from `root`, preferring a precompressed .br / .gz sibling the client accepts. */
async function serveStatic(req, res, root, rel) {
  const file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 404, 'not found');
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return send(res, 404, 'not found');
  }
  if (st.isDirectory()) {
    if (!req.url.split('?')[0].endsWith('/')) {
      const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, { Location: req.url.split('?')[0] + '/' + q });
      return res.end();
    }
    return serveStatic(req, res, root, path.join(rel, 'index.html'));
  }
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', Vary: 'Accept-Encoding' };
  // Trunk names the wasm and JS by content hash; those never change. Pages always revalidate.
  headers['Cache-Control'] = /-[0-9a-f]{16}(_bg)?\.(wasm|js|css)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache';
  const accept = String(req.headers['accept-encoding'] || '');
  let body = file;
  let size = st.size;
  for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
    if (!accept.includes(enc)) continue;
    try {
      const cst = await fsp.stat(file + suffix);
      body = file + suffix;
      size = cst.size;
      headers['Content-Encoding'] = enc;
      break;
    } catch {
      /* no precompressed copy */
    }
  }
  headers['Content-Length'] = size;
  headers['Last-Modified'] = st.mtime.toUTCString();
  if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(st.mtime.toUTCString())) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(body).pipe(res);
}

// ---------- routes ----------

async function api(req, res, url, users) {
  const route = url.pathname.slice('/api'.length);
  const ip = req.socket.remoteAddress || '';

  // Mutating calls must come from this site's own scripts (a cross-site form can't set this header).
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-craft'] !== '1') {
    return send(res, 403, { error: 'forbidden' });
  }

  if (route === '/login' && req.method === 'POST') {
    if (tooManyFailures(ip)) return send(res, 429, { error: 'Zu viele Versuche. Bitte später erneut versuchen.' });
    const { user, password } = await readJson(req);
    if (typeof user !== 'string' || typeof password !== 'string' || !checkPassword(users[user], password)) {
      failures.get(ip).push(Date.now());
      return send(res, 401, { error: 'Benutzername oder Passwort falsch.' });
    }
    setSessionCookie(req, res, makeSession(user, users[user].salt.slice(0, 8)), SESSION_MS);
    return send(res, 200, { user });
  }
  if (route === '/logout' && req.method === 'POST') {
    setSessionCookie(req, res, '', 0);
    return send(res, 200, {});
  }

  const user = readSession(cookies(req)[COOKIE], users);
  if (!user) return send(res, 401, { error: 'not signed in' });

  if (route === '/me' && req.method === 'GET') return send(res, 200, { user });

  if (route === '/files' && req.method === 'GET') return send(res, 200, await listFiles(user));

  const m = route.match(/^\/files\/([^/]+)(\/rename)?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  let name;
  try {
    name = decodeURIComponent(m[1]);
  } catch {
    return send(res, 400, { error: 'bad name' });
  }
  if (!validFileName(name)) return send(res, 400, { error: 'Ungültiger Dateiname.' });
  const dir = userDir(user);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);

  if (m[2]) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const { to } = await readJson(req);
    if (!validFileName(to)) return send(res, 400, { error: 'Ungültiger Dateiname.' });
    if (!(await exists(file))) return send(res, 404, { error: 'not found' });
    if (to !== name && (await exists(path.join(dir, to)))) return send(res, 409, { error: 'Eine Datei mit diesem Namen gibt es schon.' });
    await fsp.rename(file, path.join(dir, to));
    return send(res, 200, { name: to });
  }

  switch (req.method) {
    case 'GET':
    case 'HEAD': {
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        return send(res, 404, { error: 'not found' });
      }
      const download = url.searchParams.has('download');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file).pipe(res);
    }
    case 'PUT': {
      // ?mode=create never overwrites: the file gets the next free name, which is returned.
      const target = url.searchParams.get('mode') === 'create' ? await freeName(dir, name) : name;
      const size = await writeBody(req, path.join(dir, target));
      return send(res, 200, { name: target, size });
    }
    case 'DELETE':
      try {
        await fsp.unlink(file);
      } catch {
        return send(res, 404, { error: 'not found' });
      }
      return send(res, 200, {});
    default:
      return send(res, 405, { error: 'method not allowed' });
  }
}

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'bad request');
  }
  if (pathname.includes('\0')) return send(res, 400, 'bad request');

  if (pathname === '/healthz') return send(res, 200, 'ok');
  if (pathname.startsWith('/api/')) return api(req, res, url, loadUsers());
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');

  // /apps/word/…, /apps/grid/…, /apps/deck/…: the Trunk builds.
  if (pathname.startsWith('/apps/')) return serveStatic(req, res, APPS_DIR, path.normalize(pathname.slice('/apps/'.length)));
  return serveStatic(req, res, PUBLIC_DIR, path.normalize(pathname.slice(1)));
}

// ---------- cli ----------

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function cli(args) {
  const [cmd, name, pass] = args;
  const users = loadUsers();
  if (cmd === 'adduser') {
    if (!validUserName(name)) throw new Error('user name: letters, digits, . _ - (up to 64)');
    const password = pass ?? (await prompt(`Password for ${name}: `));
    if (password.length < 8) throw new Error('password: at least 8 characters');
    users[name] = hashPassword(password);
    saveUsers(users);
    console.log(`user ${name} saved`);
  } else if (cmd === 'deluser') {
    if (!users[name]) throw new Error(`no user ${name}`);
    delete users[name];
    saveUsers(users);
    console.log(`user ${name} removed (files kept in ${userDir(name)})`);
  } else {
    throw new Error(`unknown command ${cmd}`);
  }
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  if (args.length) return cli(args);

  SECRET = sessionSecret();
  const users = loadUsers();
  if (Object.keys(users).length === 0) {
    const name = process.env.ADMIN_USER;
    const password = process.env.ADMIN_PASSWORD;
    if (name && password && validUserName(name) && password.length >= 8) {
      users[name] = hashPassword(password);
      saveUsers(users);
      console.log(`created user ${name} from ADMIN_USER / ADMIN_PASSWORD`);
    } else {
      console.warn('no users yet: set ADMIN_USER and ADMIN_PASSWORD (8+ characters), or run `node server.js adduser NAME`');
    }
  }
  await fsp.mkdir(FILES_DIR, { recursive: true });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      else res.destroy();
      if (!e.status) console.error(e);
    });
  });
  server.requestTimeout = 0; // large uploads on slow links
  server.listen(PORT, () => console.log(`Craft Office portal on :${PORT} (data ${DATA_DIR}, apps ${APPS_DIR})`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
