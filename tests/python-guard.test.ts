import { describe, expect, it } from "vitest";
import { findPython, pythonCheck } from "../src/core/benchChecks";

/**
 * The benchmark ran the model's Python with the person's rights, behind a word list that
 * only stopped code which SAID `import os`. A name built from pieces walked past it. The
 * code now runs behind an audit hook that refuses programs, sockets, ctypes, writing, and
 * reading or listing outside Python's own install; ordinary answers still pass.
 */

const py = findPython();

const answer = (body: string) => "```python\n" + body + "\n```";

describe.skipIf(!py)("the benchmark's Python runs behind a guard", () => {
  it("an ordinary answer still passes, standard library included", () => {
    const c = pythonCheck(answer("import json, re, math, collections\ndef total(xs):\n    return sum(xs)"), [["total([1, 2, 3])", 6], ["total([])", 0]]);
    expect(c.score).toBe(1);
  });

  it("code that reaches os through a built-up name cannot list the disk", () => {
    const sneaky = answer("def f():\n    m = getattr(__builtins__, '__im' + 'port__')('o' + 's')\n    m.listdir(m.sep)\n    return 'escaped'");
    const c = pythonCheck(sneaky, [["f()", "escaped"]]);
    expect(c.score).toBe(0);
  });

  it("nor start a program, nor write a file, nor load ctypes", () => {
    for (const body of [
      "def f():\n    getattr(__builtins__, '__im' + 'port__')('o' + 's').system('echo hi')\n    return 'escaped'",
      "def f():\n    getattr(__builtins__, 'op' + 'en')('mkmn-guard-test.txt', 'w').write('x')\n    return 'escaped'",
      "def f():\n    getattr(__builtins__, '__im' + 'port__')('imp' + 'ortlib').import_module('ct' + 'ypes')\n    return 'escaped'",
    ]) {
      expect(pythonCheck(answer(body), [["f()", "escaped"]]).score, body).toBe(0);
    }
  });

  it("nor write inside Python's own install through os.open", () => {
    // the guard's own refusal is asked for: a folder that is merely not writable would also stop the write
    const body = "def f():\n    m = getattr(__builtins__, '__im' + 'port__')('o' + 's')\n    sys = getattr(__builtins__, '__im' + 'port__')('s' + 'ys')\n    try:\n        getattr(m, 'op' + 'en')(m.path.join(sys.prefix, 'mkmn-guard-oopen.txt'), m.O_WRONLY | m.O_CREAT)\n    except PermissionError as e:\n        return 'blocked' if 'blocked' in str(e) else 'denied by the system'\n    except OSError:\n        return 'denied by the system'\n    return 'escaped'";
    expect(pythonCheck(answer(body), [["f()", "blocked"]]).score).toBe(1);
  });
});
