/* Reminders Mirror: reads a JSON snapshot an iOS Shortcut commits to a private repo.
   The page itself is public, so the read-only token lives in localStorage per device. */

const STORE_KEY = 'reminders-config';
const DEFAULTS = {
  repo: 'ideal-knee/reminder-data',
  path: 'reminders.json',
  branch: 'main',
  token: '',   // plain text, only when no passcode is set
  enc: null    // { salt, iv, ct } base64, when a passcode is set
};
const PBKDF2_ITERATIONS = 250000;

const state = {
  config: loadConfig(),
  token: '',   // decrypted token, memory only
  data: null,
  error: null,
  loading: false,
  demo: false,
  query: '',
  list: ''
};

const view = document.getElementById('view');
const stamp = document.getElementById('stamp');
const modeTag = document.getElementById('mode');
const gate = document.getElementById('gate');

/* ---------- config ---------- */

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(config) {
  state.config = { ...DEFAULTS, ...config };
  localStorage.setItem(STORE_KEY, JSON.stringify(state.config));
}

function locked() {
  return Boolean(state.config.enc) && !state.token;
}

function configured() {
  const { repo, path } = state.config;
  return Boolean(repo && path && state.token);
}

/* ---------- token encryption ----------
   AES-GCM under a PBKDF2-derived key, so a stolen device yields only ciphertext. */

const b64 = {
  encode: bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))),
  decode: text => Uint8Array.from(atob(text), c => c.charCodeAt(0))
};

async function deriveKey(passcode, salt) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptToken(token, passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passcode, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(token)
  );
  return { salt: b64.encode(salt), iv: b64.encode(iv), ct: b64.encode(ct) };
}

async function decryptToken(enc, passcode) {
  const key = await deriveKey(passcode, b64.decode(enc.salt));
  // A wrong passcode fails the GCM tag check and throws.
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64.decode(enc.iv) }, key, b64.decode(enc.ct)
  );
  return new TextDecoder().decode(plain);
}

/* ---------- data ---------- */

async function fetchSnapshot() {
  const { repo, path, branch } = state.config;
  const token = state.token;
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch || 'main')}&t=${Date.now()}`;
  // The raw media type returns the file body itself rather than base64 in a wrapper.
  const res = await fetch(url, {
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (res.status === 401) throw new Error('token rejected (401) — expired or revoked?');
  if (res.status === 403) throw new Error('forbidden (403) — token lacks Contents: Read on this repo');
  if (res.status === 404) throw new Error('not found (404) — check the repo, branch and file path');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function load() {
  if (locked()) {
    state.loading = false;
    render();
    return;
  }
  state.loading = true;
  state.error = null;
  render();
  try {
    if (configured()) {
      state.demo = false;
      state.data = await fetchSnapshot();
    } else {
      state.demo = true;
      const res = await fetch('sample.json', { cache: 'no-store' });
      state.data = await res.json();
    }
    if (!Array.isArray(state.data.reminders)) throw new Error('no "reminders" array in the JSON');
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- helpers ---------- */

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

function dueLabel(d) {
  const now = new Date();
  const days = Math.round((d - now) / 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d < now) return `overdue \u2014 ${d.toLocaleDateString()}`;
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

function visible(reminders, showCompleted) {
  const q = state.query.trim().toLowerCase();
  return reminders
    .filter(r => showCompleted || !r.completed)
    .filter(r => !state.list || (r.list || '') === state.list)
    .filter(r => !q || [r.title, r.list, r.notes].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => {
      if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
      const da = parseDate(a.due);
      const db = parseDate(b.due);
      if (da && db) return da - db;
      if (da) return -1;
      if (db) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });
}

/* ---------- list view ---------- */

function renderItems(showCompleted) {
  const items = document.getElementById('items');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');

  status.classList.remove('error');
  if (state.loading) {
    status.textContent = 'Loading\u2026';
  } else if (state.error) {
    status.textContent = `Could not load the snapshot \u2014 ${state.error}`;
    status.classList.add('error');
  } else if (state.demo) {
    status.innerHTML = 'Showing sample data. <a href="#/settings">Connect your private repo</a> to see real reminders.';
  } else {
    status.textContent = '';
  }

  items.innerHTML = '';
  const rows = state.data ? visible(state.data.reminders || [], showCompleted) : [];
  empty.hidden = rows.length > 0 || state.loading || !!state.error;

  for (const r of rows) {
    const li = document.createElement('li');
    li.className = `item${r.completed ? ' done' : ''}`;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = r.title || '(untitled)';
    li.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const tags = [];
    if (r.list) tags.push({ text: r.list });
    const due = parseDate(r.due);
    if (due) tags.push({ text: dueLabel(due), cls: due < new Date() ? 'due-soon' : '' });
    if (r.flagged) tags.push({ text: 'flagged', cls: 'flag' });
    if (r.priority) tags.push({ text: `priority ${r.priority}` });
    for (const t of tags) {
      const span = document.createElement('span');
      span.className = `tag ${t.cls || ''}`.trim();
      span.textContent = t.text;
      meta.appendChild(span);
    }
    if (meta.childElementCount) li.appendChild(meta);

    if (r.notes) {
      const p = document.createElement('p');
      p.className = 'notes';
      p.textContent = r.notes;
      li.appendChild(p);
    }
    items.appendChild(li);
  }
}

function mountList(showCompleted) {
  const q = document.getElementById('q');
  const listFilter = document.getElementById('list-filter');

  q.value = state.query;
  const lists = state.data
    ? [...new Set((state.data.reminders || []).map(r => r.list).filter(Boolean))].sort()
    : [];
  for (const name of lists) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    listFilter.appendChild(opt);
  }
  listFilter.value = lists.includes(state.list) ? state.list : '';

  q.addEventListener('input', () => { state.query = q.value; renderItems(showCompleted); });
  listFilter.addEventListener('change', () => { state.list = listFilter.value; renderItems(showCompleted); });
  document.getElementById('refresh').addEventListener('click', load);

  renderItems(showCompleted);
}

/* ---------- settings view ---------- */

function mountSettings() {
  const form = document.getElementById('settings-form');
  const repo = document.getElementById('f-repo');
  const path = document.getElementById('f-path');
  const branch = document.getElementById('f-branch');
  const token = document.getElementById('f-token');
  const pass = document.getElementById('f-pass');
  const lock = document.getElementById('f-lock');
  const msg = document.getElementById('settings-msg');

  repo.value = state.config.repo;
  path.value = state.config.path;
  branch.value = state.config.branch;
  token.value = state.token;
  lock.hidden = !state.config.enc || !state.token;

  if (state.config.enc && !token.value) {
    token.placeholder = 'encrypted \u2014 leave blank to keep the stored token';
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    msg.classList.remove('error');

    const value = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
      msg.textContent = 'Repo should look like owner/name.';
      msg.classList.add('error');
      return;
    }

    const next = {
      ...state.config,
      repo: value,
      path: path.value.trim().replace(/^\//, '') || DEFAULTS.path,
      branch: branch.value.trim() || DEFAULTS.branch
    };
    const entered = token.value.trim();
    const passcode = pass.value;

    if (entered) state.token = entered;
    if (passcode) {
      if (!state.token) {
        msg.textContent = 'Enter the token before setting a passcode.';
        msg.classList.add('error');
        return;
      }
      msg.textContent = 'Encrypting\u2026';
      next.enc = await encryptToken(state.token, passcode);
      next.token = '';
    } else if (entered) {
      // A new token typed with no passcode replaces any encrypted copy.
      next.enc = null;
      next.token = state.token;
    }
    saveConfig(next);
    pass.value = '';

    msg.textContent = 'Checking\u2026';
    await load();
    if (state.error) {
      msg.textContent = state.error;
      msg.classList.add('error');
    } else {
      location.hash = '#/open';
    }
  });

  lock.addEventListener('click', () => {
    state.token = '';
    state.data = null;
    render();
  });

  document.getElementById('f-clear').addEventListener('click', () => {
    saveConfig({ ...state.config, token: '', enc: null });
    state.token = '';
    token.value = '';
    msg.classList.remove('error');
    msg.textContent = 'Token cleared from this browser.';
    load();
  });
}

/* ---------- unlock gate ---------- */

function mountGate() {
  const form = document.getElementById('gate-form');
  const input = document.getElementById('gate-pass');
  const msg = document.getElementById('gate-msg');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    msg.classList.remove('error');
    msg.textContent = 'Unlocking\u2026';
    try {
      state.token = await decryptToken(state.config.enc, input.value);
      input.value = '';
      msg.textContent = '';
      load();
    } catch {
      msg.textContent = 'Wrong passcode.';
      msg.classList.add('error');
    }
  });

  document.getElementById('gate-skip').addEventListener('click', () => {
    state.config = { ...state.config, enc: null };  // this session only; storage untouched
    load();
  });
}

/* ---------- routing ---------- */

function currentRoute() {
  const r = location.hash.replace(/^#/, '');
  return ['/open', '/all', '/settings', '/setup'].includes(r) ? r : '/open';
}

function templateFor(route) {
  if (route === '/settings') return 'tpl-settings';
  if (route === '/setup') return 'tpl-setup';
  return 'tpl-list';
}

function render() {
  const route = currentRoute();
  for (const a of document.querySelectorAll('nav a')) {
    a.classList.toggle('active', a.dataset.route === route);
  }

  gate.hidden = !locked();

  view.replaceChildren(document.getElementById(templateFor(route)).content.cloneNode(true));

  if (route === '/settings') mountSettings();
  else if (route !== '/setup') mountList(route === '/all');

  if (locked()) modeTag.textContent = 'locked';
  else modeTag.textContent = state.demo ? 'sample data' : state.config.repo;
  const generated = state.data && parseDate(state.data.generated_at);
  stamp.textContent = generated ? `snapshot ${generated.toLocaleString()}` : '';
}

window.addEventListener('hashchange', render);

state.token = state.config.token || '';
mountGate();
render();
load();
