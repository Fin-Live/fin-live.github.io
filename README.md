# Live Questions

In-class polling and a student question queue. Static pages on GitHub Pages,
with Firestore for the live state and the participation record.

- `index.html` — student page (answer the current question, or ask one)
- `instructor.html` — console: launch, close, histogram, exports
- `display.html` — projector view, results only
- `codes.html` — one-time generator for the semester's student codes
- `firestore.rules` — the security rules, and the only thing enforcing access

## Setup

### 1. Firebase project

1. <https://console.firebase.google.com> → **Add project**. Decline Google
   Analytics and Gemini.
2. **Build → Firestore Database → Create database**. Keep the database ID as
   `(default)`, pick a region (permanent), choose **production mode**.
3. **Build → Authentication → Get started**, and enable two providers:
   - **Anonymous** — gives each student's browser an identity without a login.
   - **Email/Password** — the instructor account.
4. **Authentication → Users → Add user**. Create your account and copy its
   **User UID**.

### 2. Register the web app

**Project settings** → **Your apps** → **Web** (`</>`). Don't tick Firebase
Hosting. Copy the `firebaseConfig` values into [js/config.js](js/config.js), and
paste your UID into `INSTRUCTOR_UID` in the same file.

Those config values are public identifiers, not secrets. They ship in the page
source either way; the rules are what control access.

### 3. Security rules

Put your UID into [firestore.rules](firestore.rules) where marked, then paste
the whole file into **Firestore Database → Rules → Publish**. Nothing works
until this is done, which is the correct failure mode.

### 4. Publish

Push to a repo named `<account>.github.io` and GitHub Pages serves it at the
root automatically. Then add that domain under **Firebase → Authentication →
Settings → Authorized domains**, or sign-in is refused.

The repo must be public — Pages on a free plan requires it.

### 5. Student codes

Open `codes.html`, sign in, generate one code per student, keep the downloaded
CSV **outside this repo**. That file is the only place the code↔student mapping
exists; the database stores codes with no names attached.

## Running a lecture

Type the lecture and question label, pick the answer type (multiple choice or
numeric) and the window, hit **Launch**. Students already on the student page
see it immediately. The histogram fills live; **Close now** ends it early. The
question number auto-increments, so re-asking is one click.

Students never see the histogram on their phones — only their own confirmation.

### The projector view

`display.html` is a chrome-free page for the screen the room can see. It shows
the question label, the countdown, and a count of how many have answered — but
**not** the distribution, until you press **Show on projector** in the console.
It resets to holding on every launch.

It inherits your login if opened in the same browser as the console. It only
ever reads.

### Questions from students

Students enter a first name alongside their code, once. Questions arrive in the
console as `John: …`. Asking has its own anonymity checkbox, independent of the
answering setting; an anonymous question shows as `anonymous`.

**No screen in the app ever displays a code** — not the feed, not the projector,
not the generator page. Codes live in the exports and the database.

## Records

Nothing is ever deleted. Each export is the complete record to date.

**Participation** — one row per student, one column per lecture:

| Button | File |
|---|---|
| Answers by lecture | `participation-answers.csv` |
| Questions by lecture | `participation-questions.csv` |

```
student_code,first_name,Lecture 1,Lecture 2,Lecture 10,total
A1B2C3,Chris,2,0,1,3
X0Y9Z8,Dana,0,1,1,2
```

(Those codes are deliberately impossible — the generator's alphabet excludes
`0`, `1`, `I` and `O`, so an example can never collide with a real one.)

Lecture columns sort naturally, so "Lecture 10" follows "Lecture 2". A student
appears only once they have participated at all.

**Full detail** — one row per event:

| Button | File |
|---|---|
| All responses | `responses.csv` — code, lecture, question, answer, timestamp |
| All questions | `questions.csv` — timestamp, lecture, name, code, anonymous, text |

Participation sheets count only activity tied to a code. Anonymous activity
appears in the full-detail files, credited to nobody.

## How enforcement works

**Deadlines.** `openedAt` is written with the server's clock and the rules
compare incoming writes against `request.time`, also the server's clock. A
student who changes their system time or posts from the browser console is still
rejected. The on-screen countdown is cosmetic.

**One response per student.** The response document is keyed by the code, so a
resubmission overwrites rather than double-counting. Changing your mind before
the poll closes is allowed on purpose.

**One response per device.** Each device is pinned, on first submission, to the
one response key it may write for that question.

**Codes validated, never exposed.** The rules check roster membership
server-side, so a mistyped code is rejected immediately — without the code list
ever being readable by students.

## App Check — deliberately not used

Firebase App Check (reCAPTCHA) would block *scripted* access to the database.
It's intentionally left out: it only stops automation, and the risks that
matter here — a shared code, answering while absent, padding your own question
count — all happen through the real page by a real person, which App Check
waves through. It would also hand student browsing data to Google for little
gain. The scaffolding is one commit back in git history if that calculus ever
changes.

## Limits

Firestore's free tier allows 50,000 reads and 20,000 writes per day. A
100-student lecture with 20 questions uses roughly 6,000 reads and 2,000 writes.
The real constraint at that size is lecture-hall Wi-Fi, which argues for 20–30
second windows rather than 10.

## Maintenance

The Firebase SDK version appears in the import URLs at the top of
[js/common.js](js/common.js), [js/student.js](js/student.js),
[js/instructor.js](js/instructor.js), [js/display.js](js/display.js) and
[js/codes.js](js/codes.js). Bump them together or not at all.
