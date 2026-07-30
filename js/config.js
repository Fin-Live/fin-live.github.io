// Firebase console -> Project settings -> Your apps -> Web app -> Config.
//
// These values are NOT secrets. They identify your project, and they are
// visible to anyone who views the page source -- that is normal and expected.
// What stops a student from tampering with anything is firestore.rules.

export const firebaseConfig = {
  apiKey: 'AIzaSyD7wXw7lsiBQ13ThnQKqLUzpG9MlEcNhFw',
  authDomain: 'finance-live.firebaseapp.com',
  projectId: 'finance-live',
  storageBucket: 'finance-live.firebasestorage.app',
  messagingSenderId: '960924549021',
  appId: '1:960924549021:web:80d6ee92986025e199b974',
};

// Firebase console -> Authentication -> Users -> your account's "User UID".
// The same value has to go into firestore.rules; this copy only controls what
// the page shows you, the rules copy is what actually enforces access.
export const INSTRUCTOR_UID = '4lb9Cnu7WIfk6hmLFCuycTzkjXG3';

// App Check reCAPTCHA v3 *site* key (the public half — safe to commit; the
// secret half stays in the Firebase console). Left blank, App Check simply
// doesn't initialize and the app runs exactly as before. Fill it in, deploy,
// confirm verified requests appear in the console, and only THEN turn on
// enforcement — see the setup notes in the README.
export const RECAPTCHA_SITE_KEY = '';
