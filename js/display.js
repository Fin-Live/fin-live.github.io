// The projected view. Read-only: it never writes anything, and it takes its
// cue entirely from the `revealed` flag the cockpit sets.
//
// It reads the raw responses rather than a precomputed tally, which means it
// needs the instructor's session. Opened in the same browser as the console it
// already has one, because Firebase persists auth per origin.

import {
  doc, collection, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
  signInWithEmailAndPassword, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  db, auth, $, show, setStatus, tallyBins, wordCounts, textAnswers, MANUAL_WINDOW,
  makeClock, secondsLeft, isOpen, questionTitle,
} from './common.js';
import { INSTRUCTOR_UID } from './config.js';
import cloud from './vendor/d3-cloud.js';

const CARDS_PER_PAGE = 9;

const el = {
  login: $('#login'),
  email: $('#email'),
  password: $('#password'),
  loginBtn: $('#login-btn'),
  loginStatus: $('#login-status'),

  stage: $('#stage'),
  eyebrow: $('#eyebrow'),
  qtext: $('#qtext'),
  holding: $('#holding'),
  respondNote: $('#respond-note'),
  holdingSub: $('#holding-sub'),
  results: $('#results'),
  dhist: $('#dhist'),
  cloudWrap: $('#cloud-wrap'),
  cloud: $('#cloud'),
  cards: $('#cards'),
  cardsMore: $('#cards-more'),
  idle: $('#idle'),
  fullscreen: $('#fullscreen'),
};

const clock = makeClock();
let current = null;
let responses = [];
let unsubResponses = null;
let watching = false;

// ---------------------------------------------------------------- auth

el.loginBtn.addEventListener('click', async () => {
  setStatus(el.loginStatus, 'Signing in…', '');
  try {
    await signInWithEmailAndPassword(auth, el.email.value.trim(), el.password.value);
  } catch (err) {
    setStatus(el.loginStatus, err.message, 'err');
  }
});
el.password.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.loginBtn.click(); });

onAuthStateChanged(auth, (user) => {
  const ok = !!user && user.uid === INSTRUCTOR_UID;
  show(el.login, !ok);
  show(el.stage, ok);
  show(el.fullscreen, ok);
  if (ok && !watching) {
    watching = true;
    watchState();
  }
});

el.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

// ---------------------------------------------------------------- data

let firstStateSnapshot = true;
function watchState() {
  onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const next = snap.exists() ? snap.data() : null;
    const changed = next?.qid !== current?.qid;
    // Only sync the countdown clock to a question that opens while we watch, not
    // to a stale leftover on load -- otherwise the projector shows a phantom
    // countdown for a poll that already closed. Matches the student page.
    if (next && !firstStateSnapshot && changed && !next.closedAt) {
      clock.syncTo(next.openedAt);
    }
    firstStateSnapshot = false;
    current = next;
    if (changed) watchResponses(next?.qid);
    render();
  });
}

function watchResponses(qid) {
  unsubResponses?.();
  responses = [];
  if (!qid) return;
  unsubResponses = onSnapshot(collection(db, 'questions', qid, 'responses'), (snap) => {
    responses = snap.docs.map((d) => d.data());
    render();
  });
}

// ---------------------------------------------------------------- rendering

const plural = (n) => `${n} response${n === 1 ? '' : 's'}`;
const siteHost = () => location.host || 'fin-live.github.io';

function render() {
  // An {ended:true} doc has no qid -- treat it as "no live question" (idle).
  const live = !!current && !!current.qid;
  const open = isOpen(current, clock);
  // Multiple-choice and numeric results show once the poll closes (or on
  // reveal). Word and text answers are free-form, so they only ever show on an
  // explicit reveal -- the instructor reads them privately first and reveals to
  // the room only if they're clean.
  const autoOnClose = current && (current.type === 'choice' || current.type === 'numeric');
  const showResults = live && (!!current.revealed || (autoOnClose && !open));

  show(el.idle, !live);
  show(el.holding, live && !showResults);
  show(el.results, showResults);

  if (!live) {
    el.eyebrow.textContent = '';
    show(el.qtext, false);
    return;
  }

  // Lecture and label as a small eyebrow; the pasted question below it, kept
  // visible in both the holding and revealed states.
  el.qtext.textContent = current.text || '';
  show(el.qtext, !!current.text);

  if (showResults) {
    // Response count rides in the eyebrow, so the results stand alone below.
    el.eyebrow.textContent = [questionTitle(current), plural(responses.length)]
      .filter(Boolean).join(' · ');
    const type = current.type;
    show(el.dhist, type === 'choice' || type === 'numeric');
    show(el.cloudWrap, type === 'word');
    show(el.cards, type === 'text');
    if (type === 'word') drawCloud();
    else if (type === 'text') drawCards();
    else drawBars();
    return;
  }

  // Not showing results: nothing from the results block should linger.
  show(el.dhist, false); show(el.cloudWrap, false); show(el.cards, false); show(el.cardsMore, false);

  el.eyebrow.textContent = questionTitle(current);

  const manual = current.windowSeconds >= MANUAL_WINDOW;
  const left = secondsLeft(clock, current.openedAt, current.windowSeconds);
  if (open) {
    // How to answer, then one line — countdown (timed only) and count. The URL
    // is a coloured span, not joined by a dash, so the hyphens don't read as
    // punctuation.
    el.respondNote.textContent = 'Answer on your phone at ';
    const url = document.createElement('span');
    url.className = 'respond-url';
    url.textContent = siteHost();
    el.respondNote.append(url);
    el.holdingSub.textContent = manual
      ? plural(responses.length)
      : `${left}s left · ${plural(responses.length)}`;
  } else {
    // Closed, waiting for the instructor to reveal (word/text only reach here).
    el.respondNote.textContent = 'Answering closed';
    el.holdingSub.textContent = plural(responses.length);
  }
}

function drawBars() {
  const bins = tallyBins(current, responses);
  const max = Math.max(1, ...bins.map((b) => b.count));
  const total = responses.length;

  el.dhist.innerHTML = '';
  for (const b of bins) {
    const row = document.createElement('div');
    row.className = 'dhist-row';
    row.innerHTML =
      '<span class="dhist-key"></span>' +
      '<span class="dhist-track"><span class="dhist-fill"></span></span>' +
      '<span class="dhist-count"></span>';
    row.querySelector('.dhist-key').textContent = b.key;
    row.querySelector('.dhist-fill').style.width = `${(b.count / max) * 100}%`;
    row.querySelector('.dhist-count').textContent =
      total ? `${Math.round((b.count / total) * 100)}%` : '0%';
    el.dhist.appendChild(row);
  }
}

// ---- word cloud (packed, via vendored d3-cloud) ----------------------------

const CLOUD_W = 1280;
const CLOUD_H = 620;
let cloudSig = '';        // only re-run the layout when the words actually change
const hashText = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function drawCloud() {
  const words = wordCounts(responses).slice(0, 60);
  const sig = JSON.stringify(words);
  if (sig === cloudSig) return;   // unchanged -> keep the current layout, no flicker
  cloudSig = sig;
  if (!words.length) { el.cloud.innerHTML = ''; return; }

  const counts = words.map((w) => w.count);
  const mx = Math.max(...counts);
  const mn = Math.min(...counts);
  const sizeFor = (n, scale) => (18 + (72 - 18) * (mx === mn ? 1 : (n - mn) / (mx - mn))) * scale;

  const layout = (scale) => {
    const big = sizeFor(mx, scale) * 0.6;
    cloud()
      .size([CLOUD_W, CLOUD_H])
      .words(words.map((w) => ({ text: w.text, size: sizeFor(w.count, scale) })))
      .padding(5).font('Inter').fontWeight(700)
      // Big words stay horizontal (readable headlines); smaller ones may turn.
      .rotate((d) => (d.size >= big ? 0 : ((hashText(d.text) % 100) < 55 ? 0 : 90)))
      .fontSize((d) => d.size)
      .on('end', (placed) => {
        // Shrink and retry if any word couldn't be placed -- the top answer
        // must never be silently dropped.
        if (placed.length < words.length && scale > 0.35) { layout(scale * 0.85); return; }
        paintCloud(placed);
      })
      .start();
  };
  document.fonts.ready.then(() => layout(1));
}

function paintCloud(placed) {
  // Compute the bounding box from the word geometry (estimated), rather than
  // getBBox, which is unreliable inside the flexbox SVG. Then scale + centre so
  // the cloud fills the frame.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of placed) {
    const halfW = w.text.length * w.size * 0.30;   // ~half the text width
    const halfH = w.size * 0.62;                     // ~half the cap height
    const hx = w.rotate === 0 ? halfW : halfH;
    const hy = w.rotate === 0 ? halfH : halfW;
    minX = Math.min(minX, w.x - hx); maxX = Math.max(maxX, w.x + hx);
    minY = Math.min(minY, w.y - hy); maxY = Math.max(maxY, w.y + hy);
  }
  const bw = maxX - minX, bh = maxY - minY;
  if (!(bw > 0) || !(bh > 0)) { el.cloud.innerHTML = ''; return; }
  const pad = 30;
  const fit = Math.min((CLOUD_W - 2 * pad) / bw, (CLOUD_H - 2 * pad) / bh, 1.6);
  const tx = CLOUD_W / 2 - ((minX + maxX) / 2) * fit;
  const ty = CLOUD_H / 2 - ((minY + maxY) / 2) * fit;
  el.cloud.innerHTML =
    `<g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${fit.toFixed(3)})">`
    + placed.map((w) =>
      `<text text-anchor="middle" transform="translate(${w.x.toFixed(1)},${w.y.toFixed(1)}) rotate(${w.rotate})"`
      + ` font-size="${w.size}" font-weight="700">${esc(w.text)}</text>`).join('')
    + '</g>';
}

// ---- text answers (paged card grid) ----------------------------------------

function drawCards() {
  const all = textAnswers(responses);
  const pages = Math.max(1, Math.ceil(all.length / CARDS_PER_PAGE));
  const page = ((Number(current.page) || 0) % pages + pages) % pages; // wrap, guard NaN
  const start = page * CARDS_PER_PAGE;
  const shown = all.slice(start, start + CARDS_PER_PAGE);

  el.cards.innerHTML = '';
  for (const t of shown) {
    const d = document.createElement('div');
    d.className = 'dcard';
    d.textContent = t;
    el.cards.appendChild(d);
  }
  const showMore = pages > 1;
  if (showMore) el.cardsMore.textContent = `Showing ${start + 1}–${start + shown.length} of ${all.length}`;
  show(el.cardsMore, showMore);
}

setInterval(() => { if (current) render(); }, 500);
