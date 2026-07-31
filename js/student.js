// The student page. Its design constraint is attention, not features: a
// student should be able to answer in one tap, from a phone, without reading
// anything on screen, and have no reason to keep looking at it afterwards.

import {
  doc, onSnapshot, writeBatch, serverTimestamp, collection,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
  db, CHOICES, MANUAL_WINDOW, $, show, setStatus, signInStudent,
  makeClock, secondsLeft, isOpen, questionTitle,
} from './common.js';

const CODE_KEY = 'lq.studentCode';
const NAME_KEY = 'lq.firstName';
const ANON_KEY = 'lq.anonymous';
const ANSWERS_KEY = 'lq.answers';

// qid -> answer. Kept locally so a reload mid-lecture still shows what you
// chose; students are never allowed to read the response collection back.
const answered = new Map(Object.entries(
  JSON.parse(localStorage.getItem(ANSWERS_KEY) || '{}'),
));

function remember(qid, answer) {
  answered.set(qid, answer);
  // Only the last handful matter, and this keeps localStorage from growing
  // all semester.
  const recent = [...answered.entries()].slice(-20);
  answered.clear();
  recent.forEach(([k, v]) => answered.set(k, v));
  localStorage.setItem(ANSWERS_KEY, JSON.stringify(Object.fromEntries(recent)));
}

const el = {
  summary: $('#identity-summary'),
  summaryText: $('#identity-text'),
  change: $('#identity-change'),
  edit: $('#identity-edit'),
  save: $('#identity-save'),
  code: $('#code'),
  name: $('#name'),
  anon: $('#anon'),

  idle: $('#idle'),
  question: $('#question'),
  title: $('#q-title'),
  countdown: $('#countdown'),
  timingNote: $('#timing-note'),
  choices: $('#choices'),
  numeric: $('#numeric'),
  numericValue: $('#numeric-value'),
  numericSubmit: $('#numeric-submit'),
  answerStatus: $('#answer-status'),

  confirm: $('#confirm'),
  confirmAnswer: $('#confirm-answer'),

  askSection: $('#ask-section'),
  askToggle: $('#ask-toggle'),
  askForm: $('#ask-form'),
  askText: $('#ask-text'),
  askName: $('#ask-name'),
  askNameWrap: $('#ask-name-wrap'),
  askAnon: $('#ask-anon'),
  askAs: $('#ask-as'),
  askSubmit: $('#ask-submit'),
  askCancel: $('#ask-cancel'),
  askStatus: $('#ask-status'),
};

const clock = makeClock();
let uid = null;
let current = null;
let seenQid = null;
let firstSnapshot = true;
let editingIdentity = false;

// ---------------------------------------------------------------- identity

el.code.value = localStorage.getItem(CODE_KEY) || '';
el.name.value = localStorage.getItem(NAME_KEY) || '';
el.anon.checked = localStorage.getItem(ANON_KEY) === '1';

const normalizeCode = (raw) => raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const firstName = () => el.name.value.trim().slice(0, 40);

function identity() {
  if (el.anon.checked) return { anonymous: true, code: null, key: `anon_${uid}` };
  const code = normalizeCode(el.code.value);
  if (!code) return null;
  return { anonymous: false, code, key: `id_${code}` };
}

function renderIdentity() {
  const who = identity();
  // Collapse as soon as there is something to collapse to. One saved line
  // instead of a form keeps the answer buttons on the first screen.
  const collapsed = !!who && !editingIdentity;
  show(el.summary, collapsed);
  show(el.edit, !collapsed);
  if (collapsed) {
    el.summaryText.textContent = who.anonymous
      ? 'Answering anonymously'
      : [firstName(), `Code ${who.code}`].filter(Boolean).join(' · ');
  }
}

el.code.addEventListener('input', () => {
  el.code.value = normalizeCode(el.code.value);
});

function saveIdentity() {
  localStorage.setItem(CODE_KEY, normalizeCode(el.code.value));
  localStorage.setItem(NAME_KEY, firstName());
  localStorage.setItem(ANON_KEY, el.anon.checked ? '1' : '0');
  editingIdentity = false;
  renderIdentity();
  render();
}

el.save.addEventListener('click', saveIdentity);
el.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveIdentity(); });
el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveIdentity(); });
el.anon.addEventListener('change', () => { el.code.disabled = el.anon.checked; });
el.change.addEventListener('click', () => {
  editingIdentity = true;
  renderIdentity();
  render();
});

// ---------------------------------------------------------------- rendering

function render() {
  const open = isOpen(current, clock);
  const mine = current ? answered.get(current.qid) : undefined;
  const ready = !!identity();
  const done = mine !== undefined;

  // Between questions, and after you have answered, the page holds nothing
  // worth looking at. That is the whole point.
  show(el.idle, !current || (!open && !done));
  show(el.question, !!current && open && !done);
  show(el.confirm, !!current && done);

  if (!current) return;

  el.title.textContent = questionTitle(current);

  if (done) {
    el.confirmAnswer.textContent = open
      ? `Your answer: ${mine}`
      : `Your answer: ${mine} — poll closed`;
    return;
  }
  if (!open) return;

  // A "stays open until I close it" question has no meaningful countdown --
  // show a note instead of a five-figure second count ticking down.
  const manual = current.windowSeconds >= MANUAL_WINDOW;
  show(el.countdown, !manual);
  show(el.timingNote, manual);

  if (current.type === 'choice') {
    show(el.choices, true);
    show(el.numeric, false);
    if (el.choices.dataset.qid !== current.qid) {
      el.choices.dataset.qid = current.qid;
      el.choices.innerHTML = '';
      for (const c of CHOICES.slice(0, current.numOptions || 4)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c;
        b.addEventListener('click', () => submitAnswer(c));
        el.choices.appendChild(b);
      }
    }
    for (const b of el.choices.children) b.disabled = !ready;
  } else {
    show(el.choices, false);
    show(el.numeric, true);
    el.numericValue.disabled = !ready;
    el.numericSubmit.disabled = !ready;
  }

  setStatus(el.answerStatus,
    ready ? '' : 'Enter your code above to answer.',
    ready ? '' : 'warn');
}

function tick() {
  if (!current || current.closedAt) { render(); return; }
  if (current.windowSeconds >= MANUAL_WINDOW) return; // no numeric countdown
  const left = secondsLeft(clock, current.openedAt, current.windowSeconds);
  if (left === null) return;
  el.countdown.textContent = `${left}s`;
  el.countdown.classList.toggle('low', left <= 5);
  if (left === 0) render();
}

// ---------------------------------------------------------------- answering

async function submitAnswer(rawAnswer) {
  const who = identity();
  if (!who || !current) return;

  const answer = current.type === 'numeric' ? Number(rawAnswer) : rawAnswer;
  if (current.type === 'numeric' && !Number.isFinite(answer)) {
    setStatus(el.answerStatus, 'Enter a number.', 'err');
    return;
  }

  setStatus(el.answerStatus, 'Sending…', '');
  const qid = current.qid;
  const batch = writeBatch(db);
  batch.set(doc(db, 'questions', qid, 'responses', who.key), {
    qid,
    lecture: current.lecture || '',
    label: current.label || '',
    answer,
    studentCode: who.code,
    deviceUid: uid,
    submittedAt: serverTimestamp(),
  });
  // Pins this device to one response key for this question. Written in the
  // same batch so the pair either both land or neither does.
  batch.set(doc(db, 'questions', qid, 'devices', uid), { responseKey: who.key });

  try {
    await batch.commit();
    remember(qid, answer);
    el.numericValue.value = '';
    setStatus(el.answerStatus, '', '');
    render();
  } catch (err) {
    setStatus(el.answerStatus, explain(err, who), 'err');
  }
}

// Everything the rules reject arrives as the same permission-denied error, so
// we have to infer which check failed. Ordered most-likely-first.
function explain(err, who) {
  if (err?.code !== 'permission-denied') return `Could not send: ${err?.message || err}`;
  if (!isOpen(current, clock)) return 'Too late — the poll closed before this reached the server.';
  // One answer per device per question. If this device already answered (which
  // we recorded locally), a second attempt under a different identity -- code
  // vs anonymous, or a different code -- is what got rejected, not the code.
  if (current && answered.has(current.qid)) {
    return 'This device already answered this question. You can change your answer, '
      + 'but you can’t switch between a code and anonymous on the same question.';
  }
  if (!who.anonymous) return `Code "${who.code}" wasn’t accepted. Check it with Change, or ask your instructor.`;
  return 'This device has already answered this question.';
}

el.numericSubmit.addEventListener('click', () => submitAnswer(el.numericValue.value));
el.numericValue.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAnswer(el.numericValue.value);
});

// ------------------------------------------------------- asking a question

// Kept behind a tap so the default state of the page is not an open text box
// inviting someone to start typing.
function showAskForm(on) {
  show(el.askForm, on);
  show(el.askToggle, !on);
  if (on) { renderAskAs(); el.askText.focus(); }
}

// The name to send: whatever was saved in the identity bar, or whatever they
// type into the prompt that appears when nothing was saved.
const askName = () => (firstName() || el.askName.value.trim()).slice(0, 40);

// Who this question will arrive as. Stated plainly, because "will my name be on
// this" is the thing a student hesitating over the send button wants to know.
function renderAskAs() {
  const who = askIdentity();
  show(el.askNameWrap, !who.anonymous && !firstName());
  el.askAs.textContent = who.anonymous
    ? 'This will show as "anonymous".'
    : `This will show as "${who.firstName || who.code}", and count toward your participation.`;
}

// Falls back to anonymous when there is no code to attribute it to, so a
// student answering anonymously cannot accidentally send a named question.
function askIdentity() {
  const who = identity();
  if (el.askAnon.checked || !who || who.anonymous) {
    return { anonymous: true, code: null, firstName: null };
  }
  return { anonymous: false, code: who.code, firstName: askName() || null };
}

el.askAnon.addEventListener('change', renderAskAs);
el.askName.addEventListener('input', renderAskAs);
el.askToggle.addEventListener('click', () => showAskForm(true));
el.askCancel.addEventListener('click', () => {
  el.askText.value = '';
  setStatus(el.askStatus, '', '');
  showAskForm(false);
});

el.askSubmit.addEventListener('click', async () => {
  const text = el.askText.value.trim();
  if (!text) return;
  el.askSubmit.disabled = true;
  setStatus(el.askStatus, 'Sending…', '');
  try {
    const who = askIdentity();
    const batch = writeBatch(db);
    batch.set(doc(collection(db, 'asked')), {
      text,
      lecture: current?.lecture || '',
      studentCode: who.code,
      firstName: who.firstName,
      deviceUid: uid,
      createdAt: serverTimestamp(),
    });
    await batch.commit();

    // Remember a name typed here, so it is only ever asked for once.
    if (!firstName() && who.firstName) {
      el.name.value = who.firstName;
      localStorage.setItem(NAME_KEY, who.firstName);
      el.askName.value = '';
      renderIdentity();
    }

    el.askText.value = '';
    showAskForm(false);
    setStatus(el.askStatus, 'Sent to the instructor.', 'ok');
    setTimeout(() => setStatus(el.askStatus, '', ''), 4000);
  } catch (err) {
    setStatus(el.askStatus, `Could not send: ${err.message}`, 'err');
  } finally {
    el.askSubmit.disabled = false;
  }
});

// ---------------------------------------------------------------- start up

(async function start() {
  try {
    uid = (await signInStudent()).uid;
  } catch (err) {
    setStatus(el.answerStatus, `Cannot reach the server: ${err.message}`, 'err');
    return;
  }

  el.code.disabled = el.anon.checked;
  renderIdentity();
  setInterval(tick, 250);

  onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const next = snap.exists() ? snap.data() : null;
    const isNew = !!next && !firstSnapshot && next.qid !== seenQid && !next.closedAt;

    // Only trust the clock offset if we watched this question open: the
    // snapshot then lands within a moment of openedAt, so the difference is a
    // fair measure of local clock error. The first snapshot after a page load
    // may be a question opened minutes ago, which would measure nothing.
    if (isNew) {
      clock.syncTo(next.openedAt);
      // Lets a student keep the phone face down and look up until it buzzes.
      // Android honours this; iOS Safari ignores it, and a locked phone will
      // not fire it at all, so it is a bonus rather than the mechanism.
      navigator.vibrate?.([120, 60, 120]);
      showAskForm(false);
    }

    firstSnapshot = false;
    seenQid = next?.qid ?? null;
    current = next;
    render();
    tick();
  }, (err) => {
    setStatus(el.answerStatus, `Lost connection: ${err.message}`, 'err');
  });
})();
