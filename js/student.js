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
  avatar: $('#identity-avatar'),
  change: $('#identity-change'),
  timebar: $('#timebar'),
  timebarFill: $('#timebar-fill'),
  edit: $('#identity-edit'),
  save: $('#identity-save'),
  code: $('#code'),
  name: $('#name'),
  anon: $('#anon'),

  idle: $('#idle'),
  idleTitle: $('#idle-title'),
  idleSub: $('#idle-sub'),
  question: $('#question'),
  title: $('#q-title'),
  countdown: $('#countdown'),
  timingNote: $('#timing-note'),
  choices: $('#choices'),
  numeric: $('#numeric'),
  numericValue: $('#numeric-value'),
  numericSubmit: $('#numeric-submit'),
  word: $('#word'),
  wordValue: $('#word-value'),
  wordSubmit: $('#word-submit'),
  text: $('#text'),
  textValue: $('#text-value'),
  textSubmit: $('#text-submit'),
  answerStatus: $('#answer-status'),

  confirm: $('#confirm'),
  confirmAnswer: $('#confirm-answer'),

  askSection: $('#ask-section'),
  askToggle: $('#ask-toggle'),
  askSent: $('#ask-sent'),
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
    el.avatar.textContent = who.anonymous
      ? '·'
      : (firstName()[0] || who.code[0] || '?').toUpperCase();
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
  // A real question has a qid. The instructor's "End lecture" writes an
  // {ended:true} doc with no qid, which reads here as "no lecture".
  const hasQ = !!current && !!current.qid;
  const open = hasQ && isOpen(current, clock);
  const mine = hasQ ? answered.get(current.qid) : undefined;
  const ready = !!identity();
  const done = mine !== undefined;
  const manual = hasQ && current.windowSeconds >= MANUAL_WINDOW;
  const answering = hasQ && open && !done;
  const showConfirm = hasQ && done;   // the recorded check, only for a live question
  const showIdle = !answering && !showConfirm;

  // A lecture is "in session" once the instructor starts it or launches a
  // question, and until they end it (a closed question still counts). Only then
  // can students ask an in-lecture question.
  const inSession = !!current && (current.started === true || hasQ);

  show(el.question, answering);
  show(el.confirm, showConfirm);
  show(el.timebar, answering && !manual);
  show(el.idle, showIdle);
  show(el.askSection, inSession);
  if (!inSession) showAskForm(false);

  if (showIdle) {
    if (inSession) {
      // In lecture, between questions -- the message the instructor likes.
      el.idleTitle.textContent = 'No question right now';
      el.idleSub.textContent = 'Put your phone down — this page keeps itself up to date.';
    } else {
      // Outside lecture: no instruction about phones, and questions go elsewhere.
      el.idleTitle.textContent = 'No lecture in session';
      el.idleSub.textContent = 'Questions outside class go through the Blackboard course site.';
    }
    return;
  }

  if (showConfirm) {
    el.confirmAnswer.textContent = open
      ? `Your answer · ${mine}`
      : `Your answer · ${mine} — poll closed`;
    return;
  }

  // answering
  el.title.textContent = questionTitle(current);
  // A "stays open until I close it" question has no meaningful countdown --
  // show a note instead of a five-figure second count ticking down.
  show(el.countdown, !manual);
  show(el.timingNote, manual);

  const type = current.type;
  show(el.choices, type === 'choice');
  show(el.numeric, type === 'numeric');
  show(el.word, type === 'word');
  show(el.text, type === 'text');

  if (type === 'choice') {
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
  } else if (type === 'numeric') {
    el.numericValue.disabled = !ready;
    el.numericSubmit.disabled = !ready;
  } else if (type === 'word') {
    el.wordValue.disabled = !ready;
    el.wordSubmit.disabled = !ready;
  } else {
    el.textValue.disabled = !ready;
    el.textSubmit.disabled = !ready;
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
  el.timebarFill.style.width = `${Math.max(0, Math.min(100, (left / current.windowSeconds) * 100))}%`;
  if (left === 0) render();
}

// ---------------------------------------------------------------- answering

async function submitAnswer(rawAnswer) {
  const who = identity();
  if (!who || !current) return;

  let answer;
  if (current.type === 'numeric') {
    answer = Number(rawAnswer);
    if (!Number.isFinite(answer)) {
      setStatus(el.answerStatus, 'Enter a number.', 'err');
      return;
    }
  } else if (current.type === 'word' || current.type === 'text') {
    answer = String(rawAnswer).trim();
    if (!answer) {
      setStatus(el.answerStatus, 'Type an answer first.', 'err');
      return;
    }
  } else {
    answer = rawAnswer;  // multiple-choice letter
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
    el.wordValue.value = '';
    el.textValue.value = '';
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
el.wordSubmit.addEventListener('click', () => submitAnswer(el.wordValue.value));
el.wordValue.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAnswer(el.wordValue.value);
});
el.textSubmit.addEventListener('click', () => submitAnswer(el.textValue.value));
el.textValue.addEventListener('keydown', (e) => {
  // Enter makes a newline in a sentence; Cmd/Ctrl+Enter sends.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAnswer(el.textValue.value);
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
let askSentTimer = 0;
el.askToggle.addEventListener('click', () => { show(el.askSent, false); showAskForm(true); });
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
    setStatus(el.askStatus, '', '');
    showAskForm(false);
    // Confirmation shown outside the (now-collapsed) form, so it's actually
    // visible. Auto-clears after a few seconds.
    show(el.askSent, true);
    clearTimeout(askSentTimer);
    askSentTimer = setTimeout(() => show(el.askSent, false), 5000);
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
