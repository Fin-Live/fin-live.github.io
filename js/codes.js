import {
  doc, collection, getDocs, writeBatch, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
  signInWithEmailAndPassword, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { db, auth, $, show, setStatus, downloadCsv } from './common.js';
import { INSTRUCTOR_UID } from './config.js';

// No I, O, 0 or 1 -- students read these off paper and type them on a phone.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const el = {
  login: $('#login'),
  email: $('#email'),
  password: $('#password'),
  loginBtn: $('#login-btn'),
  loginStatus: $('#login-status'),
  panel: $('#panel'),
  existing: $('#existing'),
  count: $('#count'),
  generate: $('#generate'),
  status: $('#status'),
  preview: $('#preview'),
};

el.loginBtn.addEventListener('click', async () => {
  setStatus(el.loginStatus, 'Signing in…', '');
  try {
    await signInWithEmailAndPassword(auth, el.email.value.trim(), el.password.value);
  } catch (err) {
    setStatus(el.loginStatus, err.message, 'err');
  }
});

el.password.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.loginBtn.click(); });

onAuthStateChanged(auth, async (user) => {
  const ok = !!user && user.uid === INSTRUCTOR_UID;
  show(el.login, !ok);
  show(el.panel, ok);
  if (ok) await refreshExisting();
});

let existingCodes = new Set();

async function refreshExisting() {
  const snap = await getDocs(collection(db, 'roster'));
  existingCodes = new Set(snap.docs.map((d) => d.id));
  el.existing.textContent = String(existingCodes.size);
}

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  // 256 is a multiple of the 32-character alphabet, so the modulo is unbiased.
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

el.generate.addEventListener('click', async () => {
  const n = Number(el.count.value);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    setStatus(el.status, 'Enter a number between 1 and 500.', 'err');
    return;
  }

  el.generate.disabled = true;
  setStatus(el.status, 'Generating…', '');

  try {
    await refreshExisting();
    const fresh = [];
    while (fresh.length < n) {
      const code = randomCode();
      if (!existingCodes.has(code)) {
        existingCodes.add(code);
        fresh.push(code);
      }
    }

    // Firestore caps a batch at 500 writes.
    for (let i = 0; i < fresh.length; i += 450) {
      const batch = writeBatch(db);
      for (const code of fresh.slice(i, i + 450)) {
        batch.set(doc(db, 'roster', code), { createdAt: serverTimestamp() });
      }
      await batch.commit();
    }

    downloadCsv('student-codes.csv', [['code'], ...fresh.map((c) => [c])]);
    // Deliberately not listed on screen. A code visible on a projected or
    // shoulder-surfed screen is a code someone else can answer under, and the
    // CSV is the record anyway.
    el.preview.textContent = `${fresh.length} new codes are in the downloaded file.`;
    await refreshExisting();
    setStatus(el.status,
      `${fresh.length} codes created and saved. The CSV has downloaded — keep it somewhere ` +
      `safe, it is the only place the code-to-student mapping will ever exist.`, 'ok');
  } catch (err) {
    setStatus(el.status, `Failed: ${err.message}`, 'err');
  } finally {
    el.generate.disabled = false;
  }
});
