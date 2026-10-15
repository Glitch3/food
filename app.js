'use strict';

// everything on screen is lowercase, including the native dialogs
const _confirm = window.confirm.bind(window), _alert = window.alert.bind(window);
window.confirm = m => _confirm(String(m).toLowerCase());
window.alert = m => _alert(String(m).toLowerCase());

/* ---------- helpers ---------- */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Dessert', 'Drink'];

const ICON_FORK = '<svg viewBox="0 0 24 24"><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 2-3 5-3 8h3v10"/></svg>';
const ICON_CAMERA = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.3L12 17.1 6.4 20.2l1.2-6.3L3 9.6l6.3-.8z"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const ICON_BOOKMARK = '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';

function defaultMealType() {
  const h = new Date().getHours();
  return h >= 5 && h < 11 ? 'Breakfast' : h >= 11 && h < 16 ? 'Lunch' : h >= 16 && h < 22 ? 'Dinner' : 'Snack';
}

/* ---------- storage (IndexedDB) ---------- */

const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('plated', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meals', { keyPath: 'id' });
        req.result.createObjectStore('wishlist', { keyPath: 'id' });
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
      t.onerror = () => reject(t.error);
    });
  },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); },
  put(store, items) {
    const list = Array.isArray(items) ? items : [items];
    return this.tx(store, 'readwrite', s => list.forEach(i => s.put(i)));
  },
  del(store, ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    return this.tx(store, 'readwrite', s => list.forEach(i => s.delete(i)));
  },
  clear(store) { return this.tx(store, 'readwrite', s => s.clear()); },
};

/* ---------- state ---------- */

const state = {
  meals: [],      // always sorted best-first by position
  wishlist: [],
  tab: 'home',
  filter: null,
  sort: 'rank',   // 'rank' | 'ai' | 'new'
  mealsView: 'eaten',   // 'eaten' | 'want'
  search: '',
  sheet: null,    // null | { kind: 'add' | 'detail' | 'bookmark', ... }
};

/* ---------- ranking ---------- */

const Ranking = {
  sort() { state.meals.sort((a, b) => a.position - b.position); },

  /** Rank-based score: best = top of the scale, worst = bottom, evenly spread in between. It is shrunk toward the
   *  middle while you have few meals (two meals can't tell a 10 from a 1) and firms up as you rank more. */
  score(meal) {
    const n = state.meals.length;
    if (n <= 1) return 6.5;
    const raw = 1 + 9 * (n - 1 - meal.position) / (n - 1);     // 1 (worst) .. 10 (best)
    const confidence = (n - 1) / (n + 2);                       // 0.25 at 2 meals, 0.75 at 10, 0.91 at 30
    return Math.round((6.5 + (raw - 6.5) * confidence) * 10) / 10;
  },

  fmt(score) { return score >= 10 ? '10' : score.toFixed(1); },

  async insert(meal, index) {
    const shifted = [];
    for (const m of state.meals) if (m.position >= index) { m.position += 1; shifted.push(m); }
    meal.position = index;
    state.meals.push(meal);
    this.sort();
    await DB.put('meals', [...shifted, meal]);
  },

  async remove(meal) {
    state.meals = state.meals.filter(m => m.id !== meal.id);
    const shifted = [];
    for (const m of state.meals) if (m.position > meal.position) { m.position -= 1; shifted.push(m); }
    await DB.del('meals', meal.id);
    if (shifted.length) await DB.put('meals', shifted);
  },
};

/** Binary search over the ranked list, driven by "which do you prefer?" taps. */
class Session {
  constructor(bucket) { this.b = bucket; this.low = 0; this.high = bucket.length; this.stop = null; this.hist = []; }
  snap() { this.hist.push([this.low, this.high, this.stop]); }
  get canUndo() { return this.hist.length > 0; }
  undo() { const h = this.hist.pop(); if (h) [this.low, this.high, this.stop] = h; }
  get done() { return this.stop !== null || this.low >= this.high; }
  get candidate() { return this.done ? null : this.b[(this.low + this.high) >> 1]; }
  get index() { return this.stop !== null ? this.stop : this.low; }
  get left() { return this.done ? 0 : Math.max(1, Math.ceil(Math.log2(this.high - this.low + 1))); }
  newBetter() { this.snap(); this.high = (this.low + this.high) >> 1; }
  newWorse() { this.snap(); this.low = ((this.low + this.high) >> 1) + 1; }
  tie() { this.snap(); this.stop = (this.low + this.high) >> 1; }
}

/* ---------- photo handling ---------- */

function compressPhoto(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read photo')); };
    img.src = url;
  });
}

const bg = photo => (photo ? `style="background-image:url('${photo}')"` : '');


/* ---------- fun layer: cat, confetti, sound, badges ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];

const Fun = {
  data: { pets: 0, rematches: 0, unlocked: [], sound: true, recentRoasts: [], bestRun: 0 },
  load() { try { Object.assign(this.data, JSON.parse(localStorage.getItem('plated-fun') || '{}')); } catch (e) {} },
  save() { try { localStorage.setItem('plated-fun', JSON.stringify(this.data)); } catch (e) {} },
};

let audioCtx;
function tones(freqs, { type = 'square', gap = 0.09, vol = 0.07, len = 0.12 } = {}) {
  if (!Fun.data.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    freqs.forEach((f, i) => {
      const t = audioCtx.currentTime + i * gap;
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + len + 0.02);
    });
  } catch (e) {}
}

function meow() {
  if (!Fun.data.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(520, t);
    o.frequency.linearRampToValueAtTime(900, t + 0.13);
    o.frequency.linearRampToValueAtTime(430, t + 0.42);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.5);
  } catch (e) {}
}

const HEART = ['.xx.xx.', 'xxxxxxx', 'xxxxxxx', '.xxxxx.', '..xxx..', '...x...'];

/** Pixel confetti and floating hearts on a full-screen canvas. */
const FX = {
  parts: [], raf: 0, c: null, ctx: null,
  init() {
    this.c = $('#fx'); this.ctx = this.c.getContext('2d');
    const fit = () => { this.c.width = innerWidth; this.c.height = innerHeight; };
    fit(); addEventListener('resize', fit);
  },
  burst(x, y, n = 50) {
    const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff', '#ff9f43', '#ffffff'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 3 + Math.random() * 7;
      this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4, g: 0.28, size: 5 + Math.floor(Math.random() * 3) * 2,
        color: pickOne(colors), life: 70 + Math.random() * 40 });
    }
    this.run();
  },
  hearts(x, y, n = 6) {
    for (let i = 0; i < n; i++) {
      this.parts.push({ x: x + (Math.random() - 0.5) * 40, y, vx: (Math.random() - 0.5) * 2, vy: -1.5 - Math.random() * 2,
        g: -0.01, heart: true, size: 14 + Math.random() * 10, color: '#ff6b81', life: 55 + Math.random() * 25 });
    }
    this.run();
  },
  run() { if (!this.raf) this.raf = requestAnimationFrame(() => this.tick()); },
  tick() {
    const { ctx, c } = this;
    ctx.clearRect(0, 0, c.width, c.height);
    this.parts = this.parts.filter(p => p.life > 0 && p.y < c.height + 20);
    for (const p of this.parts) {
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life -= 1;
      ctx.globalAlpha = Math.min(1, p.life / 25);
      ctx.fillStyle = p.color;
      if (p.heart) {
        const u = Math.max(2, Math.round(p.size / 7));
        HEART.forEach((row, j) => [...row].forEach((c, i) => { if (c === 'x') ctx.fillRect(Math.round(p.x) + i * u, Math.round(p.y) + j * u, u, u); }));
      }
      else ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
    this.raf = this.parts.length ? requestAnimationFrame(() => this.tick()) : 0;
    if (!this.raf) ctx.clearRect(0, 0, c.width, c.height);
  },
};

const QUIPS = {
  greet: ['oh look, the fatass is back.', 'hey fatass, what did you eat?', 'back already, fatass?', 'feed me meals to rank, fatass.', 'hungry again, fatass?'],
  fat: ['eat up, fatass.', 'go on, fatass.', 'sure, fatass.', 'wow, fatass.', 'you absolute fatass.'],
  pet: ['Purrrr…', 'Meow!', 'More pets please.', 'Right behind the ear…', 'Mrrp!', 'You’re my favorite human.'],
  compare: ['trust your gut, fatass.', 'tough one…', 'which looks tastier, fatass?', 'i’d eat both. so would you, fatass.', 'ooh, fancy.', 'pick one, fatass.'],
  tab: {
    home: ['zouzou is watching you, fatass.', 'back so soon, gluttonous?'],
    meals: ['look at all that food. you ate all of it.', 'your ranking, best first.'],
    game: ['run, zouzou, run.', 'california, then new jersey. good luck.'],
    about: ['that’s me. i’m adorable and you’re gluttonous.', 'read my bio, fatass.'],
  },
};

const Mascot = {
  timer: 0,
  say(text, ms = 2800) {
    const b = $('#bubble');
    b.textContent = String(text).toLowerCase(); b.hidden = false;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { b.hidden = true; }, ms);
  },
  pet() {
    const cat = $('#cat');
    cat.classList.remove('pop'); void cat.offsetWidth; cat.classList.add('pop');
    Fun.data.pets += 1; Fun.save();
    const r = cat.getBoundingClientRect();
    FX.hearts(r.left + r.width / 2, r.top + r.height / 2, 5);
    meow();
    this.say(Fun.data.pets % 10 === 0 ? `${Fun.data.pets} pets! I love you.` : pickOne(QUIPS.pet));
    checkBadges();
  },
};

function toast(text, ms = 2400) {
  const t = $('#toast');
  t.textContent = String(text).toLowerCase(); t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

const BADGES = [
  { id: 'first',  name: 'First Bite',      desc: 'Rank 1 meal',          test: () => state.meals.length >= 1 },
  { id: 'five',   name: 'Snack Attack',    desc: 'Rank 5 meals',         test: () => state.meals.length >= 5 },
  { id: 'ten',    name: 'Foodie',          desc: 'Rank 10 meals',        test: () => state.meals.length >= 10 },
  { id: 'many',   name: 'Gourmet',         desc: 'Rank 25 meals',        test: () => state.meals.length >= 25 },
  { id: 'photo',  name: 'Shutterbug',      desc: '5 meals with photos',  test: () => state.meals.filter(m => m.photo).length >= 5 },
  { id: 'places', name: 'Explorer',        desc: '5 different places',   test: () => new Set(state.meals.map(m => m.place).filter(Boolean)).size >= 5 },
  { id: 'rematch',name: 'Tough Judge',     desc: 'Settle 5 rematches',   test: () => Fun.data.rematches >= 5 },
  { id: 'wish',   name: 'Dream Menu',      desc: 'Save 3 to try',        test: () => state.wishlist.length >= 3 },
  { id: 'ai',     name: 'Picture Perfect', desc: 'AI score of 9+',       test: () => state.meals.some(m => m.ai && m.ai.score >= 9) },
  { id: 'cali',   name: 'California Cat',  desc: 'score 250 in the game',  test: () => Fun.data.bestRun >= 250 },
  { id: 'jersey', name: 'Made It To Jersey', desc: 'cross into new jersey', test: () => Fun.data.bestRun >= 600 },
  { id: 'cat',    name: 'Cat Whisperer',   desc: 'Pet the cat 10 times', test: () => Fun.data.pets >= 10 },
];

/** Unlock any newly earned badges. `silent` records them without the fanfare (used at startup). */
function checkBadges(silent = false) {
  const fresh = BADGES.filter(b => !Fun.data.unlocked.includes(b.id) && b.test());
  if (!fresh.length) return;
  fresh.forEach(b => Fun.data.unlocked.push(b.id));
  Fun.save();
  if (silent) return;
  fresh.forEach((b, i) => setTimeout(() => {
    toast(`badge unlocked: ${b.name}`, 2600);
    FX.burst(innerWidth / 2, innerHeight - 140, 40);
    tones([523, 659, 784, 1047], { gap: 0.08 });
  }, 900 + i * 2200));
}

function countUp(el, target, ms = 900) {
  if (!el) return;
  const t0 = performance.now();
  const step = t => {
    const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Ranking.fmt(p < 1 ? target * e : target);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function verdict(score) {
  if (score >= 9) return ['Absolute banger', 'that’s a banger, fatass. save me some.'];
  if (score >= 7) return ['Tasty!', 'tasty. you earned it, fatass.'];
  if (score >= 5) return ['Solid', 'solid. another one down, fatass.'];
  if (score >= 3) return ['Meh', 'meh. and you ate it anyway, fatass.'];
  return ['Yikes', 'yikes. why did you eat that, fatass?'];
}

/** One tappable photo card, used by the add flow and by rematches. */
function cardHTML(m, { action, pick, tag }) {
  return `
    <button class="card" data-action="${action}" data-pick="${pick}">
      <div class="photo ${m.photo ? '' : 'empty'}" ${bg(m.photo)}>${m.photo ? '' : ICON_FORK}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</div>
      <div class="name">${esc(m.name)}</div>
    </button>`;
}

/** Flash the chosen card, fade the other, and play a blip. */
async function flashPick(choice) {
  const cards = document.querySelectorAll('#sheet .card');
  const chosen = $(`#sheet .card[data-pick="${choice}"]`);
  if (!chosen) return;
  cards.forEach(c => c.classList.toggle('picked', c === chosen));
  cards.forEach(c => c.classList.toggle('lost', c !== chosen));
  tones([660, 880], { gap: 0.06, len: 0.08 });
  await sleep(260);
}



/* ---------- the cat's roasts ---------- */

// every roast must contain one of these (checked in code, not just requested from the model)
const GLUTTON_RX = /glutton|gormand|gorg|ravenous|voracious|insatiable|piggish|swinish|rapacious|greedy|bottomless|trencher|devour/i;

const Roast = {
  ADJ: ['gluttonous', 'ravenous', 'voracious', 'gormandizing', 'insatiable', 'piggish', 'rapacious', 'swinish', 'bottomless', 'gluttonous'],
  NOUN: ['gourmand', 'gorger', 'human garbage disposal', 'calorie vacuum', 'buffet-wrecker', 'black hole in sneakers', 'walking trash compactor',
    'snack-seeking missile', 'hoover with legs', 'landfill in a hoodie', 'feeding-frenzy mascot', 'trough enthusiast', 'human dumpster',
    'hog in human form', 'gullet with a mortgage', 'all-you-can-eat tragedy'],
  VERB: ['inhale', 'hoover up', 'demolish', 'devour', 'vaporize', 'annihilate', 'speed-run', 'ambush', 'tear through', 'obliterate'],
  VERBING: ['inhaling', 'demolishing', 'devouring', 'vaporizing', 'annihilating', 'speed-running', 'obliterating', 'tearing through'],
  // comedic angles handed to the AI so its roasts differ from each other
  THEMES: ['a nature documentary narrator', 'a medieval town crier', 'a disappointed michelin inspector', 'a courtroom prosecutor',
    'a sports commentator', 'a horror movie trailer', 'a stock market analyst', 'a wedding toast gone wrong', 'a weather forecaster',
    'a pirate captain', 'an airline safety announcement', 'a passive-aggressive waiter', 'a space mission control operator',
    'a true crime podcast host', 'a shakespearean villain', 'an exhausted dietitian', 'a wildlife ranger', 'a fire marshal'],
  T: [
    "you photographed {d} like a memorial. it's about to be one, you {adj} {noun}.",
    "i've seen pigeons show more restraint around a dropped fry, you {adj} {noun}.",
    "{D}? you'll {verb} it before the flash stops blinking, you {adj} {noun}.",
    "the plate is already scared of you, you {adj} {noun}.",
    "even the garbage disposal thinks you're a lot, you {adj} {noun}.",
    "your stomach isn't a stomach, it's one {adj} black hole with a snack habit.",
    "scientists are baffled: a {adj} {noun} who stops to take a photo. the delay won't save {d}.",
    "every picture you post is a {adj} cry for help holding a fork.",
    "that's your third 'light snack' today, you {adj} {noun}. i'm counting.",
    "buffets pin your photo by the entrance as a warning, you {adj} {noun}.",
    "you don't eat, you stage a {adj} hostile takeover of {d}.",
    "somewhere a cow just felt a chill, you {adj} {noun}.",
    "{d} had dreams. you, a {adj} {noun}, had other plans.",
    "you could {verb} {d} and still ask the waiter what dessert is like, you {adj} {noun}.",
    "the only thing {adj} enough to match your appetite is the void, you {noun}.",
    "forks file restraining orders against a {adj} {noun} like you.",
    "{d} is the last thing standing between you and one {adj} breakdown, you {noun}.",
    "your appetite has its own zip code, you {adj} {noun}.",
    "you chew like {d} owes you money, you {adj} {noun}.",
    "the waiter saw you coming and doubled the portions out of fear, you {adj} {noun}.",
    "ten out of ten for appetite, zero for self-control, you {adj} {noun}.",
    "not even a vacuum cleaner commits to a mess like you do, you {adj} {noun}.",
    "your fridge has a hostage note and it's signed by a {adj} {noun}.",
    "if gluttony were an olympic sport, you'd be disqualified for {verbing} the podium, you {adj} {noun}.",
    "{d} will be gone in four bites and you'll blame the portion size, you {adj} {noun}.",
    "legend says a {adj} {noun} once finished a meal slowly. it was a myth, just like your willpower.",
    "your {adj} gullet is a landfill with a loyalty card, and today's drop-off is {d}.",
    "the leftovers didn't survive you, they just lodged a complaint, you {adj} {noun}.",
    "you didn't order {d}, you launched a {adj} invasion, you {noun}.",
    "dinner theatre called. they'd like their {adj} {noun} back, the one who {verbs} the props.",
  ],
  recent() { return Fun.data.recentRoasts || []; },
  remember(text) { Fun.data.recentRoasts = [text, ...this.recent().filter(t => t !== text)].slice(0, 12); Fun.save(); },
  fill(t, dish) {
    const d = dish ? dish.trim().toLowerCase() : 'that plate';
    return t.replace(/\{d\}/g, d).replace(/\{D\}/g, d)
      .replace(/\{adj\}/g, () => pickOne(this.ADJ)).replace(/\{noun\}/g, () => pickOne(this.NOUN))
      .replace(/\{verbing\}/g, () => pickOne(this.VERBING))
      .replace(/\{verbs\}/g, () => pickOne(this.VERB) + 's').replace(/\{verb\}/g, () => pickOne(this.VERB));
  },
  /** a fresh, never-just-repeated roast built from the word banks. */
  local(dish) {
    let out = '';
    for (let i = 0; i < 12; i++) {                   // re-roll a few times to dodge recent lines
      out = this.fill(pickOne(this.T), dish);
      if (!GLUTTON_RX.test(out)) out = out.replace(/[.?!]+$/, '') + `, you ${pickOne(this.ADJ)} ${pickOne(this.NOUN)}.`;   // safety net: the rule always holds
      if (!this.recent().includes(out)) break;
    }
    this.remember(out);
    return out;
  },
  KILLERS: { cactus: 'a cactus', palm: 'a palm tree', surf: 'a surfboard', umbrella: 'a beach umbrella', taco: 'a taco', bird: 'a bird',
    barrier: 'a jersey barrier', cone: 'a traffic cone', hydrant: 'a fire hydrant', trash: 'a trash can' },
  G: [
    "{n} points and you got flattened by {k}, you {adj} {noun}.",
    "you lost to {k}. your {adj} stomach never even slowed down.",
    "that's {n}. a nap-powered cat runs farther than a {adj} {noun} like you.",
    "{k} ended your run at {n}. at least it was the only thing you didn't eat, you {adj} {noun}.",
    "all that gorging and you still can't hop over {k}, you {adj} {noun}.",
    "{n} points. the {adj} {noun} has fallen, and {k} sends its regards.",
    "you died to {k}. even your {adj} appetite couldn't pull you over it.",
    "i'd clap for {n}, but you're a {adj} {noun} who lost to {k}.",
  ],
  gameOver(points, kind) {
    const k = this.KILLERS[kind] || 'an obstacle';
    let out = '';
    for (let i = 0; i < 8; i++) {
      out = this.fill(pickOne(this.G), '').replace(/\{n\}/g, points).replace(/\{k\}/g, k);
      if (!this.recent().includes(out)) break;
    }
    if (!GLUTTON_RX.test(out)) out = out.replace(/[.?!]+$/, '') + `, you ${pickOne(this.ADJ)} ${pickOne(this.NOUN)}.`;
    this.remember(out);
    return out;
  },
  theme() { return pickOne(this.THEMES); },
  /** use the model's roast if it kept to the brief; otherwise swap in a local one so the rule always holds. */
  /** keep whole sentences up to ~200 characters (models overshoot the length they're asked for). */
  shorten(t, max = 200) {
    if (t.length <= max) return t;
    const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t];
    let out = '';
    for (const sentence of sentences) { if ((out + sentence).trim().length > max) break; out += sentence; }
    return out.trim();
  },
  fromAI(text, dish) {
    const full = String(text || '').trim().toLowerCase();
    let t = this.shorten(full);
    if (!GLUTTON_RX.test(t)) t = full;                       // the required word was in a sentence we cut: keep the full text
    if (t && GLUTTON_RX.test(t) && t.length <= 320) { this.remember(t); return t; }
    return this.local(dish);
  },
};
/** how long a speech bubble stays up: longer lines get more time. */
const roastMs = text => Math.min(10000, 3200 + String(text).length * 50);

/* ---------- dates ---------- */

const pad2 = n => String(n).padStart(2, '0');
/** ms -> value for <input type="datetime-local"> in the user's local time. */
const toLocalInput = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fromLocalInput = v => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : Date.now(); };
const fmtDT = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtShort = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/* ---------- AI look-rating (Claude vision) ---------- */

const AI_MODELS = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5 (cheapest)',
};

const GROQ_MODEL = 'qwen/qwen3.8-27b';   // vision-capable chat model on groq
const AI_LABELS = { ...AI_MODELS, [GROQ_MODEL]: 'qwen 3.8 via groq' };

const AI_SYSTEM = `You are a calm, consistent food photography judge inside a meal-ranking app. You judge ONLY how good the meal LOOKS in the photo, never the person.
First decide whether the photo shows food or drink at all (is_food). If it does not, set is_food to false, set every part to 0 and say so in the comment.
Otherwise score four parts, each an integer from 0 to 10, using these anchors: 1-2 = unappetizing or a mess; 3-4 = poor; 5 = an ordinary phone snapshot of ordinary food; 6-7 = clearly appetizing and tidy; 8 = very appealing, well lit and nicely plated; 9-10 = a restaurant-menu hero shot (rare). Use the whole range and do not cluster everything at 7.
- appetizing: how much you want to eat it (colour, texture, gloss, portion).
- presentation: plating, arrangement, how tidy the plate and its surroundings are.
- freshness: does it look fresh and properly cooked (no burnt, wilted, grey or congealed look).
- lighting: exposure, focus and composition of the photo itself.
Judge only what is visible. Do not reward a dish for being fancy or penalise it for being simple.
Name the dish in a few words. The comment is one or two short, neutral sentences about the photo only, specific to what is visible: one strength and, if relevant, what holds the score back. Keep every joke and insult out of the comment; they belong only in the roast.

Also write a "roast" of the PERSON who is about to eat this. It must be savage, very creative and genuinely funny, aimed only at their gluttony, appetite and eating habits, and it must mention something specific you can see in the photo (if there is no food, roast them for posting that while being a glutton). Address them as "you". Use at least one of these words or a close synonym: gluttonous, ravenous, voracious, gormandizing, insatiable, piggish, greedy. One or two short sentences and strictly under 160 characters (count them), all lowercase, no emojis, no hashtags. Never use slurs and never attack race, gender, religion, disability or any other protected trait. Make it different from earlier roasts: the user message gives a comedic angle for this one.`;

const AI_PARTS = ['appetizing', 'presentation', 'freshness', 'lighting'];
const AI_WEIGHTS = { appetizing: 0.4, presentation: 0.25, freshness: 0.2, lighting: 0.15 };
const AI_SCHEMA = {
  type: 'object',
  properties: {
    dish: { type: 'string', description: 'Short name of the dish, e.g. "Chicken parmesan with spaghetti"' },
    is_food: { type: 'boolean', description: 'true if the photo shows food or drink' },
    appetizing: { type: 'integer', description: '0 to 10' },
    presentation: { type: 'integer', description: '0 to 10' },
    freshness: { type: 'integer', description: '0 to 10' },
    lighting: { type: 'integer', description: '0 to 10' },
    comment: { type: 'string', description: 'One or two short sentences' },
    roast: { type: 'string', description: 'A savage, creative roast of the eater\'s gluttony, strictly under 160 characters, lowercase' },
  },
  required: ['dish', 'is_food', 'appetizing', 'presentation', 'freshness', 'lighting', 'comment', 'roast'],
  additionalProperties: false,
};

const AI = {
  Anthropic: null, client: null, clientKey: '',

  // Two providers. Keys live only in this browser's localStorage (never in the repo).
  anthropicKey() { try { return localStorage.getItem('plated-key') || ''; } catch (e) { return ''; } },
  groqKey() { try { return localStorage.getItem('plated-groq-key') || ''; } catch (e) { return ''; } },
  provider() {
    let p = '';
    try { p = localStorage.getItem('plated-provider') || ''; } catch (e) {}
    if (p === 'groq' || p === 'anthropic') return p;
    return this.groqKey() ? 'groq' : this.anthropicKey() ? 'anthropic' : 'groq';
  },
  setProvider(p) { try { localStorage.setItem('plated-provider', p); } catch (e) {} },
  /** the key for whichever provider is selected */
  key() { return this.provider() === 'groq' ? this.groqKey() : this.anthropicKey(); },
  setKey(k) {
    const name = this.provider() === 'groq' ? 'plated-groq-key' : 'plated-key';
    try { if (k) localStorage.setItem(name, k); else localStorage.removeItem(name); } catch (e) {}
    this.client = null;
  },
  model() { try { const m = localStorage.getItem('plated-model'); return AI_MODELS[m] ? m : 'claude-opus-5-5'; } catch (e) { return 'claude-opus-5-5'; } },
  setModel(m) { try { localStorage.setItem('plated-model', m); } catch (e) {} },

  /** The official SDK, vendored in this repo (no runtime CDN) and loaded only when first needed. */
  async getClient() {
    const key = this.anthropicKey();
    if (!key) throw new Error('Add your Anthropic API key in Profile first.');
    if (!this.client || this.clientKey !== key) {
      this.Anthropic = this.Anthropic || (await import('./vendor/anthropic-sdk.mjs')).default;
      // dangerouslyAllowBrowser: this is a personal, on-device app and the key never leaves this browser except to api.anthropic.com
      this.client = new this.Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
      this.clientKey = key;
    }
    return this.client;
  },

  /** photo is a data: URL (jpeg). Resolves to { dish, score, comment, model, at }. */
  analyze(photo) {
    return this.provider() === 'groq' ? this.analyzeGroq(photo) : this.analyzeAnthropic(photo);
  },

  /** The user message: a fresh comedic angle plus recent roasts to avoid, so every photo gets a new one. */
  userText() {
    const recent = Roast.recent().slice(0, 6);
    return `Rate how good this meal looks. For the roast, channel ${Roast.theme()}.` +
      (recent.length ? ` Do not reuse these earlier roasts or their openings: ${recent.map(r => `"${r}"`).join(' ')}` : '');
  },

  /** Shared: turn the model's JSON into a result. The score is computed here from four sub-scores
   *  (more consistent than asking a model for one holistic number). */
  finish(text, model) {
    let out;
    try { out = JSON.parse(text); } catch (e) { throw new Error('Got an unreadable answer. Try again.'); }
    const clamp = v => Math.max(0, Math.min(10, Number(v)));
    const parts = {};
    AI_PARTS.forEach(k => { parts[k] = Math.round(clamp(out[k])); });          // NaN if the model skipped one
    const haveParts = AI_PARTS.every(k => Number.isFinite(parts[k]));
    let score;
    if (out.is_food === false) { score = 0; AI_PARTS.forEach(k => { parts[k] = 0; }); }
    else if (haveParts) score = AI_PARTS.reduce((sum, k) => sum + parts[k] * AI_WEIGHTS[k], 0);
    else score = clamp(out.score);                                               // older / partial answers
    score = Math.round(score * 10) / 10;
    if (!Number.isFinite(score)) throw new Error('Got an unreadable score. Try again.');
    const dish = String(out.dish || '').trim();
    return { dish, score, parts: haveParts || out.is_food === false ? parts : null, comment: String(out.comment || '').trim(),
      roast: Roast.fromAI(out.roast, dish), model, at: Date.now() };
  },

  /** Groq: OpenAI-compatible chat completions with a strict JSON schema; the photo goes in as a data: URL. */
  async analyzeGroq(photo) {
    const key = this.groqKey();
    if (!key) throw new Error('Add your Groq API key in Profile first.');
    const request = () => fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 600,        // the answer is ~150 tokens; groq counts the reserved max against its tokens-per-minute limit
        temperature: 0.5,
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content: [
            { type: 'text', text: this.userText() },
            { type: 'image_url', image_url: { url: photo } },
          ] },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'look_rating', strict: true, schema: AI_SCHEMA } },
      }),
    });
    let res = await request();
    if (res.status === 429) {                        // groq rate limits are short: wait it out once, then retry
      const wait = Math.min(Number(res.headers.get('retry-after')) || 8, 40);
      await sleep(wait * 1000);
      res = await request();
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (e) {}
      const err = new Error(detail || `Groq error ${res.status}`);
      err.provider = 'groq'; err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error('Groq sent an empty answer. Try again.');
    if (choice.finish_reason === 'length') throw new Error('The answer was cut off. Try again.');
    return this.finish(choice.message.content || '', GROQ_MODEL);
  },

  async analyzeAnthropic(photo) {
    const client = await this.getClient();
    const model = this.model();
    const params = {
      model,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
      system: AI_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo.split(',')[1] } },
          { type: 'text', text: this.userText() },
        ],
      }],
    };

    let res;
    if (model === 'claude-opus-5-5') {
      // Server-side refusal fallback is on by default for Opus 5.5; if the API rejects it, retry without.
      try {
        res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
      } catch (e) {
        if (e instanceof this.Anthropic.BadRequestError && /fallback/i.test(e.message || '')) res = await client.messages.create(params);
        else throw e;
      }
    } else {
      res = await client.messages.create(params);
    }

    if (res.stop_reason === 'refusal') throw new Error('The model declined to rate this photo.');
    if (res.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try again.');
    const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return this.finish(text, model);
  },

  /** Plain-English message for any failure. */
  explain(e) {
    if (e && e.provider === 'groq') {
      if (e.status === 401) return 'Your Groq API key was rejected. Check it in Profile.';
      if (e.status === 403) return 'Your Groq key can’t use that model.';
      if (e.status === 413) return 'That photo is too large for Groq.';
      if (e.status === 429) return 'Rate limited by Groq. Try again in a minute.';
      return e.message;
    }
    if (e instanceof TypeError) return 'Couldn’t reach the AI service. Check your connection.';
    const A = this.Anthropic;
    if (A && e instanceof A.AuthenticationError) return 'Your API key was rejected. Check it in Profile.';
    if (A && e instanceof A.PermissionDeniedError) return 'Your API key can’t use that model.';
    if (A && e instanceof A.RateLimitError) return 'Rate limited. Try again in a minute.';
    if (A && e instanceof A.APIConnectionError) return 'Couldn’t reach Anthropic. Check your connection.';
    const apiMessage = e && e.error && e.error.error && e.error.error.message;   // the API's own error text
    return apiMessage || (e && e.message) || 'Something went wrong.';
  },
};

/** The AI card: loading / result / error / "add a key" hint. */
function aiBlock({ status = 'idle', data = null, error = '', retry = '', hint = true }) {
  if (status === 'loading') {
    return `<div class="ai loading"><div class="ai-dot"></div><div class="tx"><b>AI is looking at your meal…</b><span>Rating how good it looks</span></div></div>`;
  }
  if (status === 'done' && data) {
    return `<div class="ai"><div class="score ai-ring">${Ranking.fmt(data.score)}</div>
      <div class="tx"><b>${esc(data.dish || 'AI look score')}</b><span>${esc(data.comment)}</span>${data.parts ? `<small class="parts">looks ${data.parts.appetizing} · plating ${data.parts.presentation} · fresh ${data.parts.freshness} · light ${data.parts.lighting}</small>` : ''}${data.roast ? `<span class="roast"><b>zouzou says</b>${esc(data.roast)}</span>` : ''}
      <small>ai look score · ${esc(AI_LABELS[data.model] || data.model)}</small>${retry}</div></div>`;
  }
  if (status === 'error') {
    return `<div class="ai err"><div class="tx"><b>AI couldn’t rate this</b><span>${esc(error)}</span>${retry}</div></div>`;
  }
  if (!AI.key() && hint) {
    return `<div class="ai hint"><div class="tx"><span>add an ai key (groq or anthropic) in profile to get an ai rating of how good your meal looks.</span></div></div>`;
  }
  return '';
}

/* ---------- shared view pieces ---------- */

function thumb(m) {
  return m.photo
    ? `<div class="thumb" ${bg(m.photo)}></div>`
    : `<div class="thumb empty">${ICON_FORK}</div>`;
}

function mealRow(m, { rank = null, sub = null } = {}) {
  const subtitle = sub ?? [m.place, m.type, fmtShort(m.date), m.ai ? `ai ${Ranking.fmt(m.ai.score)}` : ''].filter(Boolean).join(' · ');
  return `
    <button class="row" data-action="open" data-id="${m.id}">
      ${rank !== null ? `<div class="rank">${rank}</div>` : ''}
      ${thumb(m)}
      <div class="info">
        <div class="title">${esc(m.name)}</div>
        <div class="sub">${esc(subtitle)}</div>
      </div>
      <div class="score">${Ranking.fmt(Ranking.score(m))}</div>
    </button>`;
}

function emptyState(icon, title, text, button = '') {
  return `<div class="empty-state">${icon}<h3>${title}</h3><p>${text}</p>${button}</div>`;
}

/* ---------- tab views ---------- */

function renderHome() {
  const meals = state.meals;
  if (!meals.length) {
    return `<h1>zouzou's food lister</h1>` + emptyState(
      ICON_FORK, 'Rank every meal you eat',
      'Add a photo, tap the one you prefer against past meals, and zouzou will judge you for it.',
      '<button class="btn" data-action="add">Add your first meal</button>'
    );
  }
  const avg = meals.reduce((sum, m) => sum + Ranking.score(m), 0) / meals.length;
  const recent = [...meals].sort((a, b) => b.date - a.date).slice(0, 5);
  return `
    <h1>zouzou's food lister</h1>
    <p class="muted" style="margin:-6px 0 4px">${meals.length} meal${meals.length === 1 ? '' : 's'} ranked · average ${avg.toFixed(1)}</p>
    <div class="duo">
      ${meals.length >= 2 ? '<button class="btn alt" data-action="rematch">rematch</button>' : ''}
      <button class="btn alt" data-action="roulette">what to eat?</button>
    </div>
    <h2>Your top meals</h2>
    ${meals.slice(0, 3).map((m, i) => mealRow(m, { rank: i + 1 })).join('')}
    <h2>Recently eaten</h2>
    ${recent.map(m => mealRow(m, { sub: [fmtDT(m.date), m.ai ? `ai ${Ranking.fmt(m.ai.score)}` : ''].filter(Boolean).join(' · ') })).join('')}`;
}

function filteredMeals() {
  const q = state.search.trim().toLowerCase();
  const rows = state.meals
    .map((m, i) => ({ m, rank: i + 1 }))
    .filter(({ m }) => !state.filter || m.type === state.filter)
    .filter(({ m }) => !q || m.name.toLowerCase().includes(q) || (m.place || '').toLowerCase().includes(q));
  if (state.sort === 'new') rows.sort((a, b) => b.m.date - a.m.date);
  else if (state.sort === 'ai') rows.sort((a, b) => (b.m.ai ? b.m.ai.score : -1) - (a.m.ai ? a.m.ai.score : -1) || a.rank - b.rank);
  return rows;
}

function mealListHTML() {
  if (!state.meals.length) {
    return emptyState(ICON_CAMERA, 'No meals yet', 'Tap Add to photograph and rank your first meal.');
  }
  const rows = filteredMeals();
  if (!rows.length) return emptyState('', 'No results', 'Try a different search or filter.');
  return rows.map(({ m, rank }) => mealRow(m, { rank })).join('');
}

function eatenBody() {
  return `
    <input class="field search" type="search" placeholder="Search meals and places" value="${esc(state.search)}" data-field="search">
    <div class="chips">
      <button class="chip ${state.filter ? '' : 'on'}" data-action="filter" data-type="">All</button>
      ${MEAL_TYPES.map(t => `<button class="chip ${state.filter === t ? 'on' : ''}" data-action="filter" data-type="${t}">${t}</button>`).join('')}
    </div>
    <div id="meal-list">${mealListHTML()}</div>`;
}

function renderMeals() {
  return `
    <h1>My Meals</h1>
    <div class="seg" style="margin-bottom:14px">
      <button class="${state.mealsView === 'eaten' ? 'on' : ''}" data-action="meals-view" data-view="eaten">eaten · ${state.meals.length}</button>
      <button class="${state.mealsView === 'want' ? 'on' : ''}" data-action="meals-view" data-view="want">want to try · ${state.wishlist.length}</button>
    </div>
    ${state.mealsView === 'want' ? wantBody() : eatenBody()}`;
}

function quickIdeas() {
  const items = suggestIdeas('all', '', quickIdeas.seed || (quickIdeas.seed = String(Math.random())), 6);
  return items.length ? `<div class="section-title" style="margin-top:4px">suggested for you · tap to add</div><div class="sugg" style="margin-bottom:8px">${items.map(i => ideaChip(i, 'idea-add')).join('')}</div>` : '';
}

function wantBody() {
  const header = `<button class="pill" data-action="new-bookmark">+ Save a meal</button>`;
  if (!state.wishlist.length) {
    return header + quickIdeas() + emptyState(ICON_BOOKMARK, 'Nothing saved', 'Save meals you want to try. Tap “Ate it” once you have one to rank it.');
  }
  const items = [...state.wishlist].sort((a, b) => b.createdAt - a.createdAt);
  return header + quickIdeas() + items.map(w => `
    <div class="row">
      <div class="info">
        <div class="title">${esc(w.name)}</div>
        <div class="sub">${esc([w.place, w.note].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="actions">
        <button data-action="ate" data-id="${w.id}" style="color:var(--accent);font-weight:600">Ate it</button>
        <button class="muted" data-action="del-bookmark" data-id="${w.id}">Remove</button>
      </div>
    </div>`).join('');
}

const ZOUZOU_BIO = "hi, i'm zouzou. i love looking down from cat heaven to judge every single thing that you eat and make fun of you for it. i also like to crawl under blankets if you prop your legs up.";

function renderAbout() {
  return `
    <h1>about zouzou</h1>
    <div class="art"><img src="about-heaven.png" alt="pixel art of zouzou the cat with a halo and angel wings, looking down from a cloud" width="512" height="384"></div>
    <p class="bio">${esc(ZOUZOU_BIO)}</p>
    <div class="art"><img src="about-blanket.png" alt="pixel art of zouzou peeking out from under a blanket next to someone's propped-up legs" width="512" height="352"></div>

    <div class="section-title">Badges · ${Fun.data.unlocked.length}/${BADGES.length}</div>
    <div class="badges">
      ${BADGES.map(b => {
        const on = Fun.data.unlocked.includes(b.id);
        return `<div class="badge ${on ? '' : 'locked'}"><div class="ic">${on ? ICON_STAR : ICON_LOCK}</div><b>${b.name}</b><span>${b.desc}</span></div>`;
      }).join('')}
    </div>
    <p class="muted small" style="margin:10px 0 0">you’ve petted zouzou ${Fun.data.pets} time${Fun.data.pets === 1 ? '' : 's'}. best run: ${Math.max(Fun.data.bestRun || 0, Game.hiScore())}.</p>

    <div class="section-title">Settings</div>
    <button class="toggle" data-action="sound"><span>Sounds</span><i>${Fun.data.sound ? 'On' : 'Off'}</i></button>
    <details class="aiopts">
      <summary>ai rating setup${AI.key() ? ' · key saved' : ''}</summary>
      <div class="ai-set">
        <div class="seg" style="margin-bottom:12px">
          ${[['groq', 'groq'], ['anthropic', 'anthropic']].map(([id, label]) => `<button class="${AI.provider() === id ? 'on' : ''}" data-action="ai-provider" data-provider="${id}">${label}${(id === 'groq' ? AI.groqKey() : AI.anthropicKey()) ? ' (key saved)' : ''}</button>`).join('')}
        </div>
        <p class="muted small" style="margin:0 0 8px">${AI.key() ? `${AI.provider()} key saved on this device (…${esc(AI.key().slice(-4))}).` : `Paste your ${AI.provider()} API key to let AI rate how good your meals look.`}</p>
        <input class="field" id="ai-key" type="password" placeholder="${AI.provider() === 'groq' ? 'gsk_…' : 'sk-ant-…'}" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="duo" style="margin:10px 0">
          <button class="btn alt" data-action="ai-save">Save key</button>
          ${AI.key() ? '<button class="btn alt" data-action="ai-remove">Remove key</button>' : ''}
        </div>
        ${AI.provider() === 'anthropic'
          ? `<div class="seg">${Object.entries(AI_MODELS).map(([id, label]) => `<button class="${AI.model() === id ? 'on' : ''}" data-action="ai-model" data-model="${id}">${label}</button>`).join('')}</div>`
          : `<p class="muted small" style="margin:0">Model: ${GROQ_MODEL}</p>`}
        <p class="muted small" style="margin-top:10px">Your key is stored only in this browser, never in the code. Photos are sent to ${AI.provider() === 'groq' ? 'Groq' : 'Anthropic'} only when you analyze a meal.</p>
      </div>
    </details>

    <div class="section-title">Data</div>
    <div class="list-item"><button data-action="sample">Load sample meals</button></div>
    <div class="list-item"><button class="danger" data-action="erase" ${state.meals.length ? '' : 'disabled style="opacity:.3"'}>Erase all meals</button></div>
    <p class="muted small" style="margin-top:20px">Meals are stored on this device only, in your browser. Clearing Safari website data will erase them.</p>`;
}

/* ---------- the game tab ---------- */

const GAME_OPTS = {
  onStart() { const m = $('#game-msg'); if (m) m.textContent = ''; Mascot.say(pickOne(['run, zouzou, run.', 'don’t trip, you gluttonous disaster.', 'jump, fatass.']), 2200); },
  onJump() { tones([480, 680], { gap: 0.04, len: 0.06, vol: 0.035 }); },
  onLandmark(kind) {
    const P = Game.places;
    if (kind === 'home') Mascot.say(`zouzou leaves ${P.homeStreet}, ${P.homeCity}. don’t look back, gluttonous.`, 4200);
    else if (kind === 'school') Mascot.say('rustic canyon elementary. this is where you learned to inhale lunch, fatass.', 4600);
    else if (kind === 'njhouse') Mascot.say(`${P.njStreet}. someone in there is judging you too, you ravenous menace.`, 4600);
  },
  onZone(zone) { if (zone === 'nj') { Mascot.say('welcome to new jersey. ew. i hope you packed a bagel, fatass.', 4800); tones([392, 330, 262], { gap: 0.12 }); FX.burst(innerWidth / 2, innerHeight * 0.35, 40); } },
  onDeath(points, zone, isBest, killer) {
    Fun.data.bestRun = Math.max(Fun.data.bestRun || 0, points); Fun.save();
    const line = Roast.gameOver(points, killer);
    const m = $('#game-msg'); if (m) m.textContent = (isBest && points > 0 ? `new best: ${points}. ` : `${points} point${points === 1 ? '' : 's'}. `) + line;
    Mascot.say(line, roastMs(line));
    tones([392, 311, 247, 196], { gap: 0.1, len: 0.14, vol: 0.06 });
    checkBadges();
  },
};

function renderGame() {
  return `
    <h1>zouzou's run</h1>
    <div class="gamewrap"><canvas id="game-canvas" width="600" height="200" aria-label="endless runner game: zouzou the cat runs and jumps over obstacles"></canvas></div>
    <p class="muted small center" style="margin-top:10px">tap, click or press space to jump. hold for a higher jump.<br>make it past ${Game.api.NJ_AT} points and you reach new jersey.</p>
    <p id="game-msg" class="gamemsg"></p>`;
}

function render() {
  // don't rebuild the game screen under a running game (e.g. when a sheet closes)
  if (!(state.tab === 'game' && Game.isMounted() && $('#game-canvas'))) {
    const views = { home: renderHome, meals: renderMeals, game: renderGame, about: renderAbout };
    $('#view').innerHTML = views[state.tab]();
    if (state.tab === 'game') Game.mount($('#game-canvas'), GAME_OPTS); else Game.unmount();
  }
  document.querySelectorAll('#tabbar [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  renderSheet();
}

/* ---------- sheets ---------- */

function openSheet(sheet) { if (state.tab === 'game') Game.unmount(); state.sheet = sheet; renderSheet(); }
function closeSheet() { state.sheet = null; renderSheet(); render(); }

function renderSheet() {
  const el = $('#sheet');
  const s = state.sheet;
  // The cat hides while a sheet is open, except on screens whose top-right is free.
  const catVisible = !s || s.kind === 'add' || s.kind === 'rematch' || s.kind === 'roulette';
  $('#mascot').classList.toggle('away', !catVisible);
  if (!s) { el.hidden = true; el.innerHTML = ''; document.body.style.overflow = ''; return; }
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  const html = { add: () => addSheet(s), detail: () => detailSheet(s), bookmark: () => bookmarkSheet(s),
                 rematch: () => rematchSheet(s), roulette: () => rouletteSheet(s) }[s.kind]();
  el.innerHTML = `<div class="inner">${html}</div>`;
}

/* --- add flow --- */

function newAdd(prefill = {}) {
  return {
    kind: 'add', step: 'photo',
    photo: null, name: prefill.name || '', place: prefill.place || '',
    type: defaultMealType(), notes: '', wishId: prefill.wishId || null,
    when: toLocalInput(Date.now()), ai: { status: 'idle' }, autoName: false,
    draft: null, session: null, result: null,
  };
}

function addSheet(a) {
  if (a.step === 'photo') {
    return `
      <div class="topbar"><button data-action="close">Cancel</button><span>New meal</span><button disabled></button></div>
      <label class="drop ${a.photo ? 'filled' : ''}" ${bg(a.photo)}>
        <input type="file" accept="image/*" data-field="photo">
        ${a.photo ? '' : `<div>${ICON_CAMERA}<b>Choose a photo</b><span class="muted small">Snap what you ate, then rank it</span></div>`}
      </label>
      <div id="ai-slot">${a.photo ? aiBlock(addAIView(a)) : ''}</div>
      <input class="field" placeholder="Name (optional)" value="${esc(a.name)}" data-field="name">
      <label class="when"><span>Eaten</span><input class="field" type="datetime-local" data-field="when" value="${esc(a.when)}"></label>
      <details>
        <summary>More details</summary>
        <div class="stack">
          <input class="field" placeholder="Where? (restaurant, home-cooked…)" value="${esc(a.place)}" data-field="place">
          <div class="seg">${MEAL_TYPES.map(t => `<button class="${a.type === t ? 'on' : ''}" data-action="type" data-type="${t}">${t}</button>`).join('')}</div>
          <textarea class="field" rows="3" placeholder="Notes" data-field="notes">${esc(a.notes)}</textarea>
        </div>
      </details>
      <div class="spacer"></div>
      <button class="btn" data-action="start-ranking" ${a.photo ? '' : 'disabled'}>Start ranking</button>`;
  }

  if (a.step === 'compare') {
    const cand = a.session.candidate;
    return `
      <div class="topbar"><span></span><span>New meal</span><span></span></div>
      <div class="compare-head">
        <h2>Which do you prefer?</h2>
        <div class="muted small">${a.session.left} left</div>
      </div>
      <div class="compare">
        ${cardHTML(a.draft, { action: 'pick', pick: 'new', tag: 'New' })}
        ${cardHTML(cand, { action: 'pick', pick: 'old' })}
      </div>
      <div class="center" style="margin-top:20px; display:grid; gap:10px">
        <button class="link" data-action="pick" data-pick="tie">Too close to call</button>
        ${a.session.canUndo ? '<button class="link" data-action="pick" data-pick="undo">Undo last pick</button>' : ''}
      </div>`;
  }

  // result
  const r = a.result;
  return `
    <div class="topbar"><span></span><span></span><span></span></div>
    <div class="result">
      <div class="photo" ${bg(a.draft.photo)}></div>
      <h2 style="margin:0;font-size:24px">${esc(a.draft.name)}</h2>
      <div class="score big">${Ranking.fmt(r.score)}</div>
      <div class="verdict">${verdict(r.score)[0]}</div>
      <div class="muted">#${r.rank} of ${r.total}</div>
      <div id="ai-slot" style="width:100%;text-align:left">${aiBlock({ ...addAIView(a), hint: false })}</div>
    </div>
    <div class="spacer"></div>
    <button class="btn" data-action="close">Done</button>`;
}

/* --- AI analysis inside the add flow --- */

function addAIView(a) {
  return { ...a.ai, retry: '<button class="link" data-action="ai-retry">Retry</button>' };
}

function refreshAddAI(a) {
  if (state.sheet !== a) return;
  const el = $('#ai-slot');
  if (el) el.innerHTML = aiBlock({ ...addAIView(a), hint: a.step === 'photo' });
}

/** Kick off the AI rating for the chosen photo. Keeps running (and saves its result) even if the flow moves on. */
function startAddAI(a) {
  if (!a.photo || !AI.key()) { a.ai = { status: 'idle' }; return; }
  const ai = a.ai = { status: 'loading', data: null, error: '' };
  ai.promise = AI.analyze(a.photo)
    .then(d => { ai.status = 'done'; ai.data = d; })
    .catch(e => { ai.status = 'error'; ai.error = AI.explain(e); })
    .then(() => {
      if (a.ai !== ai) return;                      // a newer photo replaced this analysis
      if (ai.status === 'done' && a.draft) {
        a.draft.ai = ai.data;
        if (a.autoName && ai.data.dish) a.draft.name = ai.data.dish;
        if (state.meals.includes(a.draft)) DB.put('meals', a.draft);
      }
      refreshAddAI(a);
      if (ai.status === 'done') { Mascot.say(ai.data.roast, roastMs(ai.data.roast)); checkBadges(); }
    });
}

async function startRanking() {
  const a = state.sheet;
  if (!a || !a.photo) return;
  const aiDish = a.ai && a.ai.status === 'done' && a.ai.data.dish;
  a.autoName = !a.name.trim();
  const name = a.name.trim() || aiDish ||
    `${a.type}, ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  a.draft = {
    id: uid(), name, place: a.place.trim(), type: a.type, notes: a.notes,
    date: fromLocalInput(a.when), createdAt: Date.now(), photo: a.photo, position: 0,
    ai: a.ai && a.ai.status === 'done' ? a.ai.data : null,
  };
  if (a.ai && a.ai.status === 'done') a.autoName = false;   // already named from the AI result, or by the user
  a.session = new Session([...state.meals]);
  if (a.session.done) await finishRanking();
  else { a.step = 'compare'; renderSheet(); Mascot.say(pickOne(QUIPS.compare)); }
}

async function pick(choice) {
  const a = state.sheet;
  if (!a || a.step !== 'compare' || a.busy) return;
  if (choice === 'undo') { a.session.undo(); renderSheet(); return; }
  a.busy = true;
  if (choice !== 'tie') await flashPick(choice);
  a.busy = false;
  if (choice === 'new') a.session.newBetter();
  else if (choice === 'old') a.session.newWorse();
  else a.session.tie();
  if (a.session.done) await finishRanking();
  else { renderSheet(); if (Math.random() < 0.5) Mascot.say(pickOne(QUIPS.compare)); }
}

async function finishRanking() {
  const a = state.sheet;
  await Ranking.insert(a.draft, a.session.index);
  if (a.wishId) {
    await DB.del('wishlist', a.wishId);
    state.wishlist = state.wishlist.filter(w => w.id !== a.wishId);
  }
  a.result = { score: Ranking.score(a.draft), rank: a.draft.position + 1, total: state.meals.length };
  a.step = 'done';
  renderSheet();

  const [, line] = verdict(a.result.score);
  countUp($('#sheet .score.big'), a.result.score);
  FX.burst(innerWidth / 2, innerHeight * 0.32, a.result.score >= 7 ? 90 : 30);
  tones(a.result.score >= 7 ? [523, 659, 784, 1047] : [392, 330], { gap: 0.1 });
  Mascot.say(line, 3400);
  checkBadges();
}

/* --- detail --- */

function detailSheet(s) {
  const m = state.meals.find(x => x.id === s.id);
  if (!m) return '';
  return `
    <div class="topbar"><button data-action="close">Back</button><span style="max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span><button class="danger" data-action="delete" data-id="${m.id}">Delete</button></div>
    ${m.photo ? `<div class="hero" ${bg(m.photo)}></div>` : ''}
    <div class="detail-head">
      <div class="score mid">${Ranking.fmt(Ranking.score(m))}</div>
      <b>#${m.position + 1} of ${state.meals.length}</b>
    </div>
    ${m.place ? `<div class="kv"><span>Where</span><span>${esc(m.place)}</span></div>` : ''}
    <div class="kv"><span>Meal</span><span>${esc(m.type)}</span></div>
    <div class="kv"><span>Eaten</span><input class="dt" type="datetime-local" value="${esc(toLocalInput(m.date))}" data-field="detail-date" data-id="${m.id}"></div>
    <div class="kv"><span>Added to the lister</span><span>${esc(fmtDT(m.createdAt || m.date))}</span></div>
    <div id="ai-detail">${detailAIHTML(m)}</div>
    <div class="section-title">Notes</div>
    <textarea class="field" rows="4" placeholder="Add a note…" data-field="detail-notes" data-id="${m.id}">${esc(m.notes)}</textarea>`;
}

/* --- AI analysis of an existing meal --- */

const aiBusy = {};   // meal id -> { status: 'loading' | 'error', error }

function detailAIHTML(m) {
  const b = aiBusy[m.id];
  if (b) return aiBlock({ status: b.status, error: b.error, retry: `<button class="link" data-action="ai-analyze" data-id="${m.id}">Retry</button>` });
  if (m.ai) return aiBlock({ status: 'done', data: m.ai, retry: m.photo ? `<button class="link" data-action="ai-analyze" data-id="${m.id}">Re-analyze</button>` : '' });
  if (!m.photo) return '';
  if (!AI.key()) return aiBlock({});
  return `<button class="btn alt" style="margin:12px 0" data-action="ai-analyze" data-id="${m.id}">analyze with ai</button>`;
}

function refreshDetailAI(m) {
  const s = state.sheet;
  const el = s && s.kind === 'detail' && s.id === m.id ? $('#ai-detail') : null;
  if (el) el.innerHTML = detailAIHTML(m);
}

async function analyzeMeal(id) {
  const m = state.meals.find(x => x.id === id);
  if (!m || !m.photo || aiBusy[id]?.status === 'loading') return;
  aiBusy[id] = { status: 'loading' };
  refreshDetailAI(m);
  try {
    m.ai = await AI.analyze(m.photo);
    delete aiBusy[id];
    await DB.put('meals', m);
    Mascot.say(m.ai.roast || `ai says ${Ranking.fmt(m.ai.score)}/10. ${pickOne(QUIPS.fat)}`, roastMs(m.ai.roast || ''));
    checkBadges();
  } catch (e) {
    aiBusy[id] = { status: 'error', error: AI.explain(e) };
  }
  refreshDetailAI(m);
}


/* ---------- want-to-try suggestions ---------- */

const IDEA_CATS = ['all', 'breakfast', 'lunch', 'dinner', 'snack', 'dessert', 'drink'];

// [name, category, cuisine]
const MEAL_IDEAS = [
  // breakfast
  ['avocado toast', 'breakfast', 'cafe'], ['pancakes', 'breakfast', 'american'], ['french toast', 'breakfast', 'american'],
  ['breakfast burrito', 'breakfast', 'mexican'], ['eggs benedict', 'breakfast', 'american'], ['huevos rancheros', 'breakfast', 'mexican'],
  ['shakshuka', 'breakfast', 'middle eastern'], ['bagel with lox', 'breakfast', 'deli'], ['acai bowl', 'breakfast', 'cafe'],
  ['chilaquiles', 'breakfast', 'mexican'], ['breakfast sandwich', 'breakfast', 'american'], ['waffles', 'breakfast', 'american'],
  ['oatmeal with berries', 'breakfast', 'cafe'], ['dim sum brunch', 'breakfast', 'chinese'], ['biscuits and gravy', 'breakfast', 'southern'],
  ['croissant', 'breakfast', 'french'], ['yogurt parfait', 'breakfast', 'cafe'], ['omelette', 'breakfast', 'american'],
  // lunch
  ['chicken banh mi', 'lunch', 'vietnamese'], ['turkey club', 'lunch', 'american'], ['caesar salad', 'lunch', 'american'],
  ['poke bowl', 'lunch', 'hawaiian'], ['falafel wrap', 'lunch', 'middle eastern'], ['grilled cheese and tomato soup', 'lunch', 'american'],
  ['chicken burrito bowl', 'lunch', 'mexican'], ['reuben sandwich', 'lunch', 'deli'], ['pho', 'lunch', 'vietnamese'],
  ['cobb salad', 'lunch', 'american'], ['chicken salad sandwich', 'lunch', 'american'], ['bibimbap', 'lunch', 'korean'],
  ['gyro', 'lunch', 'greek'], ['ramen', 'lunch', 'japanese'], ['blt', 'lunch', 'american'], ['tuna melt', 'lunch', 'american'],
  ['butter chicken wrap', 'lunch', 'indian'], ['greek salad', 'lunch', 'greek'], ['philly cheesesteak', 'lunch', 'american'], ['clam chowder', 'lunch', 'american'],
  // dinner
  ['cacio e pepe', 'dinner', 'italian'], ['chicken parmesan', 'dinner', 'italian'], ['margherita pizza', 'dinner', 'italian'],
  ['lasagna', 'dinner', 'italian'], ['spaghetti carbonara', 'dinner', 'italian'], ['pad thai', 'dinner', 'thai'], ['green curry', 'dinner', 'thai'],
  ['butter chicken', 'dinner', 'indian'], ['chicken tikka masala', 'dinner', 'indian'], ['sushi platter', 'dinner', 'japanese'],
  ['tonkotsu ramen', 'dinner', 'japanese'], ['tacos al pastor', 'dinner', 'mexican'], ['carne asada tacos', 'dinner', 'mexican'],
  ['birria tacos', 'dinner', 'mexican'], ['korean fried chicken', 'dinner', 'korean'], ['bulgogi', 'dinner', 'korean'],
  ['kung pao chicken', 'dinner', 'chinese'], ['mapo tofu', 'dinner', 'chinese'], ['dumplings', 'dinner', 'chinese'],
  ['ribeye steak', 'dinner', 'steakhouse'], ['smash burger', 'dinner', 'american'], ['fish and chips', 'dinner', 'british'],
  ['bbq brisket', 'dinner', 'bbq'], ['pulled pork sandwich', 'dinner', 'bbq'], ['shrimp scampi', 'dinner', 'italian'],
  ['roast chicken', 'dinner', 'home-cooked'], ['mac and cheese', 'dinner', 'american'], ['chicken shawarma plate', 'dinner', 'middle eastern'],
  ['paella', 'dinner', 'spanish'], ['lobster roll', 'dinner', 'seafood'], ['fried chicken sandwich', 'dinner', 'american'],
  ['beef bourguignon', 'dinner', 'french'], ['jerk chicken', 'dinner', 'caribbean'], ['eggplant parmesan', 'dinner', 'italian'],
  ['pasta primavera', 'dinner', 'italian'], ['penne alla vodka', 'dinner', 'italian'], ['baked ziti', 'dinner', 'italian'], ['spaghetti and meatballs', 'dinner', 'italian'], ['fettuccine alfredo', 'dinner', 'italian'], ['gnocchi', 'dinner', 'italian'],
  ['chicken tenders and fries', 'dinner', 'american'], ['stuffed peppers', 'dinner', 'home-cooked'], ['veggie stir fry', 'dinner', 'chinese'], ['tofu curry', 'dinner', 'indian'],
  // snacks
  ['nachos', 'snack', 'mexican'], ['loaded fries', 'snack', 'american'], ['chips and guacamole', 'snack', 'mexican'],
  ['hummus and pita', 'snack', 'middle eastern'], ['soft pretzel', 'snack', 'american'], ['popcorn', 'snack', 'american'],
  ['mozzarella sticks', 'snack', 'american'], ['spring rolls', 'snack', 'vietnamese'], ['edamame', 'snack', 'japanese'],
  ['buffalo wings', 'snack', 'american'], ['onion rings', 'snack', 'american'], ['samosas', 'snack', 'indian'],
  ['empanadas', 'snack', 'latin'], ['charcuterie board', 'snack', 'french'], ['trail mix', 'snack', 'american'], ['street corn', 'snack', 'mexican'],
  ['jalapeno poppers', 'snack', 'american'], ['takoyaki', 'snack', 'japanese'],
  // desserts
  ['pistachio gelato', 'dessert', 'italian'], ['tiramisu', 'dessert', 'italian'], ['chocolate lava cake', 'dessert', 'french'],
  ['cheesecake', 'dessert', 'american'], ['creme brulee', 'dessert', 'french'], ['churros', 'dessert', 'mexican'],
  ['apple pie', 'dessert', 'american'], ['cookies and milk', 'dessert', 'american'], ['mochi ice cream', 'dessert', 'japanese'],
  ['banana pudding', 'dessert', 'southern'], ['brownie sundae', 'dessert', 'american'], ['key lime pie', 'dessert', 'american'],
  ['donuts', 'dessert', 'american'], ['baklava', 'dessert', 'middle eastern'], ['mango sticky rice', 'dessert', 'thai'],
  ['affogato', 'dessert', 'italian'], ['red velvet cake', 'dessert', 'southern'], ['cannoli', 'dessert', 'italian'],
  ['funnel cake', 'dessert', 'american'], ['macarons', 'dessert', 'french'], ['sticky toffee pudding', 'dessert', 'british'],
  // drinks
  ['iced latte', 'drink', 'cafe'], ['matcha latte', 'drink', 'japanese'], ['boba milk tea', 'drink', 'taiwanese'],
  ['fresh lemonade', 'drink', 'american'], ['smoothie', 'drink', 'cafe'], ['cold brew', 'drink', 'cafe'],
  ['chai latte', 'drink', 'indian'], ['mango lassi', 'drink', 'indian'], ['hot chocolate', 'drink', 'cafe'],
  ['milkshake', 'drink', 'american'], ['espresso martini', 'drink', 'cocktail'], ['margarita', 'drink', 'cocktail'],
  ['old fashioned', 'drink', 'cocktail'], ['horchata', 'drink', 'mexican'],
];

/** your own past meals first, then the built-in ideas; skips anything already on the list. */
function ideaPool() {
  const have = new Set(state.wishlist.map(w => w.name.toLowerCase()));
  const seen = new Set();
  const mine = state.meals.map(m => ({ name: m.name, cat: m.type.toLowerCase(), cuisine: '', mine: true }));
  const base = MEAL_IDEAS.map(([name, cat, cuisine]) => ({ name, cat, cuisine }));
  return [...mine, ...base].filter(i => {
    const k = i.name.toLowerCase();
    if (have.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const hashStr = str => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** matches for what's typed (or a stable random mix when nothing is typed), limited to the chosen category. */
function suggestIdeas(cat, query, seed, limit) {
  const q = query.trim().toLowerCase();
  let pool = ideaPool();
  if (cat !== 'all') pool = pool.filter(i => i.cat === cat);
  if (q) {
    pool = pool.filter(i => i.name.toLowerCase().includes(q) || i.cuisine.includes(q))
      .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || ((b.mine ? 1 : 0) - (a.mine ? 1 : 0)));
  } else {
    pool = pool.sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || (hashStr(a.name + seed) - hashStr(b.name + seed)));
  }
  return pool.slice(0, limit);
}

function ideaChip(i, action) {
  return `<button class="idea" data-action="${action}" data-name="${esc(i.name)}" data-cat="${esc(i.cat)}" data-cuisine="${esc(i.cuisine)}">${esc(i.name)}<i>${esc(i.cat)}</i></button>`;
}

function ideasHTML(s) {
  const q = $('#bm-name') ? $('#bm-name').value : '';
  const items = suggestIdeas(s.cat, q, s.seed, q.trim() ? 6 : 8);
  if (!items.length) return q.trim() ? '<span class="muted small">no suggestions. just save it as typed.</span>' : '';
  return items.map(i => ideaChip(i, 'idea')).join('');
}

function refreshIdeas() {
  const s = state.sheet;
  if (!s || s.kind !== 'bookmark') return;
  const el = $('#bm-sugg');
  if (el) el.innerHTML = ideasHTML(s);
}

/** tap a suggestion: autofill the name, and the note if it's still empty. */
function fillIdea(t) {
  $('#bm-name').value = t.dataset.name;
  const note = $('#bm-note');
  if (note && !note.value.trim()) note.value = [t.dataset.cat, t.dataset.cuisine].filter(Boolean).join(' · ');
  $('#bm-sugg').innerHTML = '';
}

/** one-tap add straight from the want to try tab. */
async function addIdea(t) {
  const item = { id: uid(), name: t.dataset.name, place: '', note: [t.dataset.cat, t.dataset.cuisine].filter(Boolean).join(' · '), createdAt: Date.now() };
  state.wishlist.push(item);
  await DB.put('wishlist', item);
  render();
  Mascot.say(`added ${item.name}. ${pickOne(QUIPS.fat)}`);
  checkBadges();
}

/* --- bookmark --- */

function bookmarkSheet(s) {
  return `
    <div class="topbar"><button data-action="close">Cancel</button><span>Want to try</span><button data-action="save-bookmark" style="color:var(--text);font-weight:600">Save</button></div>
    <div class="seg ideacats" style="margin-top:10px">${IDEA_CATS.map(c => `<button class="${s.cat === c ? 'on' : ''}" data-action="idea-cat" data-cat="${c}">${c}</button>`).join('')}</div>
    <div style="display:grid;gap:10px;margin-top:12px">
      <input class="field" id="bm-name" data-field="bm-name" placeholder="meal name (start typing for ideas)" autocomplete="off">
      <div class="sugg" id="bm-sugg"></div>
      <input class="field" id="bm-place" placeholder="Where? (optional)" autocomplete="off">
      <input class="field" id="bm-note" placeholder="Note (optional)" autocomplete="off">
    </div>`;
}

async function saveBookmark() {
  const name = $('#bm-name').value.trim();
  if (!name) { $('#bm-name').focus(); return; }
  const item = { id: uid(), name, place: $('#bm-place').value.trim(), note: $('#bm-note').value.trim(), createdAt: Date.now() };
  state.wishlist.push(item);
  await DB.put('wishlist', item);
  closeSheet();
  Mascot.say('saved. like you need more food, fatass.');
  checkBadges();
}


/* --- rematch: neighbours in your ranking go head-to-head --- */

function newPair(prev) {
  const n = state.meals.length;
  let i;
  do { i = Math.floor(Math.random() * (n - 1)); } while (n > 2 && i === prev);
  return i;
}

function rematchSheet(s) {
  const a = state.meals[s.i], b = state.meals[s.i + 1];
  if (!a || !b) return `<div class="topbar"><button data-action="close">Done</button><span></span><span></span></div>`;
  return `
    <div class="topbar"><button data-action="close">Done</button><span>Rematch</span><span style="min-width:60px"></span></div>
    <div class="compare-head">
      <h2>Settle it.</h2>
      <div class="muted small">Pick the winner. The better one moves up.</div>
    </div>
    <div class="compare">
      ${cardHTML(a, { action: 'rematch-pick', pick: 'a', tag: '#' + (s.i + 1) })}
      ${cardHTML(b, { action: 'rematch-pick', pick: 'b', tag: '#' + (s.i + 2) })}
    </div>
    <div class="center muted small" style="margin-top:22px">${Fun.data.rematches} rematch${Fun.data.rematches === 1 ? '' : 'es'} settled</div>`;
}

async function rematchPick(which) {
  const s = state.sheet;
  if (!s || s.kind !== 'rematch' || s.busy) return;
  const a = state.meals[s.i], b = state.meals[s.i + 1];
  if (!a || !b) return;
  s.busy = true;
  await flashPick(which);
  if (which === 'b') {
    [a.position, b.position] = [b.position, a.position];
    Ranking.sort();
    await DB.put('meals', [a, b]);
    Mascot.say(`plot twist, fatass. ${b.name} moves up.`, 3200);
    FX.burst(innerWidth / 2, innerHeight * 0.4, 45);
  } else {
    Mascot.say(pickOne(['called it, fatass.', 'the ranking holds, fatass.', 'no upset today, fatass.']));
  }
  Fun.data.rematches += 1; Fun.save();
  s.i = newPair(s.i);
  s.busy = false;
  renderSheet();
  checkBadges();
}

/* --- "What should I eat?" slot machine --- */

function roulettePool() {
  return state.wishlist.length
    ? { names: state.wishlist.map(w => w.name), from: 'your Want to Try list' }
    : { names: state.meals.slice(0, 5).map(m => m.name), from: 'your top meals' };
}

function rouletteSheet() {
  const pool = roulettePool();
  return `
    <div class="topbar"><button data-action="close">Done</button><span>What to eat?</span><span style="min-width:60px"></span></div>
    <div class="center muted small" style="margin-top:8px">${pool.names.length ? `Picking from ${pool.from}` : 'Nothing to pick from yet'}</div>
    <div class="slot" id="slot">${pool.names.length ? '?' : 'Rank a meal or save one to try first!'}</div>
    <button class="btn" data-action="spin" ${pool.names.length ? '' : 'disabled'}>Spin again</button>`;
}

async function spin() {
  const s = state.sheet;
  const { names } = roulettePool();
  if (!s || s.kind !== 'roulette' || s.spinning || !names.length) return;
  s.spinning = true;
  const slot = $('#slot');
  slot.classList.remove('landed');
  const total = 16 + Math.floor(Math.random() * 8);
  let delay = 55;
  for (let i = 0; i < total; i++) {
    if (state.sheet !== s) return;
    slot.textContent = names[(i + Math.floor(Math.random() * names.length)) % names.length];
    tones([300 + i * 25], { type: 'square', vol: 0.04, len: 0.05 });
    await sleep(delay);
    delay *= 1.13;
  }
  if (state.sheet !== s) return;
  slot.textContent = pickOne(names);
  slot.classList.add('landed');
  FX.burst(innerWidth / 2, innerHeight * 0.4, 70);
  tones([523, 659, 784], { gap: 0.09 });
  Mascot.say('go eat that, fatass.', 2600);
  s.spinning = false;
}

/* ---------- sample data ---------- */

const SAMPLE = [
  ['Cacio e Pepe', 'Home-cooked', 'Dinner', 'Finally nailed the sauce.'],
  ['Spicy Tuna Crispy Rice', 'Nobu', 'Dinner', 'Worth every dollar.'],
  ['Breakfast Burrito', 'Taco Corner', 'Breakfast', 'Extra salsa verde.'],
  ['Chicken Banh Mi', 'Lunch Spot', 'Lunch', ''],
  ['Pistachio Gelato', 'Gelateria', 'Dessert', ''],
  ['Turkey Club', 'Diner', 'Lunch', 'Solid, nothing special.'],
  ['Pad Thai', 'Takeout', 'Dinner', 'A little too sweet.'],
  ['Airport Sushi', 'Gate B12', 'Snack', 'Never again.'],
];

async function loadSample() {
  const added = SAMPLE.map(([name, place, type, notes], i) => ({
    id: uid(), name, place, type, notes, photo: null,
    date: Date.now() - Math.random() * 30 * 86400000, createdAt: Date.now(),
    position: state.meals.length + i,
  }));
  state.meals.push(...added);
  Ranking.sort();
  await DB.put('meals', added);
}

/* ---------- events ---------- */

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const { action, id } = t.dataset;

  switch (action) {
    case 'tab': {
      state.tab = t.dataset.tab; render(); window.scrollTo(0, 0);
      const v = $('#view'); v.classList.add('enter'); setTimeout(() => v.classList.remove('enter'), 700);
      if (Math.random() < 0.4) Mascot.say(pickOne(QUIPS.tab[state.tab]));
      break;
    }
    case 'pet': Mascot.pet(); break;
    case 'rematch': openSheet({ kind: 'rematch', i: newPair(-1) }); break;
    case 'rematch-pick': await rematchPick(t.dataset.pick); break;
    case 'roulette': openSheet({ kind: 'roulette' }); await spin(); break;
    case 'spin': await spin(); break;
    case 'sound': Fun.data.sound = !Fun.data.sound; Fun.save(); render(); if (Fun.data.sound) meow(); break;
    case 'add': openSheet(newAdd()); break;
    case 'close': closeSheet(); break;
    case 'open': openSheet({ kind: 'detail', id }); break;
    case 'filter': state.filter = t.dataset.type || null; render(); break;
    case 'type': state.sheet.type = t.dataset.type; {
      const open = $('#sheet details')?.open;
      renderSheet();
      if (open) $('#sheet details').open = true;
    } break;
    case 'start-ranking': await startRanking(); break;
    case 'pick': await pick(t.dataset.pick); break;
    case 'delete': {
      const m = state.meals.find(x => x.id === id);
      if (m && confirm(`Delete “${m.name}”?`)) { await Ranking.remove(m); closeSheet(); }
      break;
    }
    case 'new-bookmark':
      openSheet({ kind: 'bookmark', cat: 'all', seed: String(Math.random()) });
      refreshIdeas(); setTimeout(() => $('#bm-name')?.focus(), 50); break;
    case 'idea-cat':
      state.sheet.cat = t.dataset.cat;
      document.querySelectorAll('.ideacats button').forEach(b => b.classList.toggle('on', b.dataset.cat === t.dataset.cat));
      refreshIdeas(); break;
    case 'idea': fillIdea(t); break;
    case 'idea-add': await addIdea(t); break;
    case 'save-bookmark': await saveBookmark(); break;
    case 'del-bookmark':
      state.wishlist = state.wishlist.filter(w => w.id !== id);
      await DB.del('wishlist', id); render(); break;
    case 'ate': {
      const w = state.wishlist.find(x => x.id === id);
      if (w) openSheet(newAdd({ name: w.name, place: w.place, wishId: w.id }));
      break;
    }
    case 'sample': await loadSample(); render(); checkBadges(); break;
    case 'sort': state.sort = t.dataset.sort; render(); break;
    case 'meals-view': state.mealsView = t.dataset.view; render(); break;
    case 'ai-retry': if (state.sheet && state.sheet.kind === 'add') { startAddAI(state.sheet); refreshAddAI(state.sheet); } break;
    case 'ai-analyze': await analyzeMeal(id); break;
    case 'ai-save': {
      const v = ($('#ai-key').value || '').trim();
      if (!v) { toast('Paste a key first'); break; }
      AI.setKey(v); render();
      const looksRight = AI.provider() === 'groq' ? v.startsWith('gsk_') : v.startsWith('sk-ant-');
      toast(looksRight ? 'key saved' : `Saved, but that doesn’t look like ${AI.provider() === 'groq' ? 'a groq' : 'an anthropic'} key`);
      break;
    }
    case 'ai-remove': AI.setKey(''); render(); toast('Key removed'); break;
    case 'ai-provider': AI.setProvider(t.dataset.provider); render(); break;
    case 'ai-model': AI.setModel(t.dataset.model); render(); break;
    case 'erase':
      if (state.meals.length && confirm('Erase every meal you’ve ranked?')) {
        state.meals = []; await DB.clear('meals'); render();
      }
      break;
  }
});

document.addEventListener('input', e => {
  const f = e.target.dataset?.field;
  if (!f) return;
  const a = state.sheet;

  if (f === 'search') {
    state.search = e.target.value;
    $('#meal-list').innerHTML = mealListHTML();
  } else if (f === 'name' || f === 'place' || f === 'notes' || f === 'when') {
    a[f] = e.target.value;
  } else if (f === 'bm-name') {
    refreshIdeas();
  } else if (f === 'detail-date') {
    const m = state.meals.find(x => x.id === e.target.dataset.id);
    if (!m || !e.target.value) return;
    m.date = fromLocalInput(e.target.value);
    DB.put('meals', m);
  } else if (f === 'detail-notes') {
    const m = state.meals.find(x => x.id === e.target.dataset.id);
    if (!m) return;
    m.notes = e.target.value;
    clearTimeout(input.timer);
    input.timer = setTimeout(() => DB.put('meals', m), 400);
  }
});
const input = {};

document.addEventListener('change', async e => {
  const field = e.target.dataset?.field;
  // iOS Safari fires "change" (not always "input") for date pickers
  if (field === 'when' && state.sheet) { state.sheet.when = e.target.value; return; }
  if (field === 'detail-date') {
    const m = state.meals.find(x => x.id === e.target.dataset.id);
    if (m && e.target.value) { m.date = fromLocalInput(e.target.value); DB.put('meals', m); }
    return;
  }
  if (field !== 'photo') return;
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    state.sheet.photo = await compressPhoto(file);
    startAddAI(state.sheet);
    const instant = Roast.local(state.sheet.name);     // a picture was posted: the cat reacts immediately
    Mascot.say(instant, roastMs(instant));
    const open = $('#sheet details')?.open;
    renderSheet();
    if (open) $('#sheet details').open = true;
  } catch (err) {
    alert('Sorry, that photo could not be loaded.');
  }
});

/* ---------- boot ---------- */

(async function init() {
  try {
    [state.meals, state.wishlist] = await Promise.all([DB.all('meals'), DB.all('wishlist')]);
    Ranking.sort();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (err) {
    console.error('Storage unavailable', err);
  }
  Fun.load();
  FX.init();
  const onScroll = () => $('#mascot').classList.toggle('small', window.scrollY > 70 && !state.sheet);
  addEventListener('scroll', onScroll, { passive: true });
  checkBadges(true);
  render();
  setTimeout(() => Mascot.say(pickOne(QUIPS.greet), 3200), 700);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
