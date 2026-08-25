/* Tilt Spike: a dependency-free SPA served straight from GitHub Pages. */

const tilt = {
  x: 0,          // roll, degrees, positive = right edge down
  y: 0,          // pitch, degrees, positive = top edge away
  source: 'none' // 'sensor' | 'mouse' | 'none'
};

const gate = {
  el: document.getElementById('gate'),
  msg: document.getElementById('gate-msg'),
  btn: document.getElementById('gate-btn'),
  skip: document.getElementById('gate-skip')
};

const needsPermission =
  typeof DeviceOrientationEvent !== 'undefined' &&
  typeof DeviceOrientationEvent.requestPermission === 'function';

function onOrientation(e) {
  if (e.gamma === null && e.beta === null) return;
  tilt.source = 'sensor';
  // Clamp so a phone held upright doesn't send the marble into orbit.
  tilt.x = Math.max(-45, Math.min(45, e.gamma || 0));
  tilt.y = Math.max(-45, Math.min(45, (e.beta || 0) - 35));
}

function startSensor() {
  window.addEventListener('deviceorientation', onOrientation);
}

function useMouseFallback() {
  tilt.source = 'mouse';
  const track = (cx, cy) => {
    tilt.x = ((cx / window.innerWidth) * 2 - 1) * 30;
    tilt.y = ((cy / window.innerHeight) * 2 - 1) * 30;
  };
  window.addEventListener('mousemove', e => track(e.clientX, e.clientY));
  window.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (t) track(t.clientX, t.clientY);
  }, { passive: true });
}

function openGate() {
  if (!needsPermission) {
    // Android Chrome and desktop with a sensor: just listen. If nothing ever
    // fires, the mouse fallback below still drives things.
    startSensor();
    useMouseFallback();
    return;
  }
  gate.el.hidden = false;
}

gate.btn.addEventListener('click', async () => {
  try {
    const state = await DeviceOrientationEvent.requestPermission();
    if (state === 'granted') {
      startSensor();
      gate.el.hidden = true;
    } else {
      gate.msg.textContent =
        'Permission denied. Enable Motion & Orientation Access in Settings, or use the mouse fallback.';
    }
  } catch (err) {
    gate.msg.textContent = 'Could not request motion access: ' + err.message;
  }
});

gate.skip.addEventListener('click', () => {
  useMouseFallback();
  gate.el.hidden = true;
});

/* ---------- routing ---------- */

const routes = {
  '/marble': { tpl: 'tpl-marble', mount: mountMarble },
  '/level': { tpl: 'tpl-level', mount: mountLevel },
  '/about': { tpl: 'tpl-about', mount: () => () => {} }
};

const view = document.getElementById('view');
let unmount = null;

function currentPath() {
  const raw = location.hash.replace(/^#/, '');
  return routes[raw] ? raw : '/marble';
}

function render() {
  const path = currentPath();
  if (unmount) unmount();
  unmount = null;

  const tpl = document.getElementById(routes[path].tpl);
  view.replaceChildren(tpl.content.cloneNode(true));
  unmount = routes[path].mount() || null;

  document.querySelectorAll('nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.route === path);
  });
}

window.addEventListener('hashchange', render);

/* ---------- marble ---------- */

const LEVELS = [
  { walls: [[0.0, 0.45, 0.62, 0.05]], hole: [0.5, 0.85], start: [0.5, 0.12] },
  { walls: [[0.38, 0.3, 0.62, 0.05], [0.0, 0.6, 0.62, 0.05]], hole: [0.82, 0.86], start: [0.15, 0.1] },
  {
    walls: [[0.0, 0.25, 0.75, 0.05], [0.25, 0.5, 0.75, 0.05], [0.0, 0.75, 0.75, 0.05]],
    hole: [0.87, 0.9],
    start: [0.1, 0.08]
  }
];

function mountMarble() {
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const lvlEl = document.getElementById('lvl');
  const timeEl = document.getElementById('time');

  let levelIndex = 0;
  let ball = { x: 0, y: 0, vx: 0, vy: 0 };
  const R = 14;
  let startedAt = performance.now();
  let won = false;
  let raf = 0;

  function fit() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function size() {
    const dpr = window.devicePixelRatio || 1;
    return { w: canvas.width / dpr, h: canvas.height / dpr };
  }

  function level() {
    return LEVELS[levelIndex];
  }

  function walls() {
    const { w, h } = size();
    return level().walls.map(([x, y, ww, hh]) => ({
      x: x * w, y: y * h, w: ww * w, h: hh * h
    }));
  }

  function hole() {
    const { w, h } = size();
    const [hx, hy] = level().hole;
    return { x: hx * w, y: hy * h, r: R + 8 };
  }

  function reset() {
    const { w, h } = size();
    const [sx, sy] = level().start;
    ball = { x: sx * w, y: sy * h, vx: 0, vy: 0 };
    startedAt = performance.now();
    won = false;
    lvlEl.textContent = String(levelIndex + 1);
  }

  function collide(w) {
    // Push the ball out along the shallowest axis of overlap.
    const nx = Math.max(w.x, Math.min(ball.x, w.x + w.w));
    const ny = Math.max(w.y, Math.min(ball.y, w.y + w.h));
    const dx = ball.x - nx;
    const dy = ball.y - ny;
    if (dx * dx + dy * dy >= R * R) return;

    if (Math.abs(dx) > Math.abs(dy)) {
      ball.x = dx > 0 ? nx + R : nx - R;
      ball.vx *= -0.35;
    } else {
      ball.y = dy > 0 ? ny + R : ny - R;
      ball.vy *= -0.35;
    }
  }

  function step(dt) {
    if (won) return;
    const { w, h } = size();

    ball.vx += tilt.x * 0.06 * dt;
    ball.vy += tilt.y * 0.06 * dt;
    ball.vx *= 0.99;
    ball.vy *= 0.99;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    if (ball.x < R) { ball.x = R; ball.vx *= -0.4; }
    if (ball.x > w - R) { ball.x = w - R; ball.vx *= -0.4; }
    if (ball.y < R) { ball.y = R; ball.vy *= -0.4; }
    if (ball.y > h - R) { ball.y = h - R; ball.vy *= -0.4; }

    walls().forEach(collide);

    const g = hole();
    if (Math.hypot(ball.x - g.x, ball.y - g.y) < g.r - 4) {
      won = true;
      if (navigator.vibrate) navigator.vibrate(60);
      setTimeout(() => {
        levelIndex = (levelIndex + 1) % LEVELS.length;
        reset();
      }, 550);
    } else {
      timeEl.textContent = ((performance.now() - startedAt) / 1000).toFixed(1);
    }
  }

  function draw() {
    const { w, h } = size();
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#232838';
    walls().forEach(o => {
      ctx.beginPath();
      ctx.roundRect(o.x, o.y, o.w, o.h, 5);
      ctx.fill();
    });

    const g = hole();
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
    ctx.fillStyle = won ? 'rgba(92,225,185,0.55)' : 'rgba(92,225,185,0.18)';
    ctx.fill();
    ctx.strokeStyle = '#5ce1b9';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(ball.x, ball.y, R, 0, Math.PI * 2);
    ctx.fillStyle = '#e8ecf6';
    ctx.fill();

    if (tilt.source === 'none') {
      ctx.fillStyle = '#8b93a7';
      ctx.font = '13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('waiting for tilt input…', w / 2, h - 14);
    }
  }

  let last = performance.now();
  function loop(now) {
    // dt in 60ths of a second, capped so a backgrounded tab doesn't teleport.
    const dt = Math.min((now - last) / 16.67, 3);
    last = now;
    step(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }

  const onResize = () => { fit(); reset(); };
  window.addEventListener('resize', onResize);
  document.getElementById('reset').addEventListener('click', reset);

  fit();
  reset();
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
  };
}

/* ---------- bubble level ---------- */

function mountLevel() {
  const bubble = document.getElementById('bubble');
  const pitchEl = document.getElementById('pitch');
  const rollEl = document.getElementById('roll');
  let raf = 0;
  let px = 0;
  let py = 0;

  function loop() {
    const wrap = bubble.parentElement.getBoundingClientRect();
    const limit = wrap.width / 2 - 26;
    const tx = Math.max(-limit, Math.min(limit, (tilt.x / 30) * limit));
    const ty = Math.max(-limit, Math.min(limit, (tilt.y / 30) * limit));

    px += (tx - px) * 0.12;
    py += (ty - py) * 0.12;

    bubble.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
    pitchEl.textContent = tilt.y.toFixed(1);
    rollEl.textContent = tilt.x.toFixed(1);
    raf = requestAnimationFrame(loop);
  }

  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}

openGate();
render();
