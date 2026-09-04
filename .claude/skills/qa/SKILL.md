---
name: qa
description: Adversarial QA sweep for Signarm Signal — hunts real, reproducible bugs and proves each one with a failing test before reporting it. Use this whenever the user asks for a bug hunt, QA pass, test review, regression check, "find bugs", "is this safe to ship", "review my changes", "did I break anything", or after any substantial change lands. Also use before a release, when a suite passes but something still feels wrong, and when reviewing code an AI just wrote — that code is the least scrutinised in the repo.
---

# QA sweep

You are hunting for defects a user would actually hit. The bar is not "this
looks suspicious" — it is a reproduction.

## The prime directive: prove it or drop it

Report nothing you have not reproduced. For each candidate, either

- write a test that **fails against the current code** and passes once fixed, or
- drive the running app or API and capture the wrong output.

Then say so with the evidence. A finding without a reproduction is a guess, and
guesses are worse than silence — they cost the reader more time to disprove
than they would have spent finding the bug themselves.

The counterpart matters just as much: when a suspicion does not reproduce, drop
it and say nothing. Ten proven findings beat forty plausible ones.

## Why a passing suite proves less than it looks

Every serious bug in this project's history escaped a green suite, and almost
always because the test exercised a *different path than the user takes*. Two
patterns account for most of it:

- **Tests call the API; users drive the UI.** A store action tested directly
  with a whole string passes, while the field that writes it stores one
  character per keystroke.
- **Tests use one synthetic event; users type.** `fireEvent.change` delivers a
  complete value in a single event. Real typing delivers one character at a
  time, and the difference has hidden multiple bugs here.

So treat "the suite is green" as no evidence at all about a path the suite does
not walk. Ask what a person does, then do that.

## Where to look first

Weight your attention by how little scrutiny the code has had:

1. **Code changed in the last few commits**, especially anything an AI wrote.
   It is fluent, it typechecks, it has tests that pass — and it is the least
   reviewed code in the repository. Two of this project's regressions were
   introduced by the same agent that had just finished a bug sweep.
2. **Code with no test that goes through the UI.**
3. **Anything asynchronous that reads state, awaits, then writes it back.**

## The escape checklist

These are the ten ways bugs have actually escaped in this repo, not a generic
list. Read `references/escape-analysis.md` for the worked example behind each
one, the probe pattern that catches it, and the bug it originally missed.

| # | Category | The question to ask |
|---|---|---|
| 1 | Real typing | Does typing character-by-character give the same result as one paste? |
| 2 | UI path vs API path | Is there a test that goes through the control a person uses? |
| 3 | Visual rendering | Has anyone rendered this and looked at it? |
| 4 | Concurrency | What if two of these overlap? What if one is slow? |
| 5 | Property / round-trip | Does encode→decode return the original, for duplicates and edge values? |
| 6 | Adversarial security | What does the guard do with input designed to slip past it? |
| 7 | State invariants | After a delete or revert, does every reference still resolve? |
| 8 | Resource limits | What happens at 100× the expected size? |
| 9 | Flake detection | Does the suite pass five times in a row? |
| 10 | Clean build | Does it install, build and test from a fresh clone? |

## Priority lenses

Apply all three, in this order when time is short:

- **Security-weighted** — the proxy, the SSRF guard, vault crypto, the Tauri
  IPC surface. Highest blast radius, and historically the richest seam.
- **User-path weighted** — typing, clicking, keyboard shortcuts, each sidebar
  panel. Where the most embarrassing bugs hid, and where tests are thinnest.
- **Regression-guard** — confirm the already-fixed defects listed in
  `references/escape-analysis.md` are still fixed. They have come back before.

## Your authority

Write tests. Do not change `src/`.

You may create and edit files under `tests/`, run any read-only command, start
the app, and drive it. Leave the fix to the person reading your report: an
agent editing source unsupervised is how the tab-strip regression got in.

If a fix is obvious, describe it in one or two lines. Do not apply it.

## Reporting

Lead with what a user would experience, not the code smell. "Typing a secret
stores one character" lands; "state synchronisation issue in SecretValueInput"
does not.

For each finding:

**What breaks** — the user-visible symptom, in one sentence.
**Reproduction** — the failing test's name, or the exact command and output.
**Why it escaped** — which checklist category, so the gap gets closed too.
**Suggested fix** — one or two lines. Optional.

Then a one-paragraph summary: what you checked, what you proved, and — this
part is not optional — **what you could not check and why**. A reader who
believes you swept everything when you swept half is worse off than before.

Order findings by user impact, not by how clever they were to find.
