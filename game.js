/* zouzou's run: a california-to-new-jersey endless runner (canvas, no dependencies).
   Public API: Game.mount(canvas, { onStart, onZone, onDeath }), Game.unmount(), plus Game.api for tests. */
'use strict';

const CAT_FRAMES = {
 "a": [
  "..........................",
  ".................K.....K..",
  "..KK.............KKKK.KPK.",
  ".K...............PKKKKKKK.",
  ".K..............KKKKKKKKK.",
  ".K.....KKGKGKGKKKKKEKKEK..",
  "..K..KKKGKKKKKKKKKKEWWEW..",
  "...KKKKKKKKKKKKKKKKWWWWWW.",
  "...KKKKKKKKKKKKWKKKWWWWWPP",
  "...KKKKKKWWWWWWWWKKKWWWW..",
  "....KKKWWWWWWWWWWWWW......",
  ".....KKWWWWWWWWWWWW.......",
  ".......KKWKKWKKWWKK.......",
  "......KK..KKKKW..KK.......",
  "......KK..KKKK....KK......",
  ".....KK....WWW....KK......",
  ".....WW............WW....."
 ],
 "b": [
  "..........................",
  ".................K.....K..",
  "..KK.............KKKK.KPK.",
  ".K...............PKKKKKKK.",
  ".K..............KKKKKKKKK.",
  ".K.....KKGKGKGKKKKKEKKEK..",
  "..K..KKKGKKKKKKKKKKEWWEW..",
  "...KKKKKKKKKKKKKKKKWWWWWW.",
  "...KKKKKKKKKKKKWKKKWWWWWPP",
  "...KKKKKKWWWWWWWWKKKWWWW..",
  "....KKKWWWWWWWWWWWWW......",
  ".....KKWWWWWWWWWWWW.......",
  ".......KKWKKWKKWWKK.......",
  ".......KKKKWWKK.KK........",
  ".......KKKK...KKKK........",
  "........KK....KKWW........",
  "........WW.....WW........."
 ],
 "jump": [
  "..........................",
  ".................K.....K..",
  ".................KKKK.KPK.",
  ".................PKKKKKKK.",
  "................KKKKKKKKK.",
  ".......KKGKGKGKKKKKEKKEK..",
  ".....KKKGKKKKKKKKKKEWWEW..",
  "K...KKKKKKKKKKKKKKKWWWWWW.",
  "KKKKKKKKKKKKKKKWKKKWWWWWPP",
  "...KKKKKKWWWWWWWWKKKWWWW..",
  "....KKKWWWWWWWWWWWWW......",
  ".....KKWWWWWWWWWWWW.......",
  "..WKKKKWWWWWWWWWWWKKKKKW..",
  "..WKKKK...KWWWK...KKKKKW..",
  "..........K...K...........",
  "..........................",
  ".........................."
 ],
 "dead": [
  "..........................",
  ".................K.....K..",
  ".................KKKK.KPK.",
  ".................PKKKKKKK.",
  "................KKKKKKKKK.",
  ".......KKGKGKGKKKKKXXKXX..",
  ".....KKKGKKKKKKKKKKXXWXX..",
  "....KKKKKKKKKKKKKKKWWWWWW.",
  "...KKKKKKKKKKKKWKKKWWWWWPP",
  "...KKKKKKWWWWWWWWKKKWWWW..",
  "KKK.KKKWWWWWWWWWWWWW......",
  ".....KKWWWWWWWWWWWW.......",
  ".......WKWWKWWWKWWK.......",
  "........K.WKWWWK..K.......",
  "........W..W...W..W.......",
  "..........................",
  ".........................."
 ]
};

const Game = (() => {
  const W = 600, H = 200, GROUND = 168, SC = 3, CAT_X = 46;
  const NJ_AT = 600;               // score at which you cross into new jersey
  const DIST_PER_POINT = 24;       // pixels of distance per score point
  const JUMP_V = 10.8, GRAV = 0.675;

  // The route: zouzou leaves home in los angeles, passes her school, crosses into new jersey and passes the house on kendal ave.
  // Set SHOW_HOUSE_NUMBERS to false to show street names only (this page is public if you host it on github pages).
  const SHOW_HOUSE_NUMBERS = true;
  const PLACES = {
    homeNo: SHOW_HOUSE_NUMBERS ? '674' : '', homeStreet: SHOW_HOUSE_NUMBERS ? '674 kingman ave' : 'kingman ave', homeCity: 'los angeles, ca',
    school: 'rustic canyon elementary',
    njNo: SHOW_HOUSE_NUMBERS ? '29' : '', njStreet: SHOW_HOUSE_NUMBERS ? '29 kendal ave' : 'kendal ave', njCity: 'maplewood, nj',
  };
  const SCHOOL_AT = 2300;            // distance at which the school appears (about score 95)
  const NJ_HOUSE_AT = (NJ_AT + 70) * DIST_PER_POINT;
  const LANDMARKS = { home: 'house-ca', school: 'school', njhouse: 'house-nj' };
  const IMGS = {};
  for (const n of new Set(Object.values(LANDMARKS))) { const im = new Image(); im.src = n + '.png'; IMGS[n] = im; }

  const PAL = {
    K: '#1b1b25', G: '#44465a', W: '#fbfbff', L: '#d0d3e4', P: '#ff9bb0', E: '#b8e04a', X: '#ff4d6d',
    g: '#2e9b4f', t: '#8b5a2b', T: '#6e4521', o: '#e8742a', c: '#3f9d56', C: '#2a7a40',
    a: '#ff6b9d', y: '#ffd23f', r: '#e63946', R: '#a4202c', p: '#6b4423', s: '#e8c88a', e: '#9aa3b2',
    n: '#c4c8d0', N: '#9aa0aa', q: '#ff9f1c', k: '#34363c', m: '#7d8590', M: '#5b626b', b: '#2ec4b6',
  };
  // fix a few chars that are reused with different meanings per sprite
  const PAL_SPRITE = { ...PAL, G: '#1f6f3a', o: '#6b3f1d', W: '#fbfbff' };

  // ----- sprites (ascii). '.' is transparent
  const S = {
    palm: ['..gg...gg..', '.gGGg.gGGg.', 'gGGggoggGGg', 'gGggGGGggGg', '.g.gGGGg.g.', '...ggGgg...',
      '.....tT....', '.....tT....', '.....tT....', '.....Tt....', '.....Tt....', '.....tT....', '.....tT....', '.....tT....',
      '....tT.....', '....tT.....', '....tT.....', '....tT.....', '....tT.....', '...ssssss..'],
    cactus: ['....cc...', '....cC...', '.cc.cC...', '.cC.cC.cc', '.cC.cC.cC', '.cCccC.cC', '..cCCCccC', '....cCCC.', '....cC...',
      '....cC...', '....cC...', '....cC...', '...ssss..'],
    surf: ['..a..', '.aaa.', '.aWa.', 'aaWaa', 'aaWaa', 'aaWaa', 'aaWaa', 'aaWaa', 'aaWaa', 'aaWaa', 'aaWaa', '.aWa.', '.aWa.', '..a..', 'sssss', 'sssss'],
    umbrella: ['....rWrWr....', '..rWrWrWrWr..', '.rWrWrWrWrWr.', 'rrrrrrrrrrrrr', '......p......', '......p......', '......p......',
      '......p......', '......p......', '......p......', '......p......', '......p......', '....ssssss...'],
    taco: ['..yyyyyy..', '.yyggrryy.', 'yyggrrggyy', 'ygrrggrrgy', 'yyyyyyyyyy'],
    gullA: ['W.......W', 'WW.....WW', '.WWWkWWW.', '...WWW...'],
    gullB: ['...WWW...', '.WWWkWWW.', 'WW.....WW', 'W.......W'],
    barrier: ['......nnnnnnnn......', '......nNNNNNNn......', '.....nNNNNNNNNn.....', '.....nNqqqqqqNn.....', '....nNNNNNNNNNNn....', '....nNNNNNNNNNNn....',
      '...nNNNNNNNNNNNNn...', '..nNNNNNNNNNNNNNNn..', '.nNNNNNNNNNNNNNNNNn.'],
    cone: ['...o...', '...o...', '..oWo..', '..oWo..', '.ooWoo.', '.ooWoo.', 'ooooooo', 'ooooooo', 'kkkkkkk', 'kkkkkkk'],
    hydrant: ['..rrr..', '.rrrrr.', '..rRr..', '.rrrrr.', 'rrrrrrr', 'rrRrRrr', '.rrrrr.', '.rrrrr.', 'rrrrrrr', 'RRRRRRR'],
    trash: ['.MMMMMM.', 'MMMMMMMM', '.mmmmmm.', '.mMmmMm.', '.mMmmMm.', '.mMmmMm.', '.mMmmMm.', '.mMmmMm.', '.mmmmmm.', '.MMMMMM.'],
    pigeonA: ['e.......e', 'ee.....ee', '.eeekeee.', '...eee...'],
    pigeonB: ['...eee...', '.eeekeee.', 'ee.....ee', 'e.......e'],
  };

  function bake(rows, pal) {
    const w = rows[0].length, h = rows.length, c = document.createElement('canvas');
    c.width = w * SC; c.height = h * SC;
    const x = c.getContext('2d');
    rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch !== '.' && pal[ch]) { x.fillStyle = pal[ch]; x.fillRect(i * SC, j * SC, SC, SC); } }));
    return c;
  }
  let baked = null;
  function bakeAll() {
    if (baked) return baked;
    baked = { cat: {}, o: {} };
    for (const k of Object.keys(CAT_FRAMES)) baked.cat[k] = bake(CAT_FRAMES[k], PAL);
    for (const k of Object.keys(S)) baked.o[k] = bake(S[k], PAL_SPRITE);
    return baked;
  }

  // obstacle catalogues per zone: [sprite, canGroup, weight]
  const CA = [['cactus', true, 4], ['palm', false, 3], ['surf', true, 3], ['umbrella', false, 2], ['taco', true, 3]];
  const NJ = [['barrier', false, 4], ['cone', true, 4], ['hydrant', true, 3], ['trash', true, 3]];

  const rand = (a, b) => a + Math.random() * (b - a);
  function pickWeighted(list) {
    const total = list.reduce((s, i) => s + i[2], 0); let r = Math.random() * total;
    for (const i of list) { r -= i[2]; if (r <= 0) return i; }
    return list[0];
  }

  let cv = null, ctx = null, opts = {}, raf = 0, last = 0, acc = 0, listeners = [];
  const st = {};
  function reset() {
    Object.assign(st, {
      mode: 'idle', dist: 0, speed: 5.2, h: 0, vy: 0, holding: false, frame: 0, anim: 0,
      obs: [], gap: 260, signs: [], signMade: false, caSignMade: false, zone: 'ca', zoneT: 0, banner: 0, dead: 0,
      stars: Array.from({ length: 22 }, () => [rand(0, W), rand(4, 90)]), clouds: Array.from({ length: 4 }, (_, i) => [i * 170 + rand(0, 60), rand(14, 60)]),
    });
    st.signs.push({ kind: 'ca', x: W - 120 });
    st.landmarks = [{ kind: 'home', x: 8, said: true }];   // zouzou starts in front of her house
    st.schoolMade = false; st.njHouseMade = false; st.caption = { text: '', t: 0 };
  }
  const score = () => Math.floor(st.dist / DIST_PER_POINT);
  const hiScore = () => { try { return Number(localStorage.getItem('zouzou-hi') || 0); } catch (e) { return 0; } };
  const saveHi = v => { try { localStorage.setItem('zouzou-hi', String(v)); } catch (e) {} };

  // ----------------------------------------------------------- input
  function jump() {
    if (st.mode === 'idle') {
      st.mode = 'run'; st.caption = { text: 'leaving ' + PLACES.homeStreet + ', ' + PLACES.homeCity, t: 190 };
      if (opts.onStart) opts.onStart();
      if (opts.onLandmark) opts.onLandmark('home');
    }
    if (st.mode === 'dead') { if (st.dead > 24) { reset(); st.mode = 'run'; st.caption = { text: 'leaving ' + PLACES.homeStreet + ', ' + PLACES.homeCity, t: 190 }; if (opts.onStart) opts.onStart(); } return; }
    if (st.h === 0) { st.vy = JUMP_V; st.holding = true; if (opts.onJump) opts.onJump(); }
  }
  function release() { st.holding = false; if (st.vy > 8.5) st.vy = 8.5; }   // short tap = short hop; hold = full jump

  // ----------------------------------------------------------- simulation (one 60fps tick)
  function spawn() {
    const list = st.zone === 'nj' ? NJ : CA;
    const birdChance = score() > 90 ? 0.17 : 0;
    if (Math.random() < birdChance) {
      const names = st.zone === 'nj' ? ['pigeonA', 'pigeonB'] : ['gullA', 'gullB'];
      st.obs.push({ kind: 'bird', names, x: W + 40, lift: 62 + rand(0, 14), w: 9 * SC, h: 4 * SC });
      return;
    }
    const [name, canGroup] = pickWeighted(list);
    const spr = S[name], w = spr[0].length * SC, h = spr.length * SC;
    st.obs.push({ kind: name, x: W + 40, lift: 0, w, h });
    if (canGroup && Math.random() < 0.28) st.obs.push({ kind: name, x: W + 40 + w + 6, lift: 0, w, h });
  }

  function tick() {
    if (st.mode === 'dead') { st.dead++; return; }
    if (st.mode !== 'run') return;
    st.speed = Math.min(12, 5.2 + st.dist / 2800);
    st.dist += st.speed;
    st.anim += st.speed;
    // vertical motion
    if (st.h > 0 || st.vy > 0) {
      st.h += st.vy;
      st.vy -= st.holding && st.vy > 0 ? GRAV * 0.78 : GRAV * (st.vy > 0 ? 1.35 : 1);
      if (st.h <= 0) { st.h = 0; st.vy = 0; }
    }
    // world scroll
    for (const o of st.obs) o.x -= st.speed;
    for (const s of st.signs) s.x -= st.speed;
    for (const l of st.landmarks) l.x -= st.speed;
    st.obs = st.obs.filter(o => o.x + o.w > -20);
    st.signs = st.signs.filter(s => s.x > -260);
    st.landmarks = st.landmarks.filter(l => l.x + lmWidth(l.kind) > -30);
    if (!st.schoolMade && st.dist >= SCHOOL_AT) { st.landmarks.push({ kind: 'school', x: W + 20, said: false }); st.schoolMade = true; }
    if (st.zone === 'nj' && !st.njHouseMade && st.dist >= NJ_HOUSE_AT) { st.landmarks.push({ kind: 'njhouse', x: W + 20, said: false }); st.njHouseMade = true; }
    for (const l of st.landmarks) {
      if (!l.said && l.x + lmWidth(l.kind) / 2 < CAT_X + 140) {
        l.said = true;
        st.caption = { text: l.kind === 'school' ? PLACES.school : PLACES.njStreet + ', ' + PLACES.njCity, t: 190 };
        if (opts.onLandmark) opts.onLandmark(l.kind);
      }
    }
    if (st.caption.t > 0) st.caption.t--;
    // spawn
    const lastO = st.obs[st.obs.length - 1];
    const farEdge = lastO ? lastO.x + lastO.w : -1;
    if (!lastO || W + 40 - farEdge >= st.gap) {
      spawn();
      st.gap = 150 + st.speed * 30 + rand(0, 260);
    }
    // new jersey sign + zone change
    if (!st.signMade && st.dist >= NJ_AT * DIST_PER_POINT - 520) { st.signs.push({ kind: 'nj', x: W + 30 }); st.signMade = true; }
    const njSign = st.signs.find(s => s.kind === 'nj');
    if (njSign && st.zone === 'ca' && njSign.x + 80 < CAT_X + 30) {
      st.zone = 'nj'; st.banner = 160;
      if (opts.onZone) opts.onZone('nj');
    }
    if (st.zone === 'nj' && st.zoneT < 1) st.zoneT = Math.min(1, st.zoneT + 1 / 100);
    if (st.banner > 0) st.banner--;
    // collisions (shrunk boxes so it feels fair)
    const cat = { x: CAT_X + 18, y: GROUND - st.h - 17 * SC + 12, w: 26 * SC - 36, h: 17 * SC - 14 };
    for (const o of st.obs) {
      const ob = { x: o.x + 5, y: GROUND - o.lift - o.h + 4, w: o.w - 10, h: o.h - 6 };
      if (cat.x < ob.x + ob.w && cat.x + cat.w > ob.x && cat.y < ob.y + ob.h && cat.y + cat.h > ob.y) { die(o); return; }
    }
  }

  function die(hitBy) {
    st.mode = 'dead'; st.dead = 0;
    const sc = score(), best = hiScore();
    if (sc > best) saveHi(sc);
    if (opts.onDeath) opts.onDeath(sc, st.zone, sc > best, hitBy && hitBy.kind);
  }

  // ----------------------------------------------------------- drawing
  const lerp = (a, b, t) => a + (b - a) * t;
  function drawSceneCA(c) {
    const g = c.createLinearGradient(0, 0, 0, GROUND);
    g.addColorStop(0, '#ff8f5a'); g.addColorStop(0.55, '#ffc477'); g.addColorStop(1, '#ffe8b0');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // sun
    c.fillStyle = '#fff1b8'; c.beginPath(); c.arc(470, 64, 30, 0, 7); c.fill();
    c.fillStyle = '#ffe28a'; c.beginPath(); c.arc(470, 64, 22, 0, 7); c.fill();
    // far mountains (purple, slow)
    c.fillStyle = '#c47a8e';
    const mo = -(st.dist * 0.08) % 420;
    for (let k = -1; k < 3; k++) {
      c.beginPath(); c.moveTo(mo + k * 420, GROUND - 22);
      c.lineTo(mo + k * 420 + 90, GROUND - 92); c.lineTo(mo + k * 420 + 170, GROUND - 40);
      c.lineTo(mo + k * 420 + 250, GROUND - 78); c.lineTo(mo + k * 420 + 420, GROUND - 22); c.closePath(); c.fill();
    }
    // golden gate bridge in the distance
    const bo = -(st.dist * 0.16) % 1100;
    for (let k = 0; k < 2; k++) {
      const bx = bo + k * 1100 + 300;
      c.fillStyle = '#c0392b';
      for (const tx of [bx, bx + 190]) { c.fillRect(tx, GROUND - 100, 8, 82); c.fillRect(tx - 3, GROUND - 78, 14, 3); c.fillRect(tx - 3, GROUND - 58, 14, 3); }
      c.fillRect(bx - 150, GROUND - 38, 500, 4);
      c.strokeStyle = '#c0392b'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(bx - 150, GROUND - 38); c.quadraticCurveTo(bx - 60, GROUND - 66, bx + 4, GROUND - 100); c.stroke();
      c.beginPath(); c.moveTo(bx + 4, GROUND - 100); c.quadraticCurveTo(bx + 98, GROUND - 24, bx + 194, GROUND - 100); c.stroke();
      c.beginPath(); c.moveTo(bx + 194, GROUND - 100); c.quadraticCurveTo(bx + 280, GROUND - 66, bx + 350, GROUND - 38); c.stroke();
    }
    // ocean strip
    c.fillStyle = '#5cb6d6'; c.fillRect(0, GROUND - 24, W, 14);
    c.fillStyle = '#9bd8ec'; for (let x = (-st.dist * 0.3) % 40; x < W; x += 40) c.fillRect(x, GROUND - 20, 14, 2);
    // palm silhouettes
    c.fillStyle = '#8a3b3b';
    const po = -(st.dist * 0.4) % 360;
    for (let k = -1; k < 3; k++) {
      const px = po + k * 360 + 130;
      c.fillRect(px, GROUND - 76, 4, 66);
      for (let a = 0; a < 5; a++) { const ang = -2.8 + a * 0.55; c.beginPath(); c.moveTo(px + 2, GROUND - 76); c.lineTo(px + 2 + Math.cos(ang) * 26, GROUND - 76 + Math.sin(ang) * 16 + 8); c.lineTo(px + 2 + Math.cos(ang) * 22, GROUND - 76 + Math.sin(ang) * 12); c.closePath(); c.fill(); }
    }
    // sand
    c.fillStyle = '#f2d391'; c.fillRect(0, GROUND, W, H - GROUND);
    c.fillStyle = '#dcb872'; c.fillRect(0, GROUND, W, 2);
    c.fillStyle = '#e4c27c'; for (let x = (-st.dist) % 70; x < W; x += 70) { c.fillRect(x, GROUND + 14, 18, 2); c.fillRect(x + 34, GROUND + 24, 10, 2); }
  }
  function drawSceneNJ(c) {
    const g = c.createLinearGradient(0, 0, 0, GROUND);
    g.addColorStop(0, '#6c7587'); g.addColorStop(0.6, '#a2abbb'); g.addColorStop(1, '#cfd5df');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // grey clouds
    c.fillStyle = '#8791a3';
    for (const cl of st.clouds) { const cx = ((cl[0] - st.dist * 0.05) % (W + 160) + W + 160) % (W + 160) - 80; c.fillRect(cx, cl[1], 70, 10); c.fillRect(cx + 14, cl[1] - 8, 42, 10); }
    // nyc-ish skyline across the river
    c.fillStyle = '#4a5265';
    const so = -(st.dist * 0.1) % 360;
    const bld = [[0, 38], [22, 64], [44, 46], [66, 88], [88, 52], [110, 70], [134, 40], [158, 98], [186, 58], [210, 76], [236, 44], [262, 64], [290, 50], [320, 80]];
    for (let k = -1; k < 3; k++) for (const [bx, bh] of bld) { c.fillRect(so + k * 360 + bx, GROUND - 18 - bh, 20, bh); }
    c.fillStyle = '#4a5265'; c.fillRect(so + 158 + 360 + 8, GROUND - 18 - 112, 3, 14);
    c.fillStyle = '#e8d46a'; for (let k = -1; k < 3; k++) for (const [bx, bh] of bld) for (let w = 0; w < 4; w++) c.fillRect(so + k * 360 + bx + 4 + (w % 2) * 8, GROUND - 14 - bh + 8 + w * 14, 3, 3);
    // river
    c.fillStyle = '#56637a'; c.fillRect(0, GROUND - 18, W, 8);
    // power poles + sagging lines
    const po = -(st.dist * 0.45) % 220;
    c.fillStyle = '#3b3f48'; c.strokeStyle = '#3b3f48'; c.lineWidth = 1;
    for (let k = -1; k < 4; k++) {
      const px = po + k * 220 + 60;
      c.fillRect(px, GROUND - 96, 4, 90); c.fillRect(px - 12, GROUND - 90, 28, 3);
      c.beginPath(); c.moveTo(px - 10, GROUND - 88); c.quadraticCurveTo(px + 100, GROUND - 66, px + 210, GROUND - 88); c.stroke();
    }
    // road
    c.fillStyle = '#4b505a'; c.fillRect(0, GROUND, W, H - GROUND);
    c.fillStyle = '#e0b43a'; c.fillRect(0, GROUND + 3, W, 2);
    c.fillStyle = '#d6d9df'; for (let x = (-st.dist) % 60; x < W; x += 60) c.fillRect(x, GROUND + 22, 30, 3);
    c.fillStyle = '#3d414a'; for (let x = (-st.dist * 0.9) % 90; x < W; x += 90) c.fillRect(x, GROUND + 33, 6, 2);
  }
  function drawSign(c, s) {
    const nj = s.kind === 'nj';
    c.fillStyle = '#5a5a5a'; c.fillRect(s.x + 6, GROUND - 50, 5, 50); c.fillRect(s.x + 108, GROUND - 50, 5, 50);
    c.fillStyle = '#ffffff'; c.fillRect(s.x, GROUND - 96, 120, 52);
    c.fillStyle = nj ? '#1d6b3a' : '#1f6fb5'; c.fillRect(s.x + 3, GROUND - 93, 114, 46);
    c.fillStyle = '#ffffff'; c.textAlign = 'center';
    c.font = 'bold 10px ui-monospace, Menlo, monospace'; c.fillText('welcome to', s.x + 60, GROUND - 76);
    c.font = 'bold 15px ui-monospace, Menlo, monospace'; c.fillText(nj ? 'new jersey' : 'california', s.x + 60, GROUND - 58);
    c.font = '8px ui-monospace, Menlo, monospace'; c.fillText(nj ? 'the garden state' : 'the golden state', s.x + 60, GROUND - 49);
    c.textAlign = 'left';
  }

  const lmImg = k => IMGS[LANDMARKS[k]];
  const lmScale = 3;
  const lmWidth = k => { const im = lmImg(k); return im && im.naturalWidth ? im.naturalWidth * lmScale : 190; };
  function streetSign(c, x, line1, line2) {
    c.fillStyle = '#4a4a4a'; c.fillRect(x + 36, GROUND - 40, 3, 42);
    c.fillStyle = '#ffffff'; c.fillRect(x, GROUND - 58, 76, 22);
    c.fillStyle = '#1d6b3a'; c.fillRect(x + 2, GROUND - 56, 72, 18);
    c.fillStyle = '#ffffff'; c.textAlign = 'center';
    c.font = 'bold 9px ui-monospace, Menlo, monospace'; c.fillText(line1, x + 38, GROUND - 46);
    c.font = '7px ui-monospace, Menlo, monospace'; c.fillText(line2, x + 38, GROUND - 40);
    c.textAlign = 'left';
  }
  function drawLandmark(c, l) {
    const im = lmImg(l.kind);
    if (!im || !im.complete || !im.naturalWidth) return;
    const w = im.naturalWidth * lmScale, h = im.naturalHeight * lmScale, x = Math.round(l.x), y = GROUND - h + 3;
    c.drawImage(im, x, y, w, h);
    if (l.kind === 'home') streetSign(c, x + w + 4, 'kingman ave', PLACES.homeNo ? 'no. ' + PLACES.homeNo : 'los angeles');
    if (l.kind === 'njhouse') streetSign(c, x + w + 4, 'kendal ave', PLACES.njNo ? 'no. ' + PLACES.njNo : 'maplewood nj');
    if (l.kind === 'school') {                                  // name on the wooden board in front of the building
      c.fillStyle = '#4a3320'; c.textAlign = 'center';
      c.font = 'bold 8px ui-monospace, Menlo, monospace';
      c.fillText('rustic canyon', x + 21.5 * lmScale, y + 27.5 * lmScale + 3);
      c.fillText('elementary', x + 21.5 * lmScale, y + 27.5 * lmScale + 12);
      c.textAlign = 'left';
    }
  }

  function draw() {
    if (!ctx) return;
    const B = bakeAll();
    ctx.imageSmoothingEnabled = false;
    drawSceneCA(ctx);
    if (st.zoneT > 0) { ctx.globalAlpha = st.zoneT; drawSceneNJ(ctx); ctx.globalAlpha = 1; }
    for (const l of st.landmarks) drawLandmark(ctx, l);
    for (const s of st.signs) drawSign(ctx, s);
    // obstacles
    for (const o of st.obs) {
      let spr = B.o[o.kind];
      if (o.kind === 'bird') spr = B.o[o.names[Math.floor(st.anim / 28) % 2]];
      ctx.drawImage(spr, Math.round(o.x), Math.round(GROUND - o.lift - spr.height + (o.kind === 'bird' ? 0 : 3)));
    }
    // zouzou
    let f = 'a';
    if (st.mode === 'dead') f = 'dead';
    else if (st.h > 0) f = 'jump';
    else if (st.mode === 'run') f = Math.floor(st.anim / 38) % 2 ? 'b' : 'a';
    else f = 'a';
    const cs = B.cat[f];
    ctx.fillStyle = 'rgba(0,0,0,0.16)'; ctx.fillRect(CAT_X + 12, GROUND + 2, 50 - Math.min(30, st.h / 4), 3);
    ctx.drawImage(cs, CAT_X, Math.round(GROUND - st.h - cs.height + 3));
    // hud
    ctx.font = 'bold 13px ui-monospace, Menlo, monospace'; ctx.textAlign = 'right';
    ctx.fillStyle = st.zoneT > 0.5 ? '#f1f3f7' : '#6b3a2a';
    const best = Math.max(hiScore(), score());
    ctx.fillText('hi ' + String(best).padStart(5, '0') + '   ' + String(score()).padStart(5, '0'), W - 12, 20);
    ctx.textAlign = 'left';
    ctx.fillText(st.zone === 'nj' ? PLACES.njCity : PLACES.homeCity, 12, 20);
    if (st.banner > 0) {
      ctx.textAlign = 'center'; ctx.font = 'bold 18px ui-monospace, Menlo, monospace';
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(W / 2 - 150, 52, 300, 34);
      ctx.fillStyle = '#ffffff'; ctx.fillText('welcome to new jersey', W / 2, 75); ctx.textAlign = 'left';
    }
    if (st.caption && st.caption.t > 0 && st.mode === 'run') {
      const a = Math.min(1, st.caption.t / 30);
      ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.font = 'bold 12px ui-monospace, Menlo, monospace';
      const tw = ctx.measureText(st.caption.text).width + 20;
      ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fillRect(W / 2 - tw / 2, H - 28, tw, 20);
      ctx.fillStyle = '#ffffff'; ctx.fillText(st.caption.text, W / 2, H - 14); ctx.textAlign = 'left'; ctx.globalAlpha = 1;
    }
    if (st.mode === 'idle') overlay('tap to start', 'zouzou is leaving ' + PLACES.homeStreet);
    if (st.mode === 'dead') overlay('game over', st.dead > 24 ? 'tap to run again' : '');
  }
  function overlay(a, b) {
    const cx = st.mode === 'idle' ? 400 : W / 2;      // idle: sit to the right so the house stays visible
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(cx - 140, 40, 280, b ? 58 : 38);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 20px ui-monospace, Menlo, monospace'; ctx.fillText(a, cx, 66);
    if (b) { ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.fillText(b, cx, 86); }
    ctx.textAlign = 'left';
  }

  // ----------------------------------------------------------- loop + lifecycle
  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (!last) last = t;
    acc += Math.min(100, t - last); last = t;
    while (acc >= 1000 / 60) { tick(); acc -= 1000 / 60; }
    draw();
  }
  function on(el, ev, fn, o) { el.addEventListener(ev, fn, o); listeners.push([el, ev, fn, o]); }
  function mount(canvas, options = {}) {
    unmount();
    cv = canvas; ctx = cv.getContext('2d'); opts = options;
    cv.width = W; cv.height = H;
    reset();
    on(cv, 'pointerdown', e => { e.preventDefault(); jump(); });
    on(window, 'pointerup', release);
    on(document, 'keydown', e => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { e.preventDefault(); if (!e.repeat) jump(); }
    });
    on(document, 'keyup', e => { if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') release(); });
    last = 0; acc = 0; raf = requestAnimationFrame(loop);
    draw();
  }
  function unmount() {
    if (raf) cancelAnimationFrame(raf); raf = 0;
    listeners.forEach(([el, ev, fn, o]) => el.removeEventListener(ev, fn, o)); listeners = [];
    cv = null; ctx = null;
  }

  // test hooks (headless stepping: the embedded browser throttles animation frames)
  const api = {
    state: st, S, NJ_AT, DIST_PER_POINT, SCHOOL_AT, NJ_HOUSE_AT, score, jump, release,
    step(n = 1) { for (let i = 0; i < n; i++) tick(); draw(); },
    hit: () => st.mode === 'dead',
    setDist(d) { st.dist = d; },
  };
  return { mount, unmount, api, hiScore, places: PLACES, isMounted: () => !!cv };
})();
