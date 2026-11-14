/* Cricket — a minimal remake of the Nokia classic.
   Vanilla JS, single canvas, no dependencies. */
(() => {
  'use strict';

  /* ───────────────────────── helpers ───────────────────────── */
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const pickWeighted = (list) => {
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [v, w] of list) { if ((r -= w) <= 0) return v; }
    return list[list.length - 1][0];
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  const ACCENT = '#c8f560';
  const DANGER = '#ff5f57';

  /* ───────────────────────── config ───────────────────────── */
  const settings = Object.assign(
    { mode: 'chase', overs: 2, wickets: 3, diff: 'normal', sound: true },
    store.get('cricket.settings', {})
  );
  const saveSettings = () => store.set('cricket.settings', settings);

  const DIFF = {
    easy:   { speed: [1300, 1520], win: 1.4,  rpo: 7.5,  swing: 0.10 },
    normal: { speed: [1020, 1240], win: 1.0,  rpo: 9.5,  swing: 0.16 },
    hard:   { speed: [800, 980],   win: 0.78, rpo: 11.5, swing: 0.22 },
  };

  const U_HIT = 0.94;        // fraction of the delivery at which ball meets the bat
  const BASE_WIN = 140;      // ms timing window (scaled by difficulty)
  const RUNUP = 1100;        // bowler run-up ms
  const READY = 700;         // pause between balls
  const STUMP_HALF = 0.1;    // world units (1 unit = 1.5 m across, 20 m along)
  const STUMP_H = 0.78;      // metres (incl. ball radius)
  const BAT_X = -0.28, BAT_Z = 0.045;
  const REST = 80, BACK = -55;
  const SWING_END = { off: -330, leg: 200, loft: 285, block: 95 };
  const SWING_MS = 240;

  /* ───────────────────────── DOM ───────────────────────── */
  const canvas = $('#game');
  const ctx = canvas.getContext('2d');
  const el = {
    runs: $('#runs'), wkts: $('#wkts'), overs: $('#overs'), oversMax: $('#oversMax'),
    chase: $('#chase'), rr: $('#rr'), fours: $('#fours'), sixes: $('#sixes'),
    score: document.querySelector('.score'), balls: $('#balls'),
    toast: $('#toast'), toastMain: $('#toastMain'), toastSub: $('#toastSub'), hint: $('#hint'),
    menu: $('#menu'), pause: $('#pause'), over: $('#over'),
    btnSound: $('#btnSound'), btnPause: $('#btnPause'), bestLine: $('#bestLine'),
    overTitle: $('#overTitle'), overEyebrow: $('#overEyebrow'), sumGrid: $('#sumGrid'), wagon: $('#wagon'),
  };

  /* ───────────────────────── sound (Nokia-ish square beeps) ───────────────────────── */
  let actx = null;
  function beep(freq, dur = 0.06, delay = 0, type = 'square', vol = 0.045) {
    if (!settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const t = actx.currentTime + delay;
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* audio unavailable */ }
  }
  const sfx = {
    bounce: () => beep(160, 0.035, 0, 'triangle', 0.05),
    hit:    () => beep(920, 0.05),
    block:  () => beep(420, 0.04),
    four:   () => [660, 880, 1100].forEach((f, i) => beep(f, 0.07, i * 0.07)),
    six:    () => [660, 880, 1100, 1320, 1760].forEach((f, i) => beep(f, 0.07, i * 0.065)),
    out:    () => [520, 390, 260].forEach((f, i) => beep(f, 0.12, i * 0.11)),
    swish:  () => beep(240, 0.03, 0, 'sawtooth', 0.02),
    start:  () => [523, 659, 784].forEach((f, i) => beep(f, 0.06, i * 0.06)),
  };
  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} };

  /* ───────────────────────── game state ───────────────────────── */
  const G = {
    state: 'menu', paused: false, t0: 0,
    runs: 0, wkts: 0, balls: 0, fours: 0, sixes: 0, dots: 0, extras: 0,
    target: 0, overBalls: [], overReset: false, shots: [], shotsPlayed: 0,
    ball: null, swing: null, flight: null, bowled: null,
    trail: [], mark: null,
    lastAngle: REST,
  };

  /* ───────────────────────── clock ───────────────────────── */
  let clock = 0, lastFrame = performance.now();
  const nowClock = () => clock + (G.paused ? 0 : Math.min(50, performance.now() - lastFrame));

  /* ───────────────────────── projection ───────────────────────── */
  let W = 0, H = 0, DPR = 1, cx = 0, hw = 0, yN = 0, hy = 0, mPx = 0;
  const D = 2.0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cx = W / 2;
    hw = W * 0.36;
    yN = H * 0.74;
    const yF = H * 0.25;
    hy = (yF * (1 + D) - yN) / D;
    mPx = (hw / 1.5) * 0.85;
  }
  // world (x across, z along pitch 0=batsman stumps → 1=bowler stumps, h metres) → screen
  function P(x, z, h = 0) {
    const s = 1 / (1 + D * Math.max(z, -0.4));
    return { x: cx + x * hw * s, y: hy + (yN - hy) * s - h * mPx * s, s };
  }

  /* ───────────────────────── ball model ───────────────────────── */
  function genBall() {
    const d = DIFF[settings.diff];
    const pz = pickWeighted([[0.07, 1], [0.22, 3], [0.36, 4], [0.52, 2], [0.64, 1]]) + rand(-0.025, 0.025);
    let x1, wide = false;
    const r = Math.random();
    if (r < 0.04) { wide = true; x1 = Math.random() < 0.55 ? rand(0.8, 0.92) : rand(-0.98, -0.85); }
    else if (r < 0.45) x1 = rand(-0.085, 0.085);   // on the stumps
    else if (r < 0.78) x1 = rand(0.13, 0.45);      // outside off
    else x1 = rand(-0.3, -0.12);                   // down leg
    return {
      T: rand(d.speed[0], d.speed[1]), pz, x0: rand(0.06, 0.18), x1,
      swing: rand(-1, 1) * d.swing, h0: 2.1, wide,
      u: 0, bounced: false, resolved: false, hit: false, checked: false, left: false, missed: false,
    };
  }
  const ballX = (b, u) => b.x0 + (b.x1 - b.x0) * u + b.swing * Math.sin(Math.PI * clamp(u, 0, 1));
  const ballZ = (u) => 1 - u;
  function ballH(b, u) {
    const ub = 1 - b.pz;
    if (u < ub) { const p = u / ub; return b.h0 * (1 - p) + 0.3 * p * (1 - p); }
    const w = u - ub, vb = 1.4 + 5 * b.pz;
    return Math.max(0, vb * w - 4 * w * w);
  }

  /* ───────────────────────── flow ───────────────────────── */
  function startGame() {
    Object.assign(G, {
      runs: 0, wkts: 0, balls: 0, fours: 0, sixes: 0, dots: 0, extras: 0,
      overBalls: [], overReset: false, shots: [], shotsPlayed: 0,
      ball: null, swing: null, flight: null, bowled: null, trail: [], mark: null, paused: false, batAnim: null,
    });
    const d = DIFF[settings.diff];
    G.target = settings.mode === 'chase'
      ? Math.max(4, Math.round(settings.overs * d.rpo * rand(0.9, 1.1)))
      : 0;
    // With few wickets, keep the target fair
    if (settings.mode === 'chase' && settings.wickets === 1) G.target = Math.round(G.target * 0.75);
    hideAll();
    el.hint.classList.remove('hide');
    renderHUD(); renderOver();
    setState('ready');
    sfx.start();
  }

  function setState(s) { G.state = s; G.t0 = clock; }

  function release() {
    G.ball = genBall();
    G.swing = null; G.flight = null; G.trail = [];
    setState('delivery');
    G.ball.tRel = clock;
  }

  function update() {
    const t = clock - G.t0;
    switch (G.state) {
      case 'ready': if (t > READY) setState('runup'); break;
      case 'runup': if (t > RUNUP) release(); break;
      case 'delivery': updateDelivery(); break;
      case 'result':
        if (G.ball && !G.ball.hit) G.ball.u = (clock - G.ball.tRel) / G.ball.T;
        if (t > G.resultDur) nextBall();
        break;
    }
  }

  function updateDelivery() {
    const b = G.ball;
    if (b.tRel == null) b.tRel = G.t0;
    const u = (clock - b.tRel) / b.T;
    b.u = u;
    if (!b.bounced && u >= 1 - b.pz) {
      b.bounced = true; sfx.bounce();
      G.mark = { x: ballX(b, 1 - b.pz), z: b.pz, t: clock };
    }
    if (!b.resolved) {
      const lateU = (BASE_WIN * DIFF[settings.diff].win) / b.T;
      if (G.swing && u >= U_HIT) resolveSwing();
      else if (!G.swing && u >= U_HIT + lateU) { b.resolved = true; b.left = true; }
    }
    if (b.resolved && !b.hit && !b.checked && u >= 1) { b.checked = true; finishMissed(); }
  }

  function nextBall() {
    if (isOver()) return endGame();
    if (G.overReset) { G.overBalls = []; G.overReset = false; renderOver(); }
    G.ball = null; G.swing = null; G.flight = null; G.bowled = null; G.trail = [];
    setState('ready');
  }

  function isOver() {
    return G.wkts >= settings.wickets
      || G.balls >= settings.overs * 6
      || (settings.mode === 'chase' && G.runs >= G.target);
  }

  /* ───────────────────────── batting ───────────────────────── */
  const SWING_HOLD = 200, SWING_RETURN = 280;
  function playShot(shot) {
    flashControl(shot);
    if (G.paused || G.state === 'menu' || G.state === 'over') return;
    // let the previous swing finish its follow-through before swinging again
    if (G.batAnim && clock - G.batAnim.t < SWING_MS + G.batAnim.pre + 120) return;
    const c = nowClock();
    const from = G.lastAngle;
    const needsLift = Math.abs(from - BACK) > 40;      // swinging from the stance: quick backlift first
    G.batAnim = { shot, t: c, from, pre: needsLift ? 110 : 0 };
    sfx.swish();

    if (G.state !== 'delivery' || G.swing) return;     // shadow practice / extra swings don't score
    const b = G.ball;
    const u = (c - b.tRel) / b.T;
    if (b.resolved) { if (b.left && !b.checked) b.lateSwing = true; return; }
    G.swing = { shot, t: c, u };
    G.shotsPlayed++;
    if (G.shotsPlayed >= 2) el.hint.classList.add('hide');
    if (u >= U_HIT) resolveSwing();
  }

  function timingLabel(d, win) {
    if (Math.abs(d) <= win * 0.16) return 'Perfect';
    return (d < 0 ? 'Early ' : 'Late ') + Math.round(Math.abs(d)) + ' ms';
  }

  function resolveSwing() {
    const b = G.ball, s = G.swing;
    b.resolved = true;
    const win = BASE_WIN * DIFF[settings.diff].win;
    const d = (s.u - U_HIT) * b.T;
    const xc = ballX(b, U_HIT), hc = ballH(b, U_HIT);
    s.label = timingLabel(d, win);

    if (b.wide || Math.abs(d) > win) { b.missed = true; s.label = Math.abs(d) > win ? (d < 0 ? 'Too early' : 'Too late') : 'Out of reach'; return; }

    // quality: timing × line × length
    const qt = 1 - Math.abs(d) / win;
    let line = 1;
    if (s.shot === 'off') line = xc >= -0.05 ? 1 : xc >= -0.22 ? 0.65 : 0.4;
    if (s.shot === 'leg') line = xc <= 0.15 ? 1 : xc <= 0.32 ? 0.65 : 0.4;
    if (s.shot === 'loft') line = Math.abs(xc - 0.05) < 0.3 ? 1 : 0.72;
    let len = 1;
    if (hc > 1.0) len = { leg: 1.08, off: 0.72, loft: 0.62, block: 0.85 }[s.shot];
    else if (hc < 0.28) len = { leg: 0.68, off: 0.68, loft: 0.5, block: 1 }[s.shot];
    const q = clamp(qt * line * len, 0, 1);
    s.q = q;

    const res = outcome(s.shot, q);
    b.hit = true;

    // direction: 0 = straight back, + = off side. Late → off, early → leg.
    const base = { off: 0.95, leg: -0.95, loft: 0, block: 0 }[s.shot];
    let phi = base + clamp(d / win, -1, 1) * 0.7 + rand(-0.15, 0.15);
    if (s.shot === 'loft') phi += (xc - 0.05) * 1.2;
    if (s.shot === 'block') phi = rand(-0.4, 0.4);
    phi = clamp(phi, -1.6, 1.6);

    const edge = res.out === 'Caught behind' || (q < 0.25 && !res.out && res.runs === 0 && s.shot !== 'block');
    const dist = res.out ? (edge ? 0 : rand(0.55, 0.85)) : ({ 0: 0.12, 1: 0.4, 2: 0.6, 3: 0.75, 4: 1.08, 6: 1.3 }[res.runs]);
    const air = res.runs === 6 || (res.out && !edge) || (s.shot === 'loft' && res.runs >= 4);

    let x1, z1, endH = 0, dur;
    if (edge) { x1 = xc + 0.25; z1 = -0.14; endH = 0.9; dur = 380; }
    else {
      const Rm = dist * 65;
      x1 = xc + (Math.sin(phi) * Rm) / 5;
      z1 = ballZ(U_HIT) + (Math.cos(phi) * Rm) / 20;
      endH = res.out ? 1.6 : 0;
      dur = res.runs >= 4 ? 1050 : res.out ? 950 : 700;
    }
    G.flight = {
      t: clock, dur, x0: xc, z0: ballZ(U_HIT), h0: hc, x1, z1, endH, air,
      peak: res.runs === 6 ? 8 : res.out && !edge ? 5 : air ? 3.2 : 0,
    };

    if (s.shot === 'block') sfx.block(); else sfx.hit();

    if (res.out) {
      const where = edge ? 'Caught behind' : 'Caught at ' + fieldPos(phi, air);
      settle({ out: where, phi, dist: Math.max(dist, 0.3), sub: where });
    } else {
      settle({ runs: res.runs, phi, dist, sub: s.label });
    }
  }

  function outcome(shot, q) {
    const r = Math.random();
    if (shot === 'block') {
      if (q > 0.6) return { runs: r < 0.25 ? 1 : 0 };
      if (q > 0.3) return { runs: 0 };
      return r < 0.18 ? { out: 'Caught behind' } : { runs: 0 };
    }
    if (shot === 'loft') {
      if (q > 0.86) return { runs: 6 };
      if (q > 0.7) return r < 0.12 ? { out: 'Caught' } : { runs: r < 0.6 ? 6 : 4 };
      if (q > 0.45) return r < 0.35 ? { out: 'Caught' } : { runs: r < 0.7 ? 2 : 1 };
      return r < 0.6 ? { out: 'Caught' } : { runs: 1 };
    }
    // ground drives: off / leg
    if (q > 0.86) return { runs: shot === 'leg' && Math.random() < 0.25 ? 6 : 4 };
    if (q > 0.68) return { runs: r < 0.45 ? 4 : r < 0.8 ? 2 : 3 };
    if (q > 0.45) return { runs: r < 0.5 ? 1 : 2 };
    if (q > 0.25) return r < 0.1 ? { out: 'Caught' } : { runs: r < 0.6 ? 0 : 1 };
    return r < 0.3 ? { out: shot === 'off' ? 'Caught behind' : 'Caught' } : { runs: 0 };
  }

  function fieldPos(a, deep) {
    if (deep && Math.abs(a) < 0.35) return a < 0 ? 'long-on' : 'long-off';
    const name = a < -1.3 ? 'fine leg' : a < -0.8 ? 'square leg' : a < -0.35 ? 'midwicket'
      : a < 0 ? 'mid-on' : a < 0.35 ? 'mid-off' : a < 0.85 ? 'cover' : a < 1.3 ? 'point' : 'third man';
    return (deep && !/^mid-/.test(name) ? 'deep ' : '') + name;
  }

  function finishMissed() {
    const b = G.ball;
    const x = ballX(b, 1), h = ballH(b, 1);
    if (b.wide) return settle({ wide: true });
    if (Math.abs(x) < STUMP_HALF && h < STUMP_H) {
      G.bowled = { t: clock };
      return settle({ out: 'Bowled', sub: b.left ? 'Shouldered arms' : 'Bowled' });
    }
    settle({ runs: 0, dot: true, sub: b.left ? (b.lateSwing ? 'Beaten · Too late' : 'Left alone') : 'Beaten · ' + (G.swing ? G.swing.label : '') });
  }

  /* ───────────────────────── scoring ───────────────────────── */
  function settle(r) {
    let chip, cls = '', main, sub = r.sub || '';
    if (r.wide) {
      G.runs += 1; G.extras += 1;
      chip = { t: 'wd', c: 'x' };
      main = 'Wide'; sub = '+1 extra';
      beep(300, 0.06);
    } else {
      G.balls += 1;
      if (G.balls % 6 === 0) G.overReset = true;
      if (r.out) {
        G.wkts += 1;
        chip = { t: 'W', c: 'w' };
        main = 'OUT'; cls = 'wicket';
        sfx.out(); vibrate([40, 40, 80]);
        if (r.phi != null) G.shots.push({ phi: r.phi, dist: r.dist, out: true });
      } else {
        const n = r.runs;
        G.runs += n;
        if (n === 0) G.dots += 1;
        if (n === 4) G.fours += 1;
        if (n === 6) G.sixes += 1;
        chip = n === 0 ? { t: '•', c: '' } : { t: String(n), c: n === 6 ? 'b6' : n === 4 ? 'b4' : 'run' };
        main = n === 6 ? 'SIX' : n === 4 ? 'FOUR' : n === 0 ? 'Dot ball' : n + (n === 1 ? ' run' : ' runs');
        if (n >= 4) { cls = 'boundary'; (n === 6 ? sfx.six : sfx.four)(); vibrate(25); }
        if (n > 0 && r.phi != null) G.shots.push({ phi: r.phi, dist: r.dist, runs: n });
        if (n > 0) bump();
      }
    }
    G.overBalls.push(chip);
    renderHUD(); renderOver();
    if (settings.mode === 'chase' && G.runs >= G.target) { sub = 'Target reached'; }
    toast(main, sub, cls);
    G.resultDur = r.out ? 1900 : r.runs >= 4 ? 1650 : 1250;
    setState('result');
  }

  function bump() {
    el.score.classList.remove('bump'); void el.score.offsetWidth; el.score.classList.add('bump');
  }

  let toastTimer = 0;
  function toast(main, sub, cls) {
    el.toast.className = 'toast ' + (cls || '');
    el.toastMain.textContent = main;
    el.toastSub.textContent = sub || '';
    requestAnimationFrame(() => el.toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), cls === 'wicket' ? 1600 : 1150);
  }

  /* ───────────────────────── HUD ───────────────────────── */
  const oversStr = (b) => Math.floor(b / 6) + '.' + (b % 6);
  function renderHUD() {
    el.runs.textContent = G.runs;
    el.wkts.textContent = G.wkts;
    el.overs.textContent = oversStr(G.balls);
    el.oversMax.textContent = settings.overs;
    el.rr.textContent = G.balls ? (G.runs / G.balls * 6).toFixed(2) : '0.00';
    el.fours.textContent = G.fours;
    el.sixes.textContent = G.sixes;
    const left = settings.overs * 6 - G.balls;
    if (settings.mode === 'chase') {
      const need = Math.max(0, G.target - G.runs);
      el.chase.innerHTML = `<span class="tgt">T ${G.target}</span>` +
        (need === 0 ? '<b>Target reached</b>' : `Need <b>${need}</b> from <b>${left}</b>`);
    } else {
      const proj = G.balls ? Math.round(G.runs / G.balls * settings.overs * 6) : 0;
      el.chase.innerHTML = `Free play · Proj <b>${proj}</b>`;
    }
  }

  function renderOver() {
    const legal = G.overBalls.filter((c) => c.t !== 'wd').length;
    let html = G.overBalls.map((c) => `<span class="chip ${c.c}">${c.t}</span>`).join('');
    for (let i = legal; i < 6; i++) html += '<span class="chip empty"></span>';
    el.balls.innerHTML = html;
  }

  /* ───────────────────────── end of innings ───────────────────────── */
  function endGame() {
    setState('over');
    const key = `cricket.best.${settings.mode}.${settings.overs}.${settings.wickets}.${settings.diff}`;
    const best = store.get(key, 0);
    const isBest = G.runs > best;
    if (isBest) store.set(key, G.runs);

    let eyebrow = 'Innings complete', title;
    if (settings.mode === 'chase') {
      if (G.runs >= G.target) {
        const wl = settings.wickets - G.wkts, bl = settings.overs * 6 - G.balls;
        eyebrow = 'Victory';
        title = `Won by ${wl} wicket${wl === 1 ? '' : 's'}` + (bl ? ` with ${bl} ball${bl === 1 ? '' : 's'} to spare` : '');
      } else {
        const by = G.target - 1 - G.runs;
        eyebrow = 'Defeat';
        title = by === 0 ? 'Match tied' : `Lost by ${by} run${by === 1 ? '' : 's'}`;
        if (by === 0) eyebrow = 'Tie';
      }
    } else {
      title = `${G.runs}/${G.wkts} in ${oversStr(G.balls)} overs`;
    }
    el.overEyebrow.textContent = eyebrow;
    el.overEyebrow.style.color = eyebrow === 'Defeat' ? DANGER : '';
    el.overTitle.innerHTML = title + (isBest ? '<span class="badge-best">NEW BEST</span>' : '');

    const sr = G.balls ? (G.runs / G.balls * 100).toFixed(1) : '0.0';
    const cells = [
      ['Score', `${G.runs}/${G.wkts}`], ['Overs', oversStr(G.balls)],
      ['Strike rate', sr], ['4s / 6s', `${G.fours} / ${G.sixes}`],
      ['Dot balls', G.dots], ['Best', Math.max(best, G.runs)],
    ];
    el.sumGrid.innerHTML = cells.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    drawWagon();
    show(el.over);
    if (settings.mode === 'chase' && G.runs >= G.target) sfx.six();
  }

  function drawWagon() {
    const c = el.wagon, w = 150, dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = w * dpr; c.height = w * dpr;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const o = w / 2, R = w / 2 - 4;
    g.clearRect(0, 0, w, w);
    g.fillStyle = 'rgba(255,255,255,0.025)';
    g.beginPath(); g.arc(o, o, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1; g.stroke();
    g.setLineDash([2, 4]);
    g.beginPath(); g.arc(o, o, R * 0.45, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(o - 3, o - 12, 6, 24);
    const bx = o, by = o + 9;
    for (const s of G.shots) {
      const len = clamp(s.dist, 0, 1.05) * R * 0.98;
      const ex = bx + Math.sin(s.phi) * len, ey = by - Math.cos(s.phi) * len;
      if (s.out) {
        g.fillStyle = DANGER; g.beginPath(); g.arc(ex, ey, 3, 0, Math.PI * 2); g.fill();
        continue;
      }
      g.strokeStyle = s.runs === 6 ? ACCENT : s.runs === 4 ? 'rgba(200,245,96,0.5)' : 'rgba(255,255,255,0.38)';
      g.lineWidth = s.runs >= 4 ? 1.6 : 1.1;
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(bx, by); g.lineTo(ex, ey); g.stroke();
    }
  }

  /* ───────────────────────── overlays ───────────────────────── */
  function show(o) { o.classList.add('show'); }
  function hideAll() { [el.menu, el.pause, el.over].forEach((o) => o.classList.remove('show')); }
  const inPlay = () => ['ready', 'runup', 'delivery', 'result'].includes(G.state);

  function setPaused(p) {
    if (!inPlay()) return;
    G.paused = p;
    el.pause.classList.toggle('show', p);
  }
  function toMenu() {
    G.paused = false; hideAll();
    G.state = 'menu'; G.ball = null; G.flight = null; G.bowled = null;
    refreshMenu(); show(el.menu);
  }

  function refreshMenu() {
    document.querySelectorAll('.seg').forEach((seg) => {
      const key = seg.dataset.key;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(settings[key]) === b.dataset.val));
    });
    const key = `cricket.best.${settings.mode}.${settings.overs}.${settings.wickets}.${settings.diff}`;
    const best = store.get(key, 0);
    el.bestLine.innerHTML = best ? `Best for this setup · <b>${best}</b>` : '';
    el.btnSound.classList.toggle('off', !settings.sound);
  }

  /* ───────────────────────── drawing ───────────────────────── */
  function line(a, b, w, color) {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  function drawField() {
    // 30-yard circle and boundary, as faint projected ellipses
    const rings = [[3.4, 1.25, [2, 6], 0.07], [8, 3.0, [], 0.09]];
    for (const [rx, rz, dash, a] of rings) {
      ctx.setLineDash(dash);
      ctx.strokeStyle = `rgba(255,255,255,${a})`; ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= 120; i++) {
        const t = (i / 120) * Math.PI * 2;
        const z = 0.5 + Math.sin(t) * rz;
        if (z < -0.25) { started = false; continue; }
        const p = P(Math.cos(t) * rx, z);
        if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawPitch() {
    const a = P(-1, -0.07), b = P(1, -0.07), c = P(1, 1.07), d = P(-1, 1.07);
    const grd = ctx.createLinearGradient(0, c.y, 0, a.y);
    grd.addColorStop(0, 'rgba(255,255,255,0.015)');
    grd.addColorStop(1, 'rgba(255,255,255,0.045)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();

    ctx.lineCap = 'round';
    const crease = 'rgba(255,255,255,0.32)';
    for (const [zb, zp, dir] of [[0, 0.065, 1], [1, 0.935, -1]]) {
      line(P(-0.88, zb), P(0.88, zb), 1.2, crease);            // bowling crease
      line(P(-1.25, zp), P(1.25, zp), 1.2, crease);            // popping crease
      for (const x of [-0.88, 0.88]) line(P(x, zb - 0.065 * dir), P(x, zp), 1.2, crease); // return creases
    }
  }

  function drawStumps(z, broken) {
    const s = P(0, z).s;
    const lw = Math.max(1.2, 0.04 * mPx * s);
    ctx.lineCap = 'round';
    const col = 'rgba(237,237,239,0.92)';
    let p = 0;
    if (broken) p = (clock - broken.t) / 1000;
    const tilt = broken ? Math.min(1, p / 0.18) : 0;
    const offs = [-0.077, 0, 0.077];
    offs.forEach((x, i) => {
      const lean = broken ? [-0.12, 0.03, 0.14][i] * tilt : 0;
      const drop = broken ? [0.08, 0.18, 0.06][i] * tilt : 0;
      line(P(x, z, 0), P(x + lean, z, 0.71 - drop), lw, col);
    });
    if (!broken) {
      line(P(-0.077, z, 0.725), P(0.077, z, 0.725), Math.max(1, lw * 0.6), col);
    } else {
      // bails flying
      for (const sgn of [-1, 1]) {
        const bx = sgn * (0.04 + 0.55 * p), bz = z - 0.03 * p;
        const bh = Math.max(0, 0.73 + 3.2 * p - 6 * p * p);
        const c = P(bx, bz, bh);
        const ang = sgn * p * 14;
        const len = 0.06 * hw * c.s;
        ctx.strokeStyle = ACCENT; ctx.lineWidth = Math.max(1, lw * 0.7);
        ctx.beginPath();
        ctx.moveTo(c.x - Math.cos(ang) * len, c.y - Math.sin(ang) * len);
        ctx.lineTo(c.x + Math.cos(ang) * len, c.y + Math.sin(ang) * len);
        ctx.stroke();
      }
    }
  }

  /* ───────────── figure rendering: filled, shaded capsules on a simple skeleton ───────────── */
  // tapered capsule between screen points a → b
  function capsule(a, b, ra, rb, fill) {
    ra = Math.max(0.6, ra); rb = Math.max(0.6, rb);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(a.x + nx * ra, a.y + ny * ra);
    ctx.lineTo(b.x + nx * rb, b.y + ny * rb);
    ctx.arc(b.x, b.y, rb, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.lineTo(a.x - nx * ra, a.y - ny * ra);
    ctx.arc(a.x, a.y, ra, ang - Math.PI / 2, ang - Math.PI * 1.5, true);
    ctx.closePath();
    ctx.fill();
  }
  // two-bone IK (equal bone lengths); picks the bend that points along `pref`
  function joint(a, c, len, pref) {
    const dx = c[0] - a[0], dy = c[1] - a[1];
    const dist = Math.hypot(dx, dy) || 0.0001;
    const d = Math.min(dist, 2 * len * 0.999);
    const h = Math.sqrt(Math.max(0, len * len - (d / 2) * (d / 2)));
    let nx = -dy / dist, ny = dx / dist;
    if (nx * pref[0] + ny * pref[1] < 0) { nx = -nx; ny = -ny; }
    return [(a[0] + c[0]) / 2 + nx * h, (a[1] + c[1]) / 2 + ny * h];
  }
  const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
  function mapper(base, u) { return (p) => ({ x: base.x + p[0] * u, y: base.y + p[1] * u }); }

  // shirt / torso: rounded trapezoid from waist to shoulders
  function torso(L, u, wl, wr, sl, sr, light, dark) {
    const a = L(wl), b = L(wr), c = L(sr), d = L(sl);
    const g = ctx.createLinearGradient(d.x, d.y, b.x, b.y);
    g.addColorStop(0, light); g.addColorStop(1, dark);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo((a.x + b.x) / 2, a.y + 0.03 * u, b.x, b.y);               // waist
    ctx.quadraticCurveTo(b.x + 0.05 * u, (b.y + c.y) / 2, c.x, c.y);              // right flank
    ctx.quadraticCurveTo((c.x + d.x) / 2, Math.min(c.y, d.y) - 0.09 * u, d.x, d.y); // shoulders
    ctx.quadraticCurveTo(a.x - 0.05 * u, (a.y + d.y) / 2, a.x, a.y);              // left flank
    ctx.closePath();
    ctx.fill();
  }

  function shadow(base, u, rx) {
    const g = ctx.createRadialGradient(base.x, base.y, 0, base.x, base.y, rx * u);
    g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(base.x, base.y, rx * u, rx * 0.22 * u, 0, 0, Math.PI * 2); ctx.fill();
  }

  function baseAngle() {
    let lift = 0;
    if (G.state === 'runup') lift = clamp(((clock - G.t0) / RUNUP - 0.6) / 0.4, 0, 1) * 0.35;
    if (G.state === 'delivery' || (G.state === 'result' && G.ball && !G.ball.hit && !G.swing)) {
      const u = G.ball ? G.ball.u : 0;
      lift = 0.35 + 0.65 * clamp(u / 0.55, 0, 1);
    }
    if (G.state === 'menu' || G.state === 'ready' || G.state === 'over') return REST + Math.sin(clock / 380) * 3;
    return lerp(REST, BACK, easeInOut(lift));
  }
  // nearest equivalent of angle a to reference r (avoids spinning the bat a full turn on the way back)
  const nearAngle = (a, r) => r + ((((a - r) % 360) + 540) % 360) - 180;
  // 0 → 1 during the swing, held, then back to 0 during the recovery
  function swingAmount() {
    const A = G.batAnim; if (!A) return 0;
    const t = clock - A.t - A.pre;
    if (t < 0) return 0;
    if (t < SWING_MS) return easeOutCubic(t / SWING_MS);
    if (t < SWING_MS + SWING_HOLD) return 1;
    return 1 - easeInOut(clamp((t - SWING_MS - SWING_HOLD) / SWING_RETURN, 0, 1));
  }
  function batAngle() {
    const base = baseAngle();
    const A = G.batAnim;
    if (!A) return base;
    const t = clock - A.t;
    const end = SWING_END[A.shot];
    if (t < A.pre) return lerp(A.from, BACK, easeInOut(t / A.pre));           // quick backlift
    const ts = t - A.pre;
    const start = A.pre ? BACK : A.from;
    if (ts < SWING_MS) return lerp(start, end, easeOutCubic(ts / SWING_MS));
    if (ts < SWING_MS + SWING_HOLD) return end;
    const r = (ts - SWING_MS - SWING_HOLD) / SWING_RETURN;
    if (r >= 1) { G.batAnim = null; return base; }
    return lerp(nearAngle(end, base), base, easeInOut(r));
  }

  const KIT = { light: '#f1f1f4', mid: '#d4d4da', dark: '#a9a9b2', pad: '#fbfbfc', shoe: '#4a4b53' };

  function drawBatsman() {
    const base = P(BAT_X, BAT_Z, 0);
    const u = mPx * base.s;
    const L = mapper(base, u);
    const th = batAngle();
    G.lastAngle = th;
    const rad = (th * Math.PI) / 180;
    const dir = [Math.cos(rad), Math.sin(rad)];

    const shot = G.batAnim ? G.batAnim.shot : null;
    const sp = swingAmount();
    const lift = G.state === 'delivery' ? clamp(G.ball ? G.ball.u / 0.6 : 0, 0, 1) : 0;
    const breathe = Math.sin(clock / 650) * 0.008;
    const crouch = 0.045 - lift * 0.015 + breathe;                    // knees bent in stance
    const lean = shot ? { off: 0.07, leg: -0.07, loft: -0.02, block: 0.03 }[shot] * sp : 0;

    // feet: front foot (left) strides into off/loft/block, back foot rocks for the pull
    let fL = [-0.21, 0], fR = [0.23, 0];
    if (shot === 'off' || shot === 'block') fL = add(fL, [0.07 * sp, -0.07 * sp]);
    if (shot === 'loft') fL = add(fL, [0.02 * sp, -0.1 * sp]);
    if (shot === 'leg') fR = add(fR, [0.07 * sp, 0.03 * sp]);

    const hip = [0.02 + lean * 0.6, -0.86 + crouch];
    const hL = add(hip, [-0.1, 0.02]), hR = add(hip, [0.11, 0.02]);
    const kL = joint(hL, fL, 0.43, [-1, 0]);
    const kR = joint(hR, fR, 0.43, [1, 0]);
    const neck = [0.05 + lean, -1.4 + crouch * 0.9];
    const sL = add(neck, [-0.21, 0.07]), sR = add(neck, [0.22, 0.08]);

    // hands on an arc around the chest, top & bottom hand along the handle
    const C = [0.05 + lean, -1.13 + crouch * 0.8];
    const hTop = [C[0] + 0.36 * dir[0], C[1] + 0.36 * dir[1]];
    const hBot = add(hTop, [dir[0] * 0.1, dir[1] * 0.1]);
    const eL = joint(sL, hTop, 0.29, [-0.6, 1]);
    const eR = joint(sR, hBot, 0.29, [0.6, 1]);

    shadow(base, u, 0.55);

    // back leg (right) — slightly darker, then front leg
    for (const [hp, kn, ft, shade] of [[hR, kR, fR, KIT.dark], [hL, kL, fL, KIT.mid]]) {
      capsule(L(hp), L(kn), 0.09 * u, 0.075 * u, shade);                 // thigh
      // pad
      capsule(L(add(kn, [0, -0.04])), L(add(ft, [0, -0.05])), 0.095 * u, 0.085 * u, KIT.pad);
      // pad ribs
      ctx.strokeStyle = 'rgba(20,20,26,0.13)'; ctx.lineWidth = Math.max(0.6, 0.012 * u);
      for (const o of [-0.035, 0.035]) {
        const a = L(add(kn, [o, 0.04])), b = L(add(ft, [o, -0.1]));
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      // shoe
      const s = L(ft);
      ctx.fillStyle = KIT.shoe;
      ctx.beginPath(); ctx.ellipse(s.x, s.y - 0.02 * u, 0.1 * u, 0.045 * u, 0, 0, Math.PI * 2); ctx.fill();
    }

    // back arm (right) behind torso
    capsule(L(sR), L(eR), 0.065 * u, 0.055 * u, KIT.dark);
    capsule(L(eR), L(hBot), 0.055 * u, 0.048 * u, KIT.dark);

    // torso + collar
    torso(L, u, add(hip, [-0.15, 0.03]), add(hip, [0.16, 0.03]), add(sL, [-0.02, 0]), add(sR, [0.02, 0]), KIT.light, KIT.dark);
    // shirt seam (back of jersey) for a bit of structure
    ctx.strokeStyle = 'rgba(20,20,26,0.10)'; ctx.lineWidth = Math.max(0.6, 0.012 * u);
    const s1 = L(add(neck, [0, 0.06])), s2 = L(add(hip, [0.01, -0.02]));
    ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.quadraticCurveTo(s1.x + 0.02 * u, (s1.y + s2.y) / 2, s2.x, s2.y); ctx.stroke();

    // helmet with neck guard and an accent rim
    const hc = L(add(neck, [0.01, -0.17]));
    capsule(L(add(neck, [0, -0.02])), L(add(neck, [0.005, -0.1])), 0.06 * u, 0.06 * u, '#3a3b44');
    const hg = ctx.createRadialGradient(hc.x - 0.05 * u, hc.y - 0.06 * u, 0.01 * u, hc.x, hc.y, 0.15 * u);
    hg.addColorStop(0, '#6d6f7c'); hg.addColorStop(1, '#2c2d34');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(hc.x, hc.y, 0.14 * u, 0, Math.PI * 2); ctx.fill();
    // accent band around the helmet shell
    ctx.save();
    ctx.beginPath(); ctx.arc(hc.x, hc.y, 0.14 * u, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = ACCENT;
    ctx.fillRect(hc.x - 0.15 * u, hc.y + 0.055 * u, 0.3 * u, Math.max(1, 0.028 * u));
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.ellipse(hc.x - 0.04 * u, hc.y - 0.07 * u, 0.06 * u, 0.03 * u, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // bat: grip + blade (with edge shading)
    const hp = L(hTop);
    const handleEnd = { x: hp.x + dir[0] * 0.27 * u, y: hp.y + dir[1] * 0.27 * u };
    capsule(hp, handleEnd, 0.02 * u, 0.02 * u, '#8fae45');
    ctx.save();
    ctx.translate(handleEnd.x, handleEnd.y);
    ctx.rotate(rad);
    const bl = 0.6 * u, bw = 0.115 * u;
    const bg = ctx.createLinearGradient(0, -bw / 2, 0, bw / 2);
    bg.addColorStop(0, '#e4ff9a'); bg.addColorStop(0.45, ACCENT); bg.addColorStop(1, '#8fb83a');
    ctx.fillStyle = bg;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-0.02 * u, -bw / 2, bl, bw, [bw * 0.25, bw * 0.5, bw * 0.5, bw * 0.25]);
    else ctx.rect(-0.02 * u, -bw / 2, bl, bw);
    ctx.fill();
    ctx.restore();

    // front arm (left) over the bat handle, then gloves
    capsule(L(sL), L(eL), 0.068 * u, 0.058 * u, KIT.mid);
    capsule(L(eL), L(hTop), 0.058 * u, 0.05 * u, KIT.light);
    for (const h of [hBot, hTop]) {
      const g = L(h);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(g.x, g.y, 0.062 * u, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(20,20,26,0.18)'; ctx.lineWidth = Math.max(0.6, 0.012 * u); ctx.stroke();
    }
  }

  function bowlerPose() {
    const t = clock - G.t0;
    if (G.state === 'runup') {
      const p = clamp(t / RUNUP, 0, 1);
      const z = lerp(1.48, 1.03, easeInOut(p));
      const armP = clamp((p - 0.62) / 0.38, 0, 1);
      return { z, run: 1 - armP * 0.5, arm: 90 - 360 * easeInOut(armP), hold: true, phase: t / 95, gather: armP };
    }
    if (G.state === 'delivery' || G.state === 'result') {
      const ft = clock - (G.ball && G.ball.tRel != null ? G.ball.tRel : G.t0);
      const p = clamp(ft / 450, 0, 1);
      return { z: lerp(1.03, 0.97, easeOutCubic(p)), run: 0.6 * (1 - p), arm: lerp(-270, -150, easeOutCubic(p)), hold: false, phase: ft / 120, gather: 1 - p };
    }
    return { z: 1.48, run: 0, arm: 90, hold: G.state === 'ready', phase: 0, gather: 0 };
  }

  // front-facing figure (bowler / non-striker), seen from the batting end
  function drawFrontFigure(x, z, o) {
    const base = P(x, z, 0);
    const u = mPx * base.s;
    const L = mapper(base, u);
    const sw = Math.sin(o.phase || 0) * (o.run || 0);
    const bob = Math.abs(sw) * 0.05 + (o.idle ? Math.sin(clock / 700 + x * 5) * 0.006 : 0);
    const fL = [-0.12 - (o.stance || 0), -Math.max(0, sw) * 0.24];
    const fR = [0.12 + (o.stance || 0), -Math.max(0, -sw) * 0.24];
    const hip = [0, -0.92 - bob];
    const hL = add(hip, [-0.09, 0.02]), hR = add(hip, [0.09, 0.02]);
    const kL = joint(hL, fL, 0.46, [-1, 0.2]);
    const kR = joint(hR, fR, 0.46, [1, 0.2]);
    const neck = [0, -1.44 - bob];
    const sL = add(neck, [-0.2, 0.06]), sR = add(neck, [0.2, 0.06]);

    shadow(base, u, 0.45);
    for (const [hp, kn, ft] of [[hL, kL, fL], [hR, kR, fR]]) {
      capsule(L(hp), L(kn), 0.085 * u, 0.07 * u, o.dark);
      capsule(L(kn), L(ft), 0.07 * u, 0.055 * u, o.legs || o.mid);
      const s = L(ft);
      ctx.fillStyle = KIT.shoe;
      ctx.beginPath(); ctx.ellipse(s.x, s.y - 0.02 * u, 0.08 * u, 0.04 * u, 0, 0, Math.PI * 2); ctx.fill();
    }
    torso(L, u, add(hip, [-0.14, 0.03]), add(hip, [0.14, 0.03]), sL, sR, o.light, o.dark);

    // arms
    if (o.bowl) {
      const ar = (o.arm * Math.PI) / 180;
      const hand = add(sL, [0.66 * Math.cos(ar), 0.66 * Math.sin(ar)]);
      const mid = add(sL, [0.33 * Math.cos(ar), 0.33 * Math.sin(ar)]);
      capsule(L(sL), L(mid), 0.065 * u, 0.055 * u, o.mid);
      capsule(L(mid), L(hand), 0.055 * u, 0.045 * u, o.mid);
      // leading arm reaches up during the gather
      const lead = add(sR, [0.12 + sw * 0.08, lerp(0.42, -0.5, o.gather || 0)]);
      const eLead = joint(sR, lead, 0.3, [1, 0.3]);
      capsule(L(sR), L(eLead), 0.065 * u, 0.055 * u, o.dark);
      capsule(L(eLead), L(lead), 0.055 * u, 0.045 * u, o.dark);
      if (o.hold) {
        const b = L(hand);
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(1.4, 0.055 * u), 0, Math.PI * 2); ctx.fill();
      }
    } else {
      // non-striker leaning on the bat
      const hand = [0.22, -0.95 - bob];
      const e1 = joint(sR, hand, 0.29, [1, 0]);
      capsule(L(sR), L(e1), 0.065 * u, 0.055 * u, o.mid);
      capsule(L(e1), L(hand), 0.055 * u, 0.045 * u, o.mid);
      const e2 = joint(sL, [-0.24, -0.92], 0.29, [-1, 0]);
      capsule(L(sL), L(e2), 0.065 * u, 0.055 * u, o.mid);
      capsule(L(e2), L([-0.24, -0.92]), 0.055 * u, 0.045 * u, o.mid);
      capsule(L(hand), L([0.3, -0.02]), 0.05 * u, 0.05 * u, 'rgba(200,245,96,0.55)');
    }
    // head (cap or helmet)
    const hc = L(add(neck, [0, -0.17]));
    capsule(L(neck), L(add(neck, [0, -0.08])), 0.05 * u, 0.05 * u, o.dark);
    ctx.fillStyle = o.head;
    ctx.beginPath(); ctx.arc(hc.x, hc.y, 0.13 * u, 0, Math.PI * 2); ctx.fill();
    if (o.cap) {
      ctx.fillStyle = o.cap;
      ctx.beginPath(); ctx.arc(hc.x, hc.y - 0.02 * u, 0.135 * u, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
    }
  }

  const BOWLER_KIT = { light: '#cfcfd6', mid: '#b3b3bb', dark: '#8c8c95', head: '#b59a86', cap: '#2e2f36' };
  const RUNNER_KIT = { light: '#bfc0c7', mid: '#a5a6ae', dark: '#7e7f88', legs: '#e9e9ec', head: '#3a3b44' };

  function drawFarEnd() {
    const pose = bowlerPose();
    let nsZ = 1.07, nsX = -0.62;
    if (G.state === 'delivery' || G.state === 'result') {
      const t = clock - (G.ball && G.ball.tRel != null ? G.ball.tRel : G.t0);
      nsZ = lerp(1.07, 0.98, easeOutCubic(clamp(t / 700, 0, 1)));   // backing up
    }
    const items = [
      { z: 1, f: () => drawStumps(1, null) },
      { z: pose.z, f: () => drawFrontFigure(0.14, pose.z, { ...BOWLER_KIT, bowl: true, arm: pose.arm, run: pose.run, phase: pose.phase, hold: pose.hold, gather: pose.gather, idle: pose.run === 0 }) },
      { z: nsZ, f: () => drawFrontFigure(nsX, nsZ, { ...RUNNER_KIT, idle: true, stance: 0.04 }) },
    ];
    items.sort((a, b) => b.z - a.z).forEach((i) => i.f());
  }

  function ballWorld() {
    const b = G.ball;
    if (!b || b.tRel == null) return null;
    if (G.flight) {
      const f = G.flight;
      const p = clamp((clock - f.t) / f.dur, 0, 1);
      const e = f.air ? p : easeOutCubic(p);
      const x = lerp(f.x0, f.x1, e), z = lerp(f.z0, f.z1, e);
      let h;
      if (f.air) h = lerp(f.h0, f.endH, p) + f.peak * 4 * p * (1 - p);
      else h = f.h0 * Math.pow(1 - p, 2) + Math.abs(Math.sin(p * Math.PI * 3)) * 0.25 * (1 - p);
      return { x, z, h, fade: f.endH ? 1 : 1 - clamp((p - 0.85) / 0.15, 0, 1) * 0.6 };
    }
    const u = b.u;
    if (G.bowled && u > 1) return null;
    if (u > 1.14) return null;
    return { x: ballX(b, u), z: ballZ(u), h: ballH(b, u), fade: u > 1.04 ? 1 - (u - 1.04) / 0.1 : 1 };
  }

  function drawBall(w) {
    const p = P(w.x, w.z, w.h), g = P(w.x, w.z, 0);
    const r = Math.max(2.2, 0.075 * mPx * p.s);
    if (p.x < -40 || p.x > W + 40 || p.y < -60 || p.y > H + 60) return;
    // shadow
    ctx.fillStyle = `rgba(0,0,0,${0.45 * w.fade * (1 - clamp(w.h / 4, 0, 0.8))})`;
    ctx.beginPath(); ctx.ellipse(g.x, g.y, r * 1.4, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    // trail
    G.trail.push({ x: p.x, y: p.y });
    if (G.trail.length > 10) G.trail.shift();
    if (G.trail.length > 1) {
      for (let i = 1; i < G.trail.length; i++) {
        const a = G.trail[i - 1], b = G.trail[i];
        ctx.strokeStyle = `rgba(255,255,255,${(i / G.trail.length) * 0.22 * w.fade})`;
        ctx.lineWidth = r * 1.6 * (i / G.trail.length);
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.7)'; ctx.shadowBlur = 10;
    ctx.fillStyle = `rgba(255,255,255,${w.fade})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawMark() {
    if (!G.mark) return;
    const age = (clock - G.mark.t) / 2600;
    if (age > 1) { G.mark = null; return; }
    const p = P(G.mark.x, G.mark.z);
    const r = 0.11 * hw * p.s;
    ctx.fillStyle = `rgba(200,245,96,${0.35 * (1 - age)})`;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, r, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawField();
    drawPitch();
    drawMark();
    drawFarEnd();

    const w = (G.state === 'delivery' || G.state === 'result') ? ballWorld() : null;
    const ballBehind = w && w.z > BAT_Z;
    if (w && ballBehind) drawBall(w);
    drawBatsman();
    drawStumps(0, G.bowled);
    if (w && !ballBehind) drawBall(w);
    if (!w) G.trail = [];
  }

  /* ───────────────────────── loop ───────────────────────── */
  function frame(now) {
    let dt = now - lastFrame; lastFrame = now;
    if (dt > 100) dt = 100;
    if (!G.paused) clock += dt;
    if (!G.paused) update();
    draw();
    requestAnimationFrame(frame);
  }

  /* ───────────────────────── input ───────────────────────── */
  const KEYMAP = {
    ArrowLeft: 'leg', a: 'leg', A: 'leg', 4: 'leg',
    ArrowRight: 'off', d: 'off', D: 'off', 6: 'off',
    ArrowUp: 'loft', w: 'loft', W: 'loft', 2: 'loft',
    ArrowDown: 'block', s: 'block', S: 'block', ' ': 'block', 8: 'block', 5: 'block',
  };

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(k)) e.preventDefault();
    if (e.repeat) return;
    if (el.menu.classList.contains('show') || el.over.classList.contains('show')) {
      if (k === 'Enter') { e.preventDefault(); startGame(); }
      return;
    }
    if (k === 'p' || k === 'P' || k === 'Escape') return setPaused(!G.paused);
    if (k === 'm' || k === 'M') return toggleSound();
    if (G.paused) { if (k === 'Enter') setPaused(false); return; }
    if (KEYMAP[k]) playShot(KEYMAP[k]);
  });

  document.querySelectorAll('.ctrl').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); playShot(btn.dataset.shot); });
  });
  function flashControl(shot) {
    const btn = document.querySelector(`.ctrl[data-shot="${shot}"]`);
    if (!btn) return;
    btn.classList.add('hit');
    setTimeout(() => btn.classList.remove('hit'), 140);
  }

  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const key = seg.dataset.key;
      settings[key] = ['overs', 'wickets'].includes(key) ? Number(b.dataset.val) : b.dataset.val;
      saveSettings(); refreshMenu(); beep(700, 0.03);
    });
  });

  function toggleSound() {
    settings.sound = !settings.sound; saveSettings();
    el.btnSound.classList.toggle('off', !settings.sound);
    beep(880, 0.04);
  }

  $('#btnStart').addEventListener('click', startGame);
  $('#btnAgain').addEventListener('click', startGame);
  $('#btnMenu').addEventListener('click', toMenu);
  $('#btnResume').addEventListener('click', () => setPaused(false));
  $('#btnQuit').addEventListener('click', toMenu);
  el.btnPause.addEventListener('click', () => setPaused(!G.paused));
  el.btnSound.addEventListener('click', toggleSound);
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });

  /* ───────────────────────── boot ───────────────────────── */
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  window.addEventListener('resize', resize);
  resize();
  refreshMenu();
  renderHUD();
  renderOver();
  requestAnimationFrame(frame);

  // exposed for automated testing only
  window.__cricket = { G, settings, playShot, U_HIT };
})();
