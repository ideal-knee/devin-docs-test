/* Reminders Mirror: reads a JSON snapshot an iOS Shortcut commits to a private repo.
   The page itself is public, so the read-only token lives in localStorage per device. */

const STORE_KEY = 'reminders-config';
const DEFAULTS = {
  repo: 'ideal-knee/reminder-data',
  path: 'reminders.yaml',
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
  return parseSnapshot(await res.text());
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
      const res = await fetch('sample.yaml', { cache: 'no-store' });
      state.data = parseSnapshot(await res.text());
    }
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

function parseSnapshot(text) {
  const data = jsyaml.load(text);
  if (!data || typeof data !== 'object' || !Array.isArray(data.reminders)) {
    throw new Error('snapshot is not valid reminders YAML');
  }
  return data;
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

/* ---------- stats view ---------- */

const DAY = 86400000;
const CHART_DAYS = 14;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function humanDuration(ms) {
  if (ms === null) return '\u2014';
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.round(ms / 60000)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function summarize(reminders) {
  const now = new Date();
  const done = reminders.filter(r => r.completed);
  const open = reminders.filter(r => !r.completed);

  // Each metric uses only the rows carrying the dates it needs, so a snapshot
  // missing `created` still yields completion and punctuality numbers.
  const judged = done.filter(r => parseDate(r.completed_at) && parseDate(r.due));
  const late = judged.filter(r => parseDate(r.completed_at) > parseDate(r.due));
  const ages = done
    .map(r => [parseDate(r.created), parseDate(r.completed_at)])
    .filter(([c, d]) => c && d)
    .map(([c, d]) => d - c);
  const openAges = open
    .map(r => parseDate(r.created))
    .filter(Boolean)
    .map(c => now - c);

  return {
    total: reminders.length,
    open: open.length,
    done: done.length,
    overdue: open.filter(r => parseDate(r.due) && parseDate(r.due) < now).length,
    completionRate: reminders.length ? done.length / reminders.length : null,
    onTimeRate: judged.length ? 1 - late.length / judged.length : null,
    judged: judged.length,
    medianTimeToDone: median(ages),
    medianOpenAge: median(openAges),
    missing: {
      created: reminders.filter(r => !parseDate(r.created)).length,
      completedAt: done.filter(r => !parseDate(r.completed_at)).length
    }
  };
}

function completionsByDay(reminders, days) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    buckets.push({ date: new Date(start - i * DAY), count: 0 });
  }
  for (const r of reminders) {
    const at = parseDate(r.completed_at);
    if (!at) continue;
    const index = Math.floor((at - buckets[0].date) / DAY);
    if (index >= 0 && index < buckets.length) buckets[index].count++;
  }
  return buckets;
}

function byList(reminders) {
  const now = new Date();
  const groups = new Map();
  for (const r of reminders) {
    const name = r.list || '(no list)';
    if (!groups.has(name)) groups.set(name, { name, open: 0, done: 0, late: 0, ages: [] });
    const g = groups.get(name);
    const completedAt = parseDate(r.completed_at);
    const created = parseDate(r.created);
    if (r.completed) {
      g.done++;
      const due = parseDate(r.due);
      if (completedAt && due && completedAt > due) g.late++;
      if (created && completedAt) g.ages.push(completedAt - created);
    } else {
      g.open++;
      if (created) g.ages.push(now - created);
    }
  }
  return [...groups.values()].sort((a, b) => b.open + b.done - (a.open + a.done));
}

function card(label, value, hint) {
  const el = document.createElement('div');
  el.className = 'card';
  const strong = document.createElement('b');
  strong.textContent = value;
  const span = document.createElement('span');
  span.textContent = label;
  el.append(strong, span);
  if (hint) el.title = hint;
  return el;
}

function percent(rate) {
  return rate === null ? '\u2014' : `${Math.round(rate * 100)}%`;
}

function mountStats() {
  const status = document.getElementById('stats-status');
  const reminders = (state.data && state.data.reminders) || [];

  status.classList.remove('error');
  if (state.loading) {
    status.textContent = 'Loading\u2026';
  } else if (state.error) {
    status.textContent = `Could not load the snapshot \u2014 ${state.error}`;
    status.classList.add('error');
  } else if (state.demo) {
    status.innerHTML = 'Sample data. <a href="#/settings">Connect your private repo</a> for real numbers.';
  } else {
    status.textContent = '';
  }

  const s = summarize(reminders);
  document.getElementById('cards').append(
    card('open', s.open),
    card('overdue', s.overdue),
    card('completed', s.done),
    card('completion rate', percent(s.completionRate)),
    card('on time', percent(s.onTimeRate), `of the ${s.judged} completed items that had a due date`),
    card('median time to done', humanDuration(s.medianTimeToDone)),
    card('median age, open', humanDuration(s.medianOpenAge))
  );

  const buckets = completionsByDay(reminders, CHART_DAYS);
  const peak = Math.max(1, ...buckets.map(b => b.count));
  const chart = document.getElementById('chart');
  for (const b of buckets) {
    const col = document.createElement('div');
    col.className = 'bar';
    col.style.setProperty('--h', `${(b.count / peak) * 100}%`);
    col.title = `${b.date.toLocaleDateString()}: ${b.count}`;
    const n = document.createElement('span');
    n.textContent = b.count || '';
    col.appendChild(n);
    chart.appendChild(col);
  }
  const fmt = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  document.getElementById('chart-range').textContent =
    `${fmt(buckets[0].date)} \u2013 ${fmt(buckets[buckets.length - 1].date)}`;

  const tbody = document.querySelector('#by-list tbody');
  for (const g of byList(reminders)) {
    const tr = document.createElement('tr');
    for (const value of [g.name, g.open, g.done, g.late, humanDuration(median(g.ages))]) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  const gaps = [];
  if (s.missing.created) gaps.push(`${s.missing.created} without a "created" date`);
  if (s.missing.completedAt) gaps.push(`${s.missing.completedAt} completed without a "completed_at" date`);
  const gapsEl = document.getElementById('stats-gaps');
  gapsEl.hidden = gaps.length === 0;
  gapsEl.textContent = gaps.length
    ? `Age and punctuality figures skip rows missing dates: ${gaps.join(', ')}. The Setup tab lists the Shortcut fields that fill them in.`
    : '';
}

/* ---------- dashboard view ---------- */

function recentlyCompleted(reminders, n) {
  return reminders
    .filter(r => r.completed && parseDate(r.completed_at))
    .sort((a, b) => parseDate(b.completed_at) - parseDate(a.completed_at))
    .slice(0, n);
}

function startOfDay(d) {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

function completedToday(reminders) {
  const start = startOfDay(new Date());
  return reminders.filter(r => {
    const at = parseDate(r.completed_at);
    return at && at >= start;
  }).length;
}

function completedWithinDays(reminders, days) {
  const now = new Date();
  return reminders.filter(r => {
    const at = parseDate(r.completed_at);
    return at && (now - at) <= days * DAY;
  }).length;
}

function monthRanking(reminders, monthsBack) {
  const now = new Date();
  const counts = new Map();
  const labels = new Map();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    counts.set(key, 0);
    labels.set(key, d.toLocaleString(undefined, { year: 'numeric', month: 'short' }));
  }
  for (const r of reminders) {
    const at = parseDate(r.completed_at);
    if (!at) continue;
    const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }
  const ranked = [...counts.entries()]
    .map(([key, count]) => ({ key, label: labels.get(key), count }))
    .sort((a, b) => b.count - a.count || b.key.localeCompare(a.key));
  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

function openAgeBuckets(reminders) {
  const now = new Date();
  const buckets = { total: 0, '0-1 day': 0, '1-7 days': 0, '8-30 days': 0, '>30 days': 0 };
  for (const r of reminders) {
    if (r.completed) continue;
    const created = parseDate(r.created);
    if (!created) continue;
    const age = (now - created) / DAY;
    buckets.total++;
    if (age <= 1) buckets['0-1 day']++;
    else if (age <= 7) buckets['1-7 days']++;
    else if (age <= 30) buckets['8-30 days']++;
    else buckets['>30 days']++;
  }
  return buckets;
}

function mountDashboard() {
  const status = document.getElementById('dashboard-status');
  const reminders = (state.data && state.data.reminders) || [];

  status.classList.remove('error');
  if (state.loading) {
    status.textContent = 'Loading…';
  } else if (state.error) {
    status.textContent = `Could not load the snapshot — ${state.error}`;
    status.classList.add('error');
  } else if (state.demo) {
    status.innerHTML = 'Sample data. <a href="#/settings">Connect your private repo</a> for real numbers.';
  } else {
    status.textContent = '';
  }

  const completedCards = document.getElementById('completed-cards');
  completedCards.append(
    card('today', completedToday(reminders)),
    card('last 7 days', completedWithinDays(reminders, 7)),
    card('last 30 days', completedWithinDays(reminders, 30)),
    card('total completed', reminders.filter(r => r.completed).length)
  );

  const age = openAgeBuckets(reminders);
  const ageCards = document.getElementById('age-cards');
  ageCards.append(
    card('open', age.total),
    card('0–1 day', age['0-1 day']),
    card('1–7 days', age['1-7 days']),
    card('8–30 days', age['8-30 days']),
    card('>30 days', age['>30 days'])
  );

  const recent = document.getElementById('recent');
  for (const r of recentlyCompleted(reminders, 8)) {
    const li = document.createElement('li');
    li.className = 'item done';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = r.title || '(untitled)';
    li.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const listSpan = document.createElement('span');
    listSpan.className = 'tag';
    listSpan.textContent = r.list || '(no list)';
    meta.appendChild(listSpan);
    const at = parseDate(r.completed_at);
    const dateSpan = document.createElement('span');
    dateSpan.className = 'tag';
    dateSpan.textContent = at.toLocaleDateString();
    meta.appendChild(dateSpan);
    li.appendChild(meta);
    recent.appendChild(li);
  }

  const tbody = document.querySelector('#month-rank tbody');
  for (const m of monthRanking(reminders, 12)) {
    const tr = document.createElement('tr');
    for (const v of [m.label, m.count, m.rank]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
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
  return ['/open', '/all', '/stats', '/dashboard', '/settings', '/setup'].includes(r) ? r : '/open';
}

function templateFor(route) {
  if (route === '/stats') return 'tpl-stats';
  if (route === '/dashboard') return 'tpl-dashboard';
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

  if (route === '/stats') mountStats();
  else if (route === '/dashboard') mountDashboard();
  else if (route === '/settings') mountSettings();
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
