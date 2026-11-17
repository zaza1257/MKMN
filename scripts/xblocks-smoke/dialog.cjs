/* Checks the dialog block in Chromium: typing, keys, clicks, choices, conditions, effects, end, restart, errors.
 * Usage (from the repo root): node scripts/xblocks-smoke/dialog.cjs */
const { open, check } = require("./harness.cjs");
const html = `<!doctype html><body>
<x-state gold="0" name="Ana" hp="3"></x-state>
<button id="talk" data-click="emit:talk:elder">talk</button>
<button id="fast" data-click="emit:talk:fast">vite</button>
<button id="cache" data-click="emit:talk:cache">cache</button>
<button id="broken" data-click="emit:talk:broken">casse</button>
<x-dialog id="elder" speed="40">
  <x-line who="Elder" do="gold+=5">Hello {name}, you have {gold} coins.</x-line>
  <x-line who="Elder" when="gold>=100">Never shown.</x-line>
  <x-line who="Elder" ask="Will you help?">The village must be saved.
    <x-choice do="hp-=1" goto="yes">Yes</x-choice>
    <x-choice goto="no">No</x-choice>
  </x-line>
  <x-line id="yes" who="Elder" next="end">Thank you.</x-line>
  <x-line id="no" who="Elder" next="end">Too bad.</x-line>
</x-dialog>
<x-dialog id="fast" speed="0"><x-line who="Quick">Right away.</x-line></x-dialog>
<div style="display:none"><x-dialog id="cache"><x-line>Hidden.</x-line></x-dialog></div>
<x-dialog id="broken"><x-line who="Bug" next="nowhere">Hi.</x-line></x-dialog>
</body>`;
const FULL1 = "Hello Ana, you have 5 coins.";

(async () => {
  const t = await open(html, ["dialog"]);
  const p = t.page;
  const wait = (ms) => p.waitForTimeout(ms);
  const press = async (k, gap = 80) => { await p.keyboard.press(k); await wait(gap); };
  const text = () => p.evaluate(() => { const b = document.querySelector(".dialog-box .text"); return b ? b.textContent : null; });
  const who = () => p.evaluate(() => { const b = document.querySelector(".dialog-box .who"); return b ? b.textContent : null; });
  const boxes = () => p.evaluate(() => document.querySelectorAll(".dialog-box").length);
  const choices = () => p.evaluate(() => Array.from(document.querySelectorAll(".dialog-box .choice")).map((c) => c.textContent.trim()));
  const get = (k) => p.evaluate((k) => window.X.get(k), k);
  const ends = () => p.evaluate(() => window.__ends.slice());
  await p.evaluate(() => { window.__ends = []; window.X.on("dialog:end:*", (d, n) => window.__ends.push(n)); });

  // Keys without a dialog do nothing.
  await press("Enter"); await press("2");
  check("keys idle without a dialog", (await boxes()) === 0 && (await get("talked_elder")) === 0 && t.errors.length === 0, JSON.stringify(await t.state()));

  // Start by event: the line's do runs when shown, the text is typed (not all at once), {name} and {gold} are filled.
  await p.click("#talk"); await wait(60);
  const partial = await text();
  check("talk starts the panel", (await boxes()) === 1 && (await who()) === "Elder" && (await get("dialog_open")) === 1);
  check("text is typed, effects applied at display", partial.length > 0 && partial.length < FULL1.length && (await get("gold")) === 5, JSON.stringify(partial));

  // Enter finishes the typing at once, the next Enter goes on; the line with a false `when` is skipped.
  await press("Enter");
  check("Enter finishes the text at once", (await text()) === FULL1);
  await press("Enter"); await wait(1000);
  const body = (await text()) || "";
  check("false when is skipped, question and choices shown", body === "The village must be saved." && (await choices()).length === 2 && !/Never/.test(body), JSON.stringify([body, await choices()]));

  // A digit chooses; the chosen line is reached through goto, the end ends the conversation and counts it.
  await press("2"); await wait(900);
  check("digit chooses, goto line shown", (await text()) === "Too bad.", await text());
  await press("Enter", 120);
  check("end closes and counts the talk", (await boxes()) === 0 && (await get("dialog_open")) === 0 && (await get("talked_elder")) === 1 && (await ends()).includes("dialog:end:elder"), JSON.stringify([await get("talked_elder"), await ends()]));

  // Second talk: the first line runs again (gold 10), a click on a choice runs its effect (hp 2) and its goto.
  await p.click("#talk"); await wait(900);
  await press("Enter"); await wait(1000);
  check("second talk, do runs again", (await get("gold")) === 10 && (await choices()).length === 2);
  await p.locator(".dialog-box .choice", { hasText: "Yes" }).click(); await wait(900);
  check("click chooses, effect and goto applied", (await get("hp")) === 2 && (await text()) === "Thank you.", JSON.stringify([await get("hp"), await text()]));
  await press("Enter", 120);
  check("second end counted", (await boxes()) === 0 && (await get("talked_elder")) === 2);

  // Arrow keys move the highlight, Enter chooses the highlighted one.
  await p.click("#talk"); await wait(900);
  await press("Enter"); await wait(1000);
  await press("ArrowDown", 60);
  const on = await p.evaluate(() => { const c = document.querySelector(".dialog-box .choice.on"); return c ? c.textContent.trim() : null; });
  check("arrow moves the highlight", on === "2. No", on);
  await press("Enter"); await wait(900);
  check("Enter chooses the highlighted choice", (await text()) === "Too bad." && (await get("hp")) === 2);
  await press("Enter", 120);
  check("third end counted", (await boxes()) === 0 && (await get("talked_elder")) === 3);

  // Speed 0: the text is shown at once.
  await p.click("#fast"); await wait(40);
  check("speed 0 shows the text at once", (await text()) === "Right away." && (await who()) === "Quick", await text());
  await press("Enter", 120);

  // A hidden dialog does not start.
  await p.click("#cache"); await wait(80);
  check("hidden dialog does not start", (await boxes()) === 0 && (await get("dialog_open")) === 0);

  // An unknown next id is reported, and the conversation ends without an error.
  await p.click("#broken"); await wait(400);
  await press("Enter", 150);
  check("unknown line id is reported and ends", (await boxes()) === 0 && t.errors.length === 0 && (await t.problems()).some((m) => /nowhere/.test(m)), JSON.stringify(await t.problems()));

  // Restart closes an open dialog and returns the state to its start.
  await p.click("#talk"); await wait(900);
  check("dialog open before restart", (await boxes()) === 1);
  await p.evaluate(() => window.X.restart()); await wait(60);
  check("restart closes and resets", (await boxes()) === 0 && (await get("dialog_open")) === 0 && (await get("talked_elder")) === 0 && (await get("gold")) === 0);

  // The API of the element.
  const api = await p.evaluate(() => {
    const el = document.querySelector("x-dialog#elder");
    const before = el.api.open();
    el.api.start();
    return { before, after: el.api.open(), box: document.querySelectorAll(".dialog-box").length };
  });
  check("api start and open", api.before === false && api.after === true && api.box === 1, JSON.stringify(api));
  await p.evaluate(() => window.X.restart());

  const extra = (await t.problems()).filter((m) => !/nowhere|cache is hidden/.test(m));
  check("no page error and no unexpected problem", t.errors.length === 0 && extra.length === 0, JSON.stringify([t.errors, extra]));
  await t.close();
})();
