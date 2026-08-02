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
  eyebrow: $('#eyebrow'),
  qtext: $('#qtext'),
  holding: $('#holding'),
  respondNote: $('#respond-note'),
  holdingSub: $('#holding-sub'),
  results: $('#results'),
  dhist: $('#dhist'),
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
  // The histogram shows once the poll closes, or early if the instructor reveals
  // it (peer instruction). While open and unrevealed the room sees only the
  // prompt and a count, so a running tally can't pull late answers to the lead.
  const showResults = live && (!open || !!current.revealed);

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
    // Response count rides in the eyebrow, so the bars stand alone below.
    el.eyebrow.textContent = [questionTitle(current), plural(responses.length)]
      .filter(Boolean).join(' · ');
    drawBars();
    return;
  }

  el.eyebrow.textContent = questionTitle(current);

  // Holding: how to answer, then one line — countdown (timed only) and count.
  // The URL is a coloured span, not joined by a dash, so the hyphens in the
  // address don't read as punctuation.
  el.respondNote.textContent = 'Answer on your phone at ';
  const url = document.createElement('span');
  url.className = 'respond-url';
  url.textContent = siteHost();
  el.respondNote.append(url);
  const manual = current.windowSeconds >= MANUAL_WINDOW;
  const left = secondsLeft(clock, current.openedAt, current.windowSeconds);
  el.holdingSub.textContent = manual
    ? plural(responses.length)
    : `${left}s left · ${plural(responses.length)}`;
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

setInterval(() => { if (current) render(); }, 500);
