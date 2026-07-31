import {
  doc, collection, collectionGroup, onSnapshot, getDocs, query, orderBy,
  writeBatch, updateDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  db, auth, MANUAL_WINDOW, $, show, setStatus, tallyBins,
  makeClock, secondsLeft, isOpen, questionTitle, downloadCsv, fmtTimestamp,
} from './common.js';
import { INSTRUCTOR_UID } from './config.js';

const el = {
  login: $('#login'),
  email: $('#email'),
  password: $('#password'),
  loginBtn: $('#login-btn'),
  loginStatus: $('#login-status'),
  console: $('#console'),
  who: $('#who'),
  signOut: $('#sign-out'),

  lecture: $('#lecture'),
  label: $('#label'),
  questionText: $('#question-text'),
  type: $('#type'),
  numOptions: $('#num-options'),
  numOptionsWrap: $('#num-options-wrap'),
  window: $('#window'),
  launch: $('#launch'),
  launchStatus: $('#launch-status'),

  live: $('#live'),
  liveTitle: $('#live-title'),
  liveQtext: $('#live-qtext'),
  countdown: $('#countdown'),
  closeNow: $('#close-now'),
  reveal: $('#reveal'),
  revealState: $('#reveal-state'),
  total: $('#total'),
  identified: $('#identified'),
  hist: $('#hist'),

  feed: $('#feed'),
  exportBtn: $('#export'),
  exportQuestions: $('#export-questions'),
  exportAnswers: $('#export-answers'),
  exportAsks: $('#export-asks'),
  exportStatus: $('#export-status'),
};

const clock = makeClock();
let current = null;
let unsubResponses = null;
let responses = [];
let watching = false; // auth state can fire more than once; only subscribe once

// ---------------------------------------------------------------- auth

el.loginBtn.addEventListener('click', async () => {
  el.loginBtn.disabled = true;
  setStatus(el.loginStatus, 'Signing in…', '');
  try {
    await signInWithEmailAndPassword(auth, el.email.value.trim(), el.password.value);
  } catch (err) {
    setStatus(el.loginStatus, err.message, 'err');
  } finally {
    el.loginBtn.disabled = false;
  }
});

el.password.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.loginBtn.click(); });
el.signOut.addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  const ok = !!user && user.uid === INSTRUCTOR_UID;
  show(el.login, !ok);
  show(el.console, ok);

  // Anyone who has opened the student page carries an anonymous session for
  // this origin, so landing here signed-in-but-not-the-instructor is the normal
  // case for a student, not an error. Show them a plain sign-in form.
  if (user && !ok && !user.isAnonymous) {
    setStatus(el.loginStatus, 'That account does not have access to this console.', 'err');
    // The UID is what you need during setup, but it is setup detail rather than
    // something to print on a page students can reach.
    console.info(`Signed in as ${user.email || user.uid} (UID ${user.uid}), ` +
      `which is not INSTRUCTOR_UID.`);
    return;
  }
  if (user && !ok) {
    setStatus(el.loginStatus, '', '');
    return;
  }
  if (ok && !watching) {
    watching = true;
    el.who.textContent = user.email || user.uid;
    setStatus(el.loginStatus, '', '');
    watchState();
    watchAsked();
  }
});

// ---------------------------------------------------------------- launching

el.type.addEventListener('change', () => {
  show(el.numOptionsWrap, el.type.value === 'choice');
});

el.launch.addEventListener('click', async () => {
  const lecture = el.lecture.value.trim();
  const label = el.label.value.trim();
  if (!lecture && !label) {
    setStatus(el.launchStatus, 'Give the question a lecture or a label so you can find it later.', 'err');
    return;
  }

  el.launch.disabled = true;
  setStatus(el.launchStatus, 'Opening…', '');

  const qRef = doc(collection(db, 'questions'));
  const payload = {
    lecture,
    label,
    // Trimmed at the ends but internal line breaks kept, so a pasted
    // multiple-choice prompt shows on the projector exactly as laid out.
    text: el.questionText.value.trim(),
    type: el.type.value,
    numOptions: el.type.value === 'choice' ? Number(el.numOptions.value) : null,
    windowSeconds: Number(el.window.value),
    openedAt: serverTimestamp(),
  };

  try {
    // Both documents get the same commit timestamp. /questions/{id} is what
    // the rules read when deciding if an answer is late; /state/current is
    // only what the students' screens follow.
    const batch = writeBatch(db);
    batch.set(qRef, payload);
    batch.set(doc(db, 'state', 'current'), { qid: qRef.id, ...payload });
    await batch.commit();
    setStatus(el.launchStatus, 'Open.', 'ok');
    bumpLabel();
  } catch (err) {
    setStatus(el.launchStatus, `Could not open: ${err.message}`, 'err');
  } finally {
    el.launch.disabled = false;
  }
});

// "Q1" -> "Q2", so re-asking is one click. Anything else is left alone.
function bumpLabel() {
  const m = el.label.value.trim().match(/^(.*?)(\d+)\s*:?\s*$/);
  if (m) el.label.value = `${m[1]}${Number(m[2]) + 1}`;
}

el.closeNow.addEventListener('click', async () => {
  if (!current?.qid) return;
  el.closeNow.disabled = true;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'questions', current.qid), { closedAt: serverTimestamp() });
    batch.update(doc(db, 'state', 'current'), { closedAt: serverTimestamp() });
    await batch.commit();
  } catch (err) {
    setStatus(el.launchStatus, `Could not close: ${err.message}`, 'err');
  } finally {
    el.closeNow.disabled = false;
  }
});

// Reveals the histogram to the room while the poll is still open (for peer
// instruction). It shows on its own once the poll closes, so this is only for
// showing it early. Reset on every launch so a reveal never leaks to the next
// question -- a live tally the room can watch pulls late answers toward the
// leading bar.
el.reveal.addEventListener('click', async () => {
  if (!current?.qid) return;
  el.reveal.disabled = true;
  try {
    await updateDoc(doc(db, 'state', 'current'), { revealed: !current.revealed });
  } catch (err) {
    setStatus(el.launchStatus, `Could not change the projector: ${err.message}`, 'err');
  } finally {
    el.reveal.disabled = false;
  }
});

// ---------------------------------------------------------------- live view

let firstStateSnapshot = true;
function watchState() {
  onSnapshot(doc(db, 'state', 'current'), (snap) => {
    const next = snap.exists() ? snap.data() : null;
    const changed = next?.qid !== current?.qid;
    // Sync the countdown clock only to a question that opens while we're
    // watching -- i.e. one we just launched. The first snapshot after login is
    // the leftover last question; syncing to its old openedAt would reset the
    // timer to a full window and show a phantom countdown for a poll that
    // closed long ago.
    if (next && !firstStateSnapshot && changed && !next.closedAt) {
      clock.syncTo(next.openedAt);
    }
    firstStateSnapshot = false;
    current = next;
    if (changed) watchResponses(next?.qid);
    renderLive();
  });
}

function watchResponses(qid) {
  unsubResponses?.();
  responses = [];
  if (!qid) return;
  unsubResponses = onSnapshot(collection(db, 'questions', qid, 'responses'), (snap) => {
    responses = snap.docs.map((d) => d.data());
    renderLive();
  });
}

function renderLive() {
  show(el.live, !!current);
  if (!current) return;

  const open = isOpen(current, clock);
  el.liveTitle.textContent = questionTitle(current) || '(untitled)';
  el.liveQtext.textContent = current.text || '';
  show(el.liveQtext, !!current.text);
  el.closeNow.disabled = !open;

  // The room sees the histogram once the poll closes, or early if you reveal it.
  // The question prompt is always on the projector; this only controls the bars.
  const roomSeesHistogram = current.revealed || !open;
  el.reveal.textContent = current.revealed ? 'Hide histogram from room' : 'Reveal histogram to room';
  el.reveal.disabled = !open; // once closed, the histogram shows on its own
  el.revealState.textContent = !open
    ? 'Poll closed — the room can see the histogram.'
    : current.revealed
      ? 'The room can see the histogram.'
      : 'Room sees the prompt and a response count. Close the poll (or reveal) to show the histogram.';
  el.revealState.className = roomSeesHistogram ? 'muted revealed' : 'muted';
  el.total.textContent = String(responses.length);
  el.identified.textContent = String(responses.filter((r) => r.studentCode).length);

  const left = current.closedAt ? 0 : secondsLeft(clock, current.openedAt, current.windowSeconds);
  if (!open) {
    el.countdown.textContent = 'closed';
    el.countdown.classList.remove('low');
  } else if (current.windowSeconds >= MANUAL_WINDOW) {
    el.countdown.textContent = 'open';
    el.countdown.classList.remove('low');
  } else {
    el.countdown.textContent = `${left}s`;
    el.countdown.classList.toggle('low', left <= 5);
  }

  drawHistogram();
}

setInterval(() => { if (current) renderLive(); }, 500);

function drawHistogram() {
  const bins = tallyBins(current, responses);
  const max = Math.max(1, ...bins.map((b) => b.count));
  el.hist.innerHTML = '';
  for (const b of bins) {
    const row = document.createElement('div');
    row.className = 'hist-row';
    row.innerHTML =
      `<span class="hist-key"></span>` +
      `<span class="hist-track"><span class="hist-fill"></span></span>` +
      `<span class="hist-count"></span>`;
    row.querySelector('.hist-key').textContent = b.key;
    row.querySelector('.hist-fill').style.width = `${(b.count / max) * 100}%`;
    const pct = responses.length ? Math.round((b.count / responses.length) * 100) : 0;
    row.querySelector('.hist-count').textContent = `${b.count} (${pct}%)`;
    el.hist.appendChild(row);
  }
}

// ------------------------------------------------------ student questions

// Never returns a code. This string goes on screen, and the console is one
// mis-click away from being projected -- a code on the wall is a code anyone in
// the room can then answer under. The code stays in the exports, where it
// belongs, and in the database.
function askedBy(q) {
  if (!q.studentCode) return 'anonymous';
  return q.firstName || 'no name given';
}

function watchAsked() {
  onSnapshot(query(collection(db, 'asked'), orderBy('createdAt', 'desc')), (snap) => {
    el.feed.innerHTML = '';
    if (snap.empty) {
      el.feed.innerHTML = '<p class="muted">No questions yet.</p>';
      return;
    }
    for (const d of snap.docs) {
      const q = d.data();
      const item = document.createElement('div');
      item.className = 'feed-item';

      const p = document.createElement('p');
      const who = document.createElement('strong');
      who.textContent = `${askedBy(q)}: `;
      if (!q.studentCode) who.className = 'anon';
      p.append(who, document.createTextNode(q.text));

      // Lecture and time only. No code -- see askedBy above.
      const meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = [q.lecture,
        q.createdAt?.toDate ? q.createdAt.toDate().toLocaleTimeString() : '']
        .filter(Boolean).join(' · ');

      item.append(p, meta);
      el.feed.appendChild(item);
    }
  });
}

// ---------------------------------------------------------------- export

// Nothing here is ever deleted, so every export is the complete record to date.
// Firestore is the persistent store; these buttons just take a snapshot of it.

async function fetchResponses() {
  // Each response carries its lecture and label, so the whole semester comes
  // back in one collection-group query rather than one query per question.
  const snap = await getDocs(collectionGroup(db, 'responses'));
  return snap.docs.map((d) => d.data());
}

async function fetchAsked() {
  const snap = await getDocs(collection(db, 'asked'));
  return snap.docs.map((d) => d.data());
}

function runExport(btn, statusEl, job) {
  btn.disabled = true;
  setStatus(statusEl, 'Collecting…', '');
  job()
    .then((msg) => setStatus(statusEl, msg, 'ok'))
    .catch((err) => setStatus(statusEl, `Export failed: ${err.message}`, 'err'))
    .finally(() => { btn.disabled = false; });
}

el.exportBtn.addEventListener('click', () => runExport(el.exportBtn, el.exportStatus, async () => {
  const rows = (await fetchResponses()).map((r) => ({
    code: r.studentCode || '',
    lecture: r.lecture || '',
    label: r.label || '',
    answer: r.answer,
    at: fmtTimestamp(r.submittedAt),
    qid: r.qid || '',
  }));
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.code.localeCompare(b.code));

  downloadCsv('responses.csv', [
    ['student_code', 'lecture', 'question', 'answer', 'submitted_at_utc', 'question_id'],
    ...rows.map((r) => [r.code, r.lecture, r.label, r.answer, r.at, r.qid]),
  ]);

  const anon = rows.filter((r) => !r.code).length;
  return `${rows.length} responses exported (${anon} anonymous, which carry no code).`;
}));

el.exportQuestions.addEventListener('click', () =>
  runExport(el.exportQuestions, el.exportStatus, async () => {
    const rows = (await fetchAsked()).map((q) => ({
      at: fmtTimestamp(q.createdAt),
      lecture: q.lecture || '',
      name: q.firstName || '',
      code: q.studentCode || '',
      anon: q.studentCode ? 'no' : 'yes',
      text: q.text || '',
    }));
    rows.sort((a, b) => a.at.localeCompare(b.at));

    downloadCsv('questions.csv', [
      ['asked_at_utc', 'lecture', 'first_name', 'student_code', 'anonymous', 'question'],
      ...rows.map((r) => [r.at, r.lecture, r.name, r.code, r.anon, r.text]),
    ]);

    const named = rows.filter((r) => r.anon === 'no').length;
    return `${rows.length} questions exported (${named} named, ${rows.length - named} anonymous).`;
  }));

// "Lecture 2" must sort before "Lecture 10", which a plain string compare gets
// backwards once you pass nine lectures.
const byLecture = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// One row per student, one column per lecture, each cell a count. Anonymous
// activity is absent by construction: it cannot be attributed to anyone, which
// is the whole point of offering it.
function pivot(items, names) {
  const lectures = new Set();
  const counts = new Map(); // code -> Map(lecture -> n)

  for (const it of items) {
    if (!it.code) continue;
    const lecture = it.lecture || '(no lecture)';
    lectures.add(lecture);
    const row = counts.get(it.code) || new Map();
    row.set(lecture, (row.get(lecture) || 0) + 1);
    counts.set(it.code, row);
  }

  const cols = [...lectures].sort(byLecture);
  const codes = [...counts.keys()].sort();
  return [
    ['student_code', 'first_name', ...cols, 'total'],
    ...codes.map((code) => {
      const row = counts.get(code);
      const cells = cols.map((c) => row.get(c) || 0);
      const total = cells.reduce((a, b) => a + b, 0);
      return [code, names.get(code) || '', ...cells, total];
    }),
  ];
}

// Names only ever reach the database attached to a question, so a student who
// has answered but never asked shows a blank here. Your own codes CSV is the
// authoritative mapping; this column is a convenience.
//
// A student can change what they call themselves mid-semester, so sort by time
// and let the newest win. Without the sort this reads whatever order Firestore
// returned -- document ID, which is random -- and the name would vary between
// two exports of identical data.
function nameIndex(asked) {
  const names = new Map();
  const chronological = [...asked].sort(
    (a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
  for (const q of chronological) {
    if (q.studentCode && q.firstName) names.set(q.studentCode, q.firstName);
  }
  return names;
}

el.exportAnswers.addEventListener('click', () =>
  runExport(el.exportAnswers, el.exportStatus, async () => {
    const [responses, asked] = await Promise.all([fetchResponses(), fetchAsked()]);
    const rows = pivot(
      responses.map((r) => ({ code: r.studentCode, lecture: r.lecture })),
      nameIndex(asked),
    );
    downloadCsv('participation-answers.csv', rows);
    return `${rows.length - 1} students × ${rows[0].length - 3} lectures. ` +
      `Anonymous answers are excluded — they can't be attributed.`;
  }));

el.exportAsks.addEventListener('click', () =>
  runExport(el.exportAsks, el.exportStatus, async () => {
    const asked = await fetchAsked();
    const rows = pivot(
      asked.map((q) => ({ code: q.studentCode, lecture: q.lecture })),
      nameIndex(asked),
    );
    downloadCsv('participation-questions.csv', rows);
    return `${rows.length - 1} students × ${rows[0].length - 3} lectures. ` +
      `Anonymous questions are excluded — they can't be attributed.`;
  }));
