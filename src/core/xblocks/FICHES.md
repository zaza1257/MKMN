# Block sheets

Read `docs/design/blocks-design.md` first (the why) and `src/core/xblocks/core.js` (the `X` API, already written and tested: do not modify it).
Each block is a file `src/core/xblocks/<name>.js`: a plain browser script (no module, no `import`, no dependency), which uses only `X` and the DOM, and registers itself with `X.define("<name>", class extends HTMLElement {...})` (which creates `<x-name>` and the alias `<game-name>`).

## Common rules (valid for all blocks)

1. **No access to model code**: a block never evaluates text (`eval`, `new Function`, `setTimeout(string)` forbidden). Conditions go through `X.test("hp<=0")`, effects through `X.run("gold+=1 say:\"Hi\"", ctx)`.
2. **Everything goes through state**: a block reads (`X.get`), writes (`X.set`, `X.add`) and emits events (`X.emit("verbe:objet", {el})`). It does not manipulate the elements of other blocks.
3. **Appearance = the author's CSS**: the produced elements carry readable classes (`tile`, `wall`, `entity`, `player`, `dialog-box`...). The default styles are injected once into a `<style id="x-<name>-style">` with `:where(...)` (zero specificity) so that the author's CSS always wins. Legend emojis and colors are only default values.
4. **Input blocked during a dialog or a battle**: any block that reads the keyboard ignores keys when `X.get("dialog_open")` or `X.get("battle_open")` is 1 or more, and when `X.isOver()`.
5. **Restart**: listen to `X.on("restart", ...)` and return to the block's starting state.
6. **Loop**: use `X.loop(fn(dt))` (seconds), never your own `requestAnimationFrame`. Timers: `setInterval` is allowed if it stops when `X.isOver()`.
7. **An invisible block does not act**: if its element (or a parent `x-scene`) is hidden (`el.offsetParent === null`), it does not respond to keys and does not run.
8. **Errors**: a missing or invalid attribute never throws an exception; add a short message to `X.problems` and continue with a reasonable default value.
9. **Write to be read**: short functions, brief comments only when the "why" is not obvious. No model or tool name in comments.
10. **Test**: a `scripts/xblocks-smoke/<name>.cjs` script that uses `scripts/xblocks-smoke/harness.cjs` (see `core.cjs` as a model), at least 8 checks of the real behavior in Chromium, and prints PASS/FAIL. It must pass before delivery.
11. **Delivery**: do not modify any file other than those of your block. Do not commit. Final message: a short list of what is done, what is missing, and any change you would like in `core.js` (ask for it, do not do it).

## map — top-down world (RPG, dungeon, maze)

File: `map.js`. Behavior reference: the engine of the first version in `src/core/gameBlocks.ts` (constant `BLOCKS_SOURCE`): reuse its game rules, change its rendering (DOM instead of canvas) and the API (`X`).

Content of `<x-map>`: an `<x-legend>` (text, one line per character) then the map lines in printable ASCII. Attributes: `tile` (px, 32 by default), `view="15x11"` (camera window in tiles, optional), `name` (default: `id`).

Legend line: `<char> <role> [appearance] [effects] [needs:condition] ["words"] [still] [to:scene] [as:name]`
- appearance: an emoji or a CSS color (`#c33`, `red`). `as:name` adds the `name` class to the tile (for the author's CSS) and names the object in events.
- effects: those of `X.run`, e.g. `gold+=1`, `hp-=1` (the old `gold+1` spelling is still accepted by `X.run`). A token that looks like an effect (identifier followed by `+=`, `-=`, `=`, `+1`, `-1`, `++`, `--`) is an effect; `needs:` takes the rest of the token without a space (e.g. `needs:key`, `needs:gold>=3`).
- roles: `wall`, `floor`, `player`, `item`, `enemy`, `door`, `exit`, `npc`, `trap`, `switch`, `warp`. Any character absent from the legend, as well as `.` and space, is floor.

Rendering: a CSS grid in the element. Each tile is `<div class="tile ROLE [as]">`; moving entities (player, enemies) are `<div class="entity player|enemy ...">` placed by `grid-area` (or transform); a picked-up object disappears (the tile becomes `floor`). The player always has the `player` class.

Behavior:
- Arrows, WASD, ZQSD: one step per press, 90 ms minimum between two steps, the key held down repeats.
- wall blocks. enemy: walking onto it defeats it (effects applied, it disappears), enemies wander every 650 ms except `still`; an enemy that arrives on the player applies its effects and disappears. door: blocked as long as `needs:` is false; if `needs:` is a simple state name, the door consumes 1 of it; once open, it becomes floor. exit: win (`X.finish("win", words)`) if `needs:` is true, otherwise says the words. npc: walking onto it says its words, applies the effects, does not advance. trap: effects on each entry. switch: effects once, then becomes floor. warp: `X.go(to)`. item: effects, words said, disappears.
- Events (`detail` = `{el, x, y, name}`): `pickup:<role>` and `pickup:<name>`, `hit:<role>`, `open:door`, `talk:<name>` (npc), `enter:<role>`, `step`. The name is `as:` if it exists, otherwise the character. For an npc, emit `talk:<name>` **before** saying the words; only say the words when there is no dialog (if no `<x-dialog id="<name>">` exists in the page).
- State written: `player_x`, `player_y`.
- Camera: if `view` is given, the element is a window (size view × tile, `overflow:hidden`) and the inner grid shifts to follow the player, clamped to the edges. Otherwise everything is visible.
- Normalized map: common indentation removed, lines padded to the max width.
- Several `<x-map>` in different scenes: only the visible map responds to keys.
- API for the tests: `el.api = { step(dx, dy), me(), grid(), entities() }`.

## platformer — side-view level (Mario, Sonic-like, runner)

File: `platformer.js`. Same content shape as `map` (`<x-legend>` + ASCII lines).

Attributes of `<x-platformer>`: `tile` (px, 32), `view` (visible width in tiles, 16), `gravity` (tiles/s², 40), `jump` (initial speed in tiles/s, 14), `speed` (tiles/s, 7), `run` (multiplier with Shift, 1.6).

Legend roles: `ground` (solid), `brick` (solid; if the player is big `big>=1`, hitting it from below breaks it), `block` (solid; hit from below: applies its effects, emits `hit:block`, becomes `used`, gray), `platform` (passable from below, solid from above), `player` (start), `coin` (effects on contact, disappears), `walker` (walks, turns around against a wall or at an edge; stomped from above: effects of its line, disappears, the player bounces; side contact: hurts), `flyer` (like walker, does not fall, oscillates), `spike` (hurts), `flag` (win if `needs:` is true), `spring` (strong bounce). Effects, appearance (emoji or color), `needs:`, `as:`, words have the same meaning as for `map`.

Physics (fixed, in tiles): horizontal acceleration and friction, variable-height jump (releasing shortens it), `coyote time` 0.1 s, buffered jump 0.1 s, gravity, capped fall speed, grid collisions (X axis then Y axis). The player is big (2 tiles) when the `big` state is 1 or more; being hurt with `big>=1` sets `big=0` instead of applying the enemy's effects.
Hurt: applies the enemy's effects (e.g. `lives-=1`), then the player returns to the start (or to the last `checkpoint` if there is one) with 1 s of blinking invulnerability. Falling below the level hurts in the same way (effects of the `fall` attribute, default `lives-=1`).
Camera: follows the player in X (and in Y if the level is taller than the view), clamped.
Rendering: `<canvas>` in the element; legend colors and emojis, default colors per role; `image-rendering: pixelated`.
Keys: arrows/AD/QZ to move, up/W/Z/space to jump, Shift to run.
Events: `jump`, `land`, `stomp:<name>`, `coin`, `hit:block`, `hurt`, `flag`, `fall`. State written: `player_x`, `player_y` (in tiles).
Test API: `el.api = { me(), step(dt), press(code), release(code) }` to advance the simulation without a real keyboard.

## battle — turn-based fights (Pokémon-like)

File: `battle.js`. Elements: `<x-battle id="b1" on-win="..." on-lose="..." on-flee="...">` containing `<x-fighter side="you|enemy" name="Pikou" hp="20" attack="5" defense="3" speed="5" type="normal" sprite="🐭">` and for each of them `<x-move name="Charge" power="5" type="normal" uses="10" effect="...">`. Optional types: `<x-type name="fire" strong="grass,ice" weak="water,fire">`.

Start: the `battle:<id>` event (e.g. `emit:battle:b1` in an effect) opens the battle (panel `div.battle-ui` in the element, classes `fighter you|enemy`, `hp-bar`, `menu`, `log`). During the battle: state `battle_open=1`.
Flow: Fight menu (list of moves) / Switch (if several living `side="you"`) / Flee (chance based on speed). Turn order follows `speed`. Damage: `max(1, round(power * attack / defense * random(0.85..1) * effectiveness))`, effectiveness 2 / 0.5 / 1 by the type table. The enemy picks a random move with uses left. The HP of each fighter is written to state: `<fighter id or its lowercase name>_hp` (e.g. `pikou_hp`), changeable by the page (health bars in CSS via the `--pikou_hp` variable).
End: victory (all enemies at 0) → state `battle_result="won"`, event `battle:won:<id>`, effects of `on-win`, `battle_open=0`. Defeat → `lost`, `battle:lost:<id>`, `on-lose`. Flee → `fled`. Keyboard: arrows/digits + Enter/space, or click.
A fighter's HP count does not stay at zero after a `restart`: the starting values are restored.
Test API: `el.api = { start(), choose(index), state() }`.

## dialog — dialog boxes with choices

File: `dialog.js`. Elements: `<x-dialog id="ancien" speed="40">` containing `<x-line who="Ancien" [when="cond"] [do="effects"] [id="marker"] [next="marker|end"] [ask="Question?"]>Text with {state_name}</x-line>` and, in an `ask` line, `<x-choice [do="effects"] [goto="marker"]>Yes</x-choice>`.
Start: the `talk:<id>` or `dialog:<id>` event. During: state `dialog_open=1`, panel `div.dialog-box` (classes `who`, `text`, `choices`) added to `<body>` and removed at the end. Text typed letter by letter at `speed` characters/s (0 = all at once); Enter, space or click finishes the text then goes to the next line; digits/arrows/Enter choose. Lines with a false `when` are skipped. `do` is applied on display of the line; `{nom}` is replaced by `X.fill`.
End: `dialog:end:<id>`, `dialog_open=0`, and the `talked_<id>` state increases by 1 on each finished conversation (both usable by `when`).
Test API: `el.api = { start(), advance(), choose(index), open() }`.

## timer and calc — timers and computed values

Files: `timer.js` and `calc.js` (two blocks, two files).
`<x-timer every="1s" do="time+=1" [while="cond"] [times="n"] [after="3s"] [start="cond"]>`: runs `do` every `every` (units `ms`, `s`, `m`; a bare number = seconds), or once after `after`. It only runs while `while` is true (default true) and, if `start` exists, after it has become true. It stops at the end of the game. `restart` resets it. An `<x-clock of="time" format="m:ss">` (same file) displays a state in minutes:seconds (`m:ss`, `s`, `mm:ss`).
`<x-calc name="total" value="prix * qte + 1">`: writes to the `name` state the result of an arithmetic expression over state (`+ - * / %`, parentheses, numbers, state names, paths `liste.length`, functions `min max round floor ceil abs`, `count(liste)`, `count(liste, champ == valeur)`, `sum(liste, champ)`). Recalculated on each change of the states it reads, without an infinite loop (it writes only if the value changes). Hand-written parser, without `eval`. A division by zero gives 0 with a message in `X.problems`.

## xcheck — static checking of a block page (TypeScript, without a browser)

Files: `src/core/xcheck.ts` and `tests/xcheck.test.ts` (vitest). No access to a real DOM: read the page text (regex or small parser; `jsdom` is not available).
Export:
- `X_TAGS`: table `{ tag: { attrs: string[], children?: string[] } }` of the known tags (without prefix; the `x-` and `game-` prefixes are accepted), from this sheet file;
- `xFlaws(html: string): string[]`: short sentences in English, one per problem, with the correction when it is known;
- `xMend(html: string): { html: string; fixed: string[] }`: fixes without a model what is safe (tag or attribute one or two letters away from a known one, `gold + 1` → `gold+=1` in `do` attributes and the legend, completed map lines, invalid state names set to `[a-z][a-z0-9_]*`).
Checks: unknown `x-` tag (with “did you mean”), unknown attribute; references (an `of=` to a state never declared, created by an effect or computed; `go:` to a missing scene; `emit:battle:<id>` to a missing battle; an `<x-dialog>` with no `talk` calling it is not an error); `when`/`data-when` expressions that do not parse; unreadable effects; maps (lines of the same width, a single player, complete legend, no emoji in the map lines, at least one wall for `map`); platformer (one player, one flag, some ground); reachability on the `map` map: breadth-first traversal from the player where a wall blocks, a simple `needs:` door only opens if a reachable object grants that state, the exit must be reachable (message: “the exit cannot be reached: <reason>”); author-written `<script>` (forbidden, except the one whose id is `blocks`/`xblocks`).
Tests: at least 15 cases (a healthy page passes with no problem, each flaw is found, each fix does what it says).

## art — drawn objects (SVG), called by their name

File: `art.js`. The main model does not draw: it places an object by its name, and a drawer (another call, elsewhere) writes the SVG of each object separately.
- `<x-asset name="oiseau" size="34x24" about="a yellow bird in profile"> <svg viewBox="0 0 34 24">…</svg> </x-asset>`: definition (hidden by the block, `display:none`). Registered in `X.assets[name] = { svg, w, h, about }` at startup and when the element changes (MutationObserver).
- `<x-art of="oiseau" [size="40x28"]></x-art>`: displays the object's SVG inline (asset size or `size`), classes `art art-<name>`. An unknown name displays a small dotted gray rectangle and adds a message to `X.problems`.
- Mandatory cleaning of the SVG (`X.cleanSvg(text)`: returns the safe SVG or `""`): remove `<script>`, `<foreignObject>`, `<iframe>`, external `<style>`, any `on*` attribute, any `href`/`xlink:href` that is not `#anchor`, `javascript:` and `data:`; refuse text that does not contain `<svg`. No network resource.
- Shared colors are written `var(--arbre_vert, #3a3)` in the SVG; inline, the page's CSS resolves them by itself.
- API: `X.art(name)` → `{svg, w, h, about}` or null; `X.artHtml(name, size?)` → inline SVG string ready to insert; `X.artImage(name, cb)` → calls back `cb(HTMLImageElement|null)` with an image made from a blob, after replacing each `var(--x, fallback)` with the computed value of `--x` on `<body>` (otherwise the fallback), to draw on a canvas; the image is cached and remade when the asset or the variables change (`X.artVersion` increases).
- In the legends of `map` and `platformer`: the appearance `art:oiseau` (instead of an emoji or a color) displays the object. For `map` (DOM): `X.artHtml` in the tile or the entity. For `platformer` (canvas): `X.artImage`, drawn in the tile (or at the w×h size of the asset in tiles if the asset is larger than one tile), then redrawn when the image arrives. As long as the image is not ready, use the role's color.
- Tests: `scripts/xblocks-smoke/art.cjs` (at least 10 checks: asset registered, `x-art` displays, cleaning of `<script>`/`onload`/external `href`, `var()` resolved for the image, unknown name, asset change reflected, `art:` in a legend of `map` and of `platformer`). Also re-run `map.cjs`, `platformer.cjs` and `core.cjs`: they must still pass.

## platformer — side-view level (Mario, Sonic-like, runner)

File: `platformer.js`. Same content shape as `map` (`<x-legend>` + ASCII lines).

Attributes of `<x-platformer>`: `view` (visible width in tiles, 16), `tile` (px per tile for the drawing of `art:`, and cap of the canvas resolution, 32), `sky` (optional background color, otherwise the canvas is transparent), `gravity` (tiles/s², 40), `jump` (initial speed in tiles/s, 14), `speed` (tiles/s, 7), `run` (multiplier with Shift, 1.6).

Legend roles: `ground` (solid), `brick` (solid; if the player is big `big>=1`, hitting it from below breaks it), `block` (solid; hit from below: applies its effects, emits `hit:block`, becomes `used`, gray), `platform` (passable from below, solid from above), `pipe` (solid, a tube; two characters side by side make a wide pipe), `scenery` (no collision, behind everything; `as:cloud`, `as:bush`, `as:hill` have a default drawing; otherwise emoji, color or `art:`), `water` (passable, slows the player, does not hurt), `player` (start), `coin` (effects on contact, disappears), `walker` (walks, turns around against a wall or at an edge; stomped from above: effects of its line, disappears, the player bounces; side contact: hurts), `flyer` (like walker, does not fall, oscillates), `spike` (hurts), `flag` (win if `needs:` is true; a column of `flag` tiles is a pole), `spring` (strong bounce), `checkpoint` (blue flag used as a return point). Effects, appearance (emoji, color, `art:`), `needs:`, `as:`, words have the same meaning as for `map`. A legend color is the main color of the default drawing.

Token `gives:big` on a `block`: hit from below, it makes a mushroom come out (on the tile above, which must be free) that moves forward, falls and walks; touching it sets `big` to 1 and emits `powerup:big`. The block's effects are applied at the moment of the hit.

Physics (fixed, in tiles): horizontal acceleration and friction, variable-height jump (releasing shortens it), `coyote time` 0.1 s, buffered jump 0.1 s, gravity, capped fall speed, grid collisions (X axis then Y axis). The player is big (2 tiles) when the `big` state is 1 or more; being hurt with `big>=1` sets `big=0` instead of applying the enemy's effects. In water, speed is reduced and so is gravity.
Hurt: applies the enemy's effects (e.g. `lives-=1`), then the player returns to the start (or to the last `checkpoint` if there is one) with 1 s of blinking invulnerability. Falling below the level hurts in the same way (effects of the `fall` attribute, default `lives-=1`).
Camera: follows the player in X (and in Y if the level is taller than 18 tiles), clamped.
Rendering: a `<canvas>` that takes the width of its container (`view` tiles across; a narrower level is centered); its height follows the level, reduced proportionally if it exceeds 80% of the window. Internal resolution: `min(displayed tile, tile)` × `devicePixelRatio` per tile, stretched in CSS. The canvas is transparent: the background comes from the page. Careful default drawing (grass and dirt, bricks in staggered bond, `?` block, rimmed pipe, spinning coins, mushroom, walker with alternating feet, fluttering flag, player that walks and turns around); all in canvas, no external resource. Invulnerability blinking: at most 3 times per second.
Keys: arrows/AD/QZ to move, up/W/Z/space to jump, Shift to run.
Events: `jump`, `land`, `stomp:<name>`, `coin`, `hit:block`, `powerup:big`, `hurt`, `flag`, `fall`. State written: `player_x`, `player_y` (in tiles).
Test API: `el.api = { me(), step(dt), press(code), release(code), place(x, y), tile(c, r), entities(), at(fx, fy) }`. `at(fx, fy)`: what is under a click (fractions 0 to 1 of the canvas width and height, camera included) → `{ col, row, char, role, name, kind, box }`; `kind` is `entity` (player, walker, flyer, mushroom, an entity wins over the tile where it is), `tile` or `none` (empty air); `box` = `{x, y, w, h}` in fractions of the canvas (the entity, or the tile); `null` outside the canvas or the level.
