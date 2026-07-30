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
  db, auth, $, show, setStatus, tallyBins, MANUAL_WINDOW,
  makeClock, secondsLeft, isOpen, questionTitle,
} from './common.js';
import { INSTRUCTOR_UID } from './config.js';

const el = {
  login: $('#login'),
  email: $('#email'),
  password: $('#password'),
  loginBtn: $('#login-btn'),
  loginStatus: $('#login-status'),

  stage: $('#stage'),
  title: $('#title'),
  meta: $('#meta'),
  holding: $('#holding'),
  holdingCount: $('#holding-count'),
  results: $('#results'),
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

function watchState() {
  onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const next = snap.exists() ? snap.data() : null;
    const changed = next?.qid !== current?.qid;
    current = next;
    if (next?.openedAt) clock.syncTo(next.openedAt);
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

function render() {
  const live = !!current;
  const revealed = !!current?.revealed;

  show(el.idle, !live);
  show(el.holding, live && !revealed);
  show(el.results, live && revealed);

  if (!live) {
    el.title.textContent = '';
    el.meta.textContent = '';
    return;
  }

  el.title.textContent = questionTitle(current);

  if (revealed) {
    // A countdown next to the results is noise: by the time the room is
    // reading bars, how long is left has stopped mattering. The total is what
    // the percentages are out of, so it earns the space instead.
    el.meta.textContent = `${responses.length} response${responses.length === 1 ? '' : 's'}`;
    el.meta.classList.remove('low');
    drawBars();
    return;
  }

  const open = isOpen(current, clock);
  const left = open ? secondsLeft(clock, current.openedAt, current.windowSeconds) : 0;
  el.meta.textContent = !open ? 'closed'
    : (current.windowSeconds >= MANUAL_WINDOW ? 'open' : `${left}s`);
  el.meta.classList.toggle('low', open && left !== null && left <= 5);
  el.holdingCount.textContent = String(responses.length);
}

function drawBars() {
  const bins = tallyBins(current, responses);
  const max = Math.max(1, ...bins.map((b) => b.count));
  const total = responses.length;

  el.results.innerHTML = '';
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
    el.results.appendChild(row);
  }
}

setInterval(() => { if (current) render(); }, 500);
