# MKMN AI 0.0.2 — Security and reliability fixes

A patch release with the fixes from an engineering review of 0.0.1. Nothing new
is added; each change closes a gap the review found. Every fix has a regression
test that fails on the 0.0.1 code.

## Fixes

- **Computer Use refuses consequential controls.** In 0.0.1 only a click was
  checked, against a short list of names: "OK", "Confirm", "Yes", "Approve", an
  icon button with no name, and choosing "Delete" from a list all went through.
  One list of consequential words, in English and Arabic
  (`src/shared/consequentialControls.json`), is now checked by the app before an
  action and again by the native driver against the control's name at the
  moment it acts. Clicks, toggles and list choices are judged; a control with
  no name is refused. A control with an ordinary name that still sends (a
  "Next" that submits) is not caught. The driver's version is now 1.1.0.
  Tests: `tests/computerUse-irreversible.test.ts`, `cargo test agent_wire`.
- **Voice models install only when they are the published archive.** Each of
  the 11 voice models is pinned to its SHA-256 and exact size. The download is
  checked before anything is unpacked, its entry names are checked, it is
  unpacked into a staging folder that refuses links, and only then does it
  replace the model's folder. A download that fails the check is deleted,
  never resumed onto. Windows' own `tar.exe` is used by its full path. The
  sizes shown for voice models are now the real archive sizes.
  Tests: `tests/voice-install.test.ts`.
- **Outside addresses are checked when the connection is made.** The skill
  library download checked a name's address before the request and the
  request then looked the name up again, so a name could answer a public
  address first and a private one second. The check now happens inside the
  connection's own lookup, connections are not reused, only https is read,
  and IPv6 forms that carry a private IPv4 address are refused. The generic
  downloader is https only. Tests: `tests/net-guard.test.ts`,
  `tests/npu-runtime-safety.test.ts`.
- **A generated page cannot leave its preview.** The preview's policy is now
  also sent as a response header, and the app cancels any navigation of the
  preview frame away from its own page. The page is then shown again once,
  with a notice; a page that keeps trying stops with a notice instead of
  looping. Tests: `tests/artifact-frame-isolation.test.ts`,
  `cargo test artifact_frame`.
- **Settings have one writer.** When the app's host could not take a settings
  change, the background process wrote the settings file itself, outside the
  host's lock. It now keeps the change, retries it, and logs every failure;
  only the host writes the file. Tests: `tests/settings-writer.test.ts`.
- **Deleting a chat deletes its run records.** Each step of a chat turn was
  kept on disk with no deletion. A run now records the chat it served, and
  once a deleted chat's Undo has passed, its run records go too. What MKMN
  stores and what it does not encrypt is listed in
  [docs/design/data-at-rest.md](../design/data-at-rest.md).
  Tests: `tests/forget-conversation.test.ts`.
- **Cited figures are checked.** When a sentence cites a source and states a
  figure the cited passage does not hold, the chat says so. The answer is not
  changed. Tests: `tests/cite.test.ts`.
- **Document text stays inside its frame.** Text from documents could contain
  the app's own frame tags and end its frame early. Those tags are now
  neutralized inside document text, and project knowledge is labelled as
  information, never instructions. Tests: `tests/prompt-injection.test.ts`.

## What was verified

- On this tree: the type check, the full Vitest suite and `cargo test`.
- The installer: `MKMN-0.0.2-arm64-Setup.exe` (52,175,567 bytes, SHA-256
  `64C3028DF47ABFC2C75EF1C6C34BAF78388E7DDE49BCFB2E8EF50B67A2B5E9A7`) built
  from this tree by `scripts\Build-Windows.ps1` (all 16 steps passed, tests
  included), installed silently on a Snapdragon X2 Elite PC; `MKMN.exe`
  reports 0.0.2.
- On that installed 0.0.2:
  - the driver (1.1.0) refused "Yes" in a real Windows message box and
    pressed "No";
  - the preview frame's response carries its policy header; a page that sets
    `location.href` after a real click was cancelled by the host, shown again
    with its text and a notice; a page that keeps leaving stopped with a
    notice after one retry; no request reached the other address;
  - a voice download resumed onto 1 MB of random bytes was refused on its
    SHA-256 and deleted; a clean download of the same model installed through
    the staging folder, with no links.

## Not verified

- A full Computer Use run with a model; the driver refusing a control with no
  name.
- On the installed app: the settings writer when the host fails, chat
  deletion removing run records, the cited-figure notice, document-frame
  neutralizing, and the skill library download. These have unit tests only.
- Whether a model follows instructions hidden in a document.
