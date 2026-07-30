// Shared Firebase setup and small helpers. The SDK version appears here and in
// the three page modules; bump all four together if you ever want to update it.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  initializeAppCheck, ReCaptchaV3Provider,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig, RECAPTCHA_SITE_KEY } from './config.js';

export const app = initializeApp(firebaseConfig);

// App Check attests that a request came from this actual web page, via an
// invisible reCAPTCHA. It must run before getFirestore/getAuth so every call
// carries a token. With no key configured it's skipped, so the app keeps
// working while App Check is being set up -- and the switch that actually
// rejects unattested traffic is Enforcement, flipped in the console once
// verified requests are showing up.
if (RECAPTCHA_SITE_KEY) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

export const db = getFirestore(app);
export const auth = getAuth(app);

export const CHOICES = ['A', 'B', 'C', 'D', 'E'];

// Sentinel window for questions you intend to close by hand.
export const MANUAL_WINDOW = 86400;

export const $ = (sel, root = document) => root.querySelector(sel);
export const show = (el, on = true) => { el.hidden = !on; };

export function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

// Students never see a login screen. Signing in anonymously gives this browser
// a stable uid that persists across reloads, which is what lets the rules hold
// one device to one response per question.
export function signInStudent() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => { if (user) resolve(user); });
    signInAnonymously(auth).catch(reject);
  });
}

// The countdown is cosmetic -- the server decides what is late. But if we were
// already watching when the question opened, the snapshot arrives within a few
// hundred ms of openedAt, which is enough to measure the local clock's error
// and stop a student with a badly set clock from seeing a wrong timer.
export function makeClock() {
  let offset = 0;
  return {
    syncTo(serverTs) {
      if (serverTs) offset = serverTs.toMillis() - Date.now();
    },
    now() { return Date.now() + offset; },
  };
}

export function secondsLeft(clock, openedAt, windowSeconds) {
  if (!openedAt) return null;
  const deadline = openedAt.toMillis() + windowSeconds * 1000;
  return Math.max(0, Math.ceil((deadline - clock.now()) / 1000));
}

export function isOpen(q, clock) {
  if (!q || q.closedAt) return false;
  const left = secondsLeft(clock, q.openedAt, q.windowSeconds);
  return left === null || left > 0;
}

export function questionTitle(q) {
  return [q?.lecture, q?.label].filter(Boolean).join(' — ');
}

// Turns raw responses into the bars both the cockpit and the projector draw.
// Shared so the two can never disagree about what the class answered.
export function tallyBins(question, responses, numericBinCount = 8) {
  if (question?.type === 'numeric') return numericBins(responses, numericBinCount);
  return CHOICES.slice(0, question?.numOptions || 4).map((c) => ({
    key: c,
    count: responses.filter((r) => r.answer === c).length,
  }));
}

// Equal-width bins across the observed range. Collapses to a single bar if the
// class all answered the same number, which is the honest picture.
function numericBins(responses, binCount) {
  const values = responses.map((r) => Number(r.answer)).filter(Number.isFinite);
  if (!values.length) return [{ key: '—', count: 0 }];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return [{ key: String(lo), count: values.length }];

  const width = (hi - lo) / binCount;
  const round = (n) => Number(n.toFixed(2));
  return Array.from({ length: binCount }, (_, i) => {
    const from = lo + i * width;
    const to = from + width;
    const last = i === binCount - 1;
    return {
      key: `${round(from)}–${round(to)}`,
      count: values.filter((v) => v >= from && (last ? v <= to : v < to)).length,
    };
  });
}

export function downloadCsv(filename, rows) {
  const escape = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Spreadsheet formula injection: Excel and Sheets execute any cell that
    // starts with = + - @ (or a control char) as a formula on open, so a
    // student-controlled name or answer of "=..." could run when you open the
    // export. Prefix a quote to neutralize it, but leave plain numbers alone so
    // numeric answers stay numeric.
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(',')).join('\r\n');
  // ﻿ keeps Excel from mangling the file on a European locale.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function fmtTimestamp(ts) {
  return ts?.toDate ? ts.toDate().toISOString() : '';
}
