// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Blast Radius: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash): if the command is risky, work out its blast radius. When
// nothing is at risk (it would delete, discard and drop nothing, or delete only
// inside Claude Code's own temp folder), the command runs unasked. Otherwise
// open a pane with Proceed and Cancel, and hold the call until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

const PANE_ID = "blast-radius";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const LIST_MAX = 10;

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held = null;

export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const command = String(e.command ?? "");
    const risks = classify(command);
    if (risks.length === 0) {
      return next(e);
    }
    // Measure before queueing, so a command with nothing at risk never waits
    // behind another call's hold.
    let verdict = await assess($, command, risks);
    if (verdict.clear) {
      $.ui.log(`blast-radius: ran unasked, nothing at risk: ${verdict.why}`, { to: "debug" });
      return next(e);
    }
    // One hold at a time. If another risky call is already held (a subagent's,
    // say), wait until it is answered. `held` is claimed with no await between
    // the check and the claim, so two waiting calls can't both get through.
    let waited = false;
    while (held !== null) {
      if (next.signal.aborted) {
        return { deny: "Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
      }
      waited = true;
      await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
    }
    const mine = { command, risk: verdict.risk, report: verdict.report, decision: null, where: "pane" };
    held = mine;

    let opened = { isPlaced: false };
    let decision;
    let summary = verdict.report.summary;
    try {
      if (waited) {
        // The call held before this one may have run and changed what this one touches.
        verdict = await assess($, command, risks);
        if (verdict.clear) {
          mine.decision = "clear";
        } else {
          mine.risk = verdict.risk;
          mine.report = verdict.report;
          summary = verdict.report.summary;
        }
      }
      if (mine.decision === null) {
        opened = await $.ui.open({ id: PANE_ID, title: "Blast Radius", focus: true, rows: paneRows(mine.report) });
        if (!opened.isPlaced) {
          mine.where = "band";
        }
        $.ui.invalidate("ui.render");

        const startedAt = await $.clock.now();
        while (mine.decision === null) {
          if (next.signal.aborted) {
            mine.decision = "interrupted";
            break;
          }
          if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
            mine.decision = "timeout";
            break;
          }
          await $.process.run(["sleep", POLL_SECONDS], { timeoutMs: 5000 });
        }
      }
    } catch {
      mine.decision = "error"; // anything unexpected refuses the command
    } finally {
      decision = mine.decision;
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed.
      try {
        if (opened.isPlaced) {
          await $.ui.close({ id: PANE_ID });
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
      $.ui.invalidate("ui.render");
    }

    if (decision === "clear") {
      return next(e);
    }
    if (decision === "proceed") {
      $.ui.toast("Blast Radius: running it");
      return next(e);
    }
    const why = {
      cancel: "the user pressed Cancel",
      timeout: "no answer within 10 minutes",
      interrupted: "the turn was interrupted",
      error: "Blast Radius hit an error while holding it",
    }[decision] ?? "no answer was recorded";
    return {
      deny: `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
    };
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });
}

// ---- Deciding whether to hold ---------------------------------------------

/**
 * Measures every risky part of the line. { clear: true, why } when nothing is
 * at risk, so the line can run unasked. Otherwise { clear: false, risk, report }
 * for the first part that would change something, to show in the pane.
 */
async function assess($, command, risks) {
  const measured = [];
  try {
    const sessionCwd = await $.session.cwd();
    for (const risk of risks) {
      // Measure where the part will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd;
      const report = cwd === null
        ? { summary: `${risk.label} in ${risk.dir}`, lines: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
        : await measure($, risk, cwd);
      measured.push({ risk, report });
    }
  } catch (error) {
    const report = { summary: `${risks[0].label} (could not measure it)`, lines: [], note: `Could not measure: ${String(error?.message ?? error).slice(0, 200)}` };
    return { clear: false, risk: risks[0], report };
  }
  const blocked = measured.find(({ report }) => report.clear !== true);
  if (blocked !== undefined) {
    return { clear: false, ...blocked };
  }
  const sudo = measured.find(({ risk }) => risk.sudo);
  if (sudo !== undefined) {
    return { clear: false, risk: sudo.risk, report: { ...sudo.report, note: `It runs with sudo, and I measured as you, so I can't be sure. ${sudo.report.note ?? ""}`.trim() } };
  }
  const moved = measured.find(({ risk }) => risk.afterMover);
  if (moved !== undefined) {
    return { clear: false, risk: moved.risk, report: { ...moved.report, note: "An earlier part of this line can move files or commits before this part runs, and I measured before anything ran." } };
  }
  if (mentions(command) > risks.length) {
    const { risk, report } = measured[0];
    return { clear: false, risk, report: { ...report, note: "The line also has a risky command I can't measure, for example inside $( ... ), bash -c or xargs." } };
  }
  return { clear: true, why: measured.map(({ report }) => report.summary).join("; ") };
}

// ---- What counts as risky -------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git"]);
// Commands that can move existing files or commits into the way of a later
// part of the line, which was measured before anything ran.
const MOVERS = new Set(["mv", "ln", "rsync", "ditto", "eval", "source", ".", "bash", "sh", "zsh", "xargs"]);
// git subcommands that leave files, the index, HEAD and branches alone.
const GIT_INERT = new Set(["status", "log", "diff", "show", "rev-parse", "rev-list", "merge-base", "ls-files", "ls-tree", "ls-remote", "describe", "fetch", "blame", "grep", "shortlog", "cat-file", "for-each-ref", "show-ref", "help", "version"]);
// Compound commands: what runs inside them may not run at all.
const OPENERS = new Set(["if", "while", "until", "for", "select", "case"]);
const CLOSERS = new Set(["fi", "done", "esac"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("~/")) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** The line cut at && || ; | & and newlines: each part, the operator before it, and where it starts. */
function splitLine(command) {
  const pieces = command.split(/(&&|\|\||[<>]&|&>>?|\|&|;|\||\n|&)/);
  const segments = [{ text: pieces[0], op: null, at: 0 }];
  let at = pieces[0].length;
  for (let i = 1; i < pieces.length; i += 2) {
    const op = pieces[i];
    if (op === ">&" || op === "<&" || op === "&>" || op === "&>>") {
      segments[segments.length - 1].text += op + pieces[i + 1]; // a redirection, as in 2>&1
    } else {
      segments.push({ text: pieces[i + 1], op: op === "|&" ? "|" : op, at: at + op.length });
    }
    at += op.length + pieces[i + 1].length;
  }
  return segments;
}

// A here-document operator and its delimiter: <<EOF, <<-'EOF', <<"EOF". Not <<<.
const HEREDOC = /(?:^|[^<])<<(-?)(?!<)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z0-9_.-]+))/g;

/** [start, end) of each here-document body in the line: text fed to a command, which may or may not run it. */
function heredocBodies(line) {
  const bodies = [];
  const pending = [];
  let bodyStart = null;
  let offset = 0;
  for (const text of line.split("\n")) {
    const start = offset;
    offset += text.length + 1;
    if (pending.length > 0) {
      bodyStart ??= start;
      if ((pending[0].tabs ? text.replace(/^\t+/, "") : text) === pending[0].tag) {
        bodies.push([bodyStart, offset]);
        bodyStart = null;
        pending.shift();
      }
      continue;
    }
    for (const m of text.matchAll(HEREDOC)) {
      pending.push({ tabs: m[1] === "-", tag: m[2] ?? m[3] ?? m[4] });
    }
  }
  if (bodyStart !== null) {
    bodies.push([bodyStart, offset]);
  }
  return bodies;
}

/** Every risky part of a shell command line, in order. */
function classify(command) {
  const line = command.replace(/\\\n/g, " ");
  const risks = [];
  let dir = null; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // what to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  // Variables set earlier on the line. vars holds settled lists: name -> value,
  // or null when the value can't be known or the assignment may not have run.
  // list holds the current && / || list: name -> { value, sure }, where sure
  // says the assignment ran whenever a later part of the line runs.
  let vars = new Map();
  let list = new Map();
  let listOps = []; // operators between the parts of the current list so far
  let listSafe = true; // every part of the current list so far is an assignment that can't fail
  let depth = 0; // inside if / for / while / case / { }
  let mover = false; // an earlier part can move files or commits
  const lookup = (name) => {
    if (list.has(name)) {
      return listOps.every((op) => op === "&&") ? list.get(name).value : null;
    }
    return vars.get(name);
  };
  const settle = (background) => {
    for (const [name, { value, sure }] of list) {
      vars.set(name, sure && !background ? value : null);
    }
    list = new Map();
    listOps = [];
    listSafe = true;
  };
  const bodies = heredocBodies(line);
  for (const { text: raw, op, at } of splitLine(line)) {
    // A here-document's lines are still checked for risky commands (it may be
    // fed to a shell), but what they set or cd to can't be trusted.
    const inBody = bodies.some(([start, end]) => at >= start && at < end);
    if (op === ";" || op === "\n" || op === "&") {
      settle(op === "&");
    } else if (op !== null) {
      listOps.push(op);
    }
    // Subshells and compound commands, outside here-document text, which may be
    // code in another language.
    const opens = inBody ? 0 : ((raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0);
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, "");
    const closes = inBody ? 0 : ((tail.match(/\)+\s*$/)?.[0].trim().length) ?? 0);
    for (let k = 0; k < opens; k += 1) {
      scopes.push({ dir, vars: new Map(vars), list: new Map(list) });
    }
    // Drop ( and ) of a subshell, and { and } of a group. A brace that is part
    // of a word, as in ${S} or {a,b}, stays.
    const words = lex(raw.trim().replace(/^(?:\(|\{(?=\s|$)|\s)+/, "").replace(/(?:\)|(?:^|\s)\}|\s)+$/, ""));
    if (!inBody) {
      depth += (raw.match(/(?:^|\s)\{(?=\s|$)/g) ?? []).length;
      const head = words.find((w) => !["then", "do", "else", "elif", "!"].includes(w.text))?.text;
      if (OPENERS.has(head)) {
        depth += 1;
      }
      if (CLOSERS.has(head)) {
        depth = Math.max(0, depth - 1);
      }
    }

    const assigned = assignmentsIn(words);
    if (assigned !== null) {
      const certain = depth === 0 && !inBody;
      const sure = certain && listSafe && listOps.every((o) => o === "&&");
      for (const word of assigned) {
        const { name, value } = assignedValue(word, lookup);
        list.set(name, { value: certain ? value : null, sure });
      }
      if (assigned.some((w) => /\$\(|`/.test(w.text))) {
        listSafe = false; // a $( ) in an assignment can fail, which skips what follows &&
      }
    } else if (words.length > 0) {
      listSafe = false;
      const risk = classifySegment(words, dir, pushed, lookup);
      forget(words, vars, list);
      if (risk?.cd !== undefined) {
        dir = inBody ? "-" : risk.cd; // a cd, pushd or popd moved the folder; "-" can't be measured
      } else if (risk?.mover) {
        mover = true;
      } else if (risk !== null) {
        risks.push({ ...risk, afterMover: mover });
        mover ||= risk.moves === true;
      }
    }

    if (!inBody) {
      depth = Math.max(0, depth - (raw.match(/(?:^|\s)\}(?=\s|$|[;)])/g) ?? []).length);
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      ({ dir, vars, list } = scopes.pop()); // a cd or assignment inside ( ... ) doesn't outlive it
    }
  }
  return risks;
}

/** The words of a part that only sets variables (`S=x`, `export S=x T=y`), or null. */
function assignmentsIn(words) {
  if (words.length === 0) {
    return null;
  }
  const exported = words[0].text === "export" && words[0].parts[0].q === "";
  const rest = exported ? words.slice(1) : words;
  if (!rest.every((w) => isAssignment(w) || (exported && VAR_NAME.test(w.text)))) {
    return null;
  }
  return rest.filter(isAssignment);
}

function isAssignment(word) {
  return word.parts[0].q === "" && ASSIGNMENT.test(word.parts[0].s);
}

/** { name, value } for one `NAME=value` word; value is null when it can't be known. */
function assignedValue(word, lookup) {
  const [first, ...more] = word.parts;
  const [prefix, name, append] = ASSIGNMENT.exec(first.s);
  const parts = [{ s: first.s.slice(prefix.length), q: "" }, ...more];
  if (parts.some((p) => p.q === "" && p.s.includes("~"))) {
    return { name, value: null }; // the shell expands ~ here; leave it unknown rather than guess
  }
  const expanded = expandWord({ parts }, lookup, { splits: false });
  if (expanded.why !== undefined) {
    return { name, value: null };
  }
  if (append === "+") {
    const before = lookup(name);
    return { name, value: typeof before === "string" ? before + expanded.text : null };
  }
  return { name, value: expanded.text };
}

/** Marks unknown any variable a part may set in a way not followed here (read, for, unset, eval ...). */
function forget(words, vars, list) {
  const names = new Set([...vars.keys(), ...list.keys()]);
  const all = ["eval", "source", "."].includes(words[0].text);
  for (const name of names) {
    const sets = all || words.some((w) => !w.text.startsWith("-") && (w.text === name || new RegExp(`^${name}(\\[|\\+?=|\\+\\+|--)`).test(w.text)));
    if (sets) {
      list.set(name, { value: null, sure: false });
    }
  }
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(["command", "exec", "env", "nohup", "time", "then", "do", "else", "!"]);

/** One part: a risk, { cd } for a folder change, { mover: true }, or null. */
function classifySegment(words, dir, pushed, lookup) {
  const w = words.slice();
  while (w.length > 0 && isAssignment(w[0])) {
    w.shift(); // leading VAR=value
  }
  let sudo = false;
  if (w[0]?.text === "sudo") {
    sudo = true;
    w.shift();
    while (w.length > 0 && w[0].text.startsWith("-")) {
      const option = w.shift().text;
      if (SUDO_VALUE_OPTIONS.has(option)) {
        w.shift();
      }
    }
  }
  while (w.length > 0 && (PREFIXES.has(w[0].text) || isAssignment(w[0]))) {
    w.shift();
  }
  if (w[0]?.text === "nice") {
    w.shift();
    if (w[0]?.text === "-n") {
      w.splice(0, 2);
    } else if (/^-\d+$/.test(w[0]?.text ?? "")) {
      w.shift();
    }
  }
  if (w.length === 0) {
    return null;
  }
  const [first, ...args] = w.map((word) => word.text);
  const path = (i) => pathOf(w[i + 1], lookup).path; // args[i], with $VAR filled in where known
  const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm
  if (cmd === "cd") {
    return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0] === undefined ? undefined : path(0)) };
  }
  if (cmd === "pushd") {
    pushed.push(dir);
    return { cd: joinDir(dir, args[0] === undefined ? undefined : path(0)) };
  }
  if (cmd === "popd") {
    return { cd: pushed.length > 0 ? pushed.pop() : "-" };
  }
  if (cmd === "rm" || cmd.endsWith("/rm")) {
    const flags = [];
    const targets = [];
    let operands = false;
    for (const word of w.slice(1)) {
      if (!operands && word.text === "--") {
        operands = true;
      } else if (!operands && word.text.startsWith("-") && word.text !== "-") {
        flags.push(word.text);
      } else {
        targets.push({ raw: word.text, ...pathOf(word, lookup) });
      }
    }
    const recursive = flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f)));
    const force = flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f")));
    if (recursive || force) {
      return { kind: "rm", label: `rm ${flags.join(" ")}`.trim(), targets, dir, sudo };
    }
  }
  if (cmd === "git") {
    // Git's own options come before the subcommand; -C moves where it runs.
    let gitDir = dir;
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) {
      if (args[i] === "-C" && i + 1 < args.length) {
        gitDir = joinDir(gitDir, path(i + 1));
        i += 2;
      } else if (args[i] === "-c" && i + 1 < args.length) {
        i += 2;
      } else {
        i += 1;
      }
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    const before = rest.indexOf("--") === -1 ? rest : rest.slice(0, rest.indexOf("--"));
    if (sub === "reset" && rest.includes("--hard")) {
      // With a commit, reset --hard also moves the branch and every file.
      const target = before.find((a) => !a.startsWith("-"));
      return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir, sudo, moves: target !== undefined && target !== "HEAD" };
    }
    if (sub === "clean") {
      return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir, sudo };
    }
    if (sub === "push" && rest.some((a) => a === "--force" || a === "-f" || a.startsWith("--force-with-lease") || /^\+/.test(a))) {
      return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir, sudo };
    }
    const stagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
    if ((sub === "checkout" || sub === "restore") && rest.includes(".") && !stagedOnly) {
      const source = restoreSource(sub, rest);
      return { kind: "git-checkout", sub, source, label: `git ${sub} -- .`, args: rest, dir: gitDir, sudo, moves: source !== null };
    }
    if (!gitIsInert(sub, rest)) {
      return { mover: true };
    }
  }
  if (MOVERS.has(cmd) || (cmd === "find" && args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a)))) {
    return { mover: true };
  }
  const joined = w.map((word) => word.text).join(" ");
  if (/\balembic\s+upgrade\b/.test(joined)) {
    return { kind: "migrate", tool: "alembic", label: "alembic upgrade", dir, sudo };
  }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) {
    return { kind: "migrate", tool: "rails", label: "db:migrate", dir, sudo };
  }
  if (/\bprisma\s+migrate\b/.test(joined)) {
    return { kind: "migrate", tool: "prisma", label: "prisma migrate", dir, sudo };
  }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) {
    return { kind: "migrate", tool: "django", label: "manage.py migrate", dir, sudo };
  }
  if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
    return { kind: "migrate", tool: "unknown", label: "migrate", dir, sudo };
  }
  return null;
}

/** Whether a git subcommand leaves files, the index, HEAD and branches as they are. */
function gitIsInert(sub, rest) {
  if (sub === undefined || GIT_INERT.has(sub)) {
    return true;
  }
  if (sub === "branch") {
    return !rest.some((a) => /^-[a-zA-Z]*[dDmMcCf]|^--(delete|move|copy|force)/.test(a));
  }
  if (sub === "stash" || sub === "worktree") {
    return rest[0] === "list";
  }
  if (sub === "remote") {
    return rest.every((a) => a === "-v" || a === "--verbose") || rest[0] === "show" || rest[0] === "get-url";
  }
  if (sub === "config") {
    return rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
  }
  return false;
}

/** What `git checkout X -- .` or `git restore --source X .` restores from, or null for the index. */
function restoreSource(sub, rest) {
  if (sub === "checkout") {
    const end = rest.indexOf("--");
    return (end === -1 ? rest : rest.slice(0, end)).find((a) => !a.startsWith("-") && a !== ".") ?? null;
  }
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--source" || rest[i] === "-s") {
      return rest[i + 1] ?? "?";
    }
    if (rest[i].startsWith("--source=")) {
      return rest[i].slice(9);
    }
    if (/^-s./.test(rest[i])) {
      return rest[i].slice(2);
    }
  }
  return null;
}

// Where a risky command can start anywhere in a line, including places the
// part-by-part reading can't see: inside $( ... ), bash -c "...", xargs.
const COMMAND_WORD = /(^|[^\w./-])((?:\\|\/[\w./-]*\/)?(?:rm|git))(?=\s)/g;
const MIGRATION_WORD = /\bmigrate\b|\balembic\s+upgrade\b/g;

/** How many risky commands the line mentions anywhere, nested ones included. */
function mentions(command) {
  const line = command.replace(/\\\n/g, " ");
  let count = (line.match(MIGRATION_WORD) ?? []).length;
  for (const m of line.matchAll(COMMAND_WORD)) {
    const rest = line.slice(m.index + m[1].length).split(/&&|\|\||[;|&\n`)]/)[0];
    const risk = classifySegment(lex(rest), null, [], () => undefined);
    if (risk?.kind !== undefined && risk.kind !== "migrate") {
      count += 1;
    }
  }
  return count;
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`;

async function resolveDir($, sessionCwd, dir) {
  if (dir === "-") {
    return null; // `cd -` depends on the shell's history
  }
  const run = await $.process.run(["bash", "-c", CD_SCRIPT, "blast-radius", dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

/**
 * Splits one part into shell words. Each word keeps its parts and how each was
 * quoted: q is "" (bare), '"' (double quotes) or "'" (literal: single quotes or
 * a backslash). Redirections and a # comment are left out.
 */
function lex(text) {
  const words = [];
  let parts = null;
  const add = (s, q) => {
    parts ??= [];
    const last = parts[parts.length - 1];
    if (last !== undefined && last.q === q) {
      last.s += s;
    } else {
      parts.push({ s, q });
    }
  };
  const end = () => {
    if (parts !== null) {
      words.push({ text: parts.map((p) => p.s).join(""), parts });
      parts = null;
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r") {
      end();
    } else if (c === "#" && parts === null) {
      break;
    } else if (c === "\\") {
      i += 1;
      if (i < text.length) {
        add(text[i], "'");
      }
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const stop = close === -1 ? text.length : close;
      add(text.slice(i + 1, stop), "'");
      i = stop;
    } else if (c === '"') {
      add("", '"');
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && '$`"\\'.includes(text[j + 1] ?? "")) {
          add(text[j + 1], "'");
          j += 2;
        } else {
          add(text[j], '"');
          j += 1;
        }
      }
      i = j;
    } else {
      add(c, "");
    }
  }
  end();
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word.parts[0].q === "" && /^(\d*|&)[<>]/.test(word.parts[0].s)) {
      if (/^(\d*|&)(>>?|>\||<>|<<?<?)$/.test(word.text)) {
        i += 1; // the redirection's target is the next word
      }
      continue;
    }
    kept.push(word);
  }
  return kept;
}

// $NAME or ${NAME}; anything else after a $ is caught as `other`.
const PARAM = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|([\s\S]?))/g;

/**
 * A word's text with $VAR set earlier on the line filled in: { text }, or
 * { why } when the shell would turn it into something this can't know.
 */
function expandWord(word, lookup, { splits = true } = {}) {
  let text = "";
  for (const [index, { s, q }] of word.parts.entries()) {
    if (q === "'") {
      text += s;
      continue;
    }
    if (s.includes("`")) {
      return { why: "it runs a command inside `...`" };
    }
    if (splits && q === "") {
      if (s.includes("**") || /[()]/.test(s)) {
        return { why: "zsh would expand the pattern in it" };
      }
      if (/\{[^{}]*(,|\.\.)[^{}]*\}/.test(s.replace(/\$\{[^}]*\}/g, ""))) {
        return { why: "the shell would expand the braces in it" };
      }
    }
    let why;
    const out = s.replace(PARAM, (match, braced, bare, other) => {
      const name = braced ?? bare;
      if (name === undefined) {
        const lastBare = q === "" && other === "" && index < word.parts.length - 1;
        if ((other === "" && !lastBare) || /\s/.test(other)) {
          return match; // a lone $ is just a dollar sign
        }
        why ??= `${match} is not a variable set on this line`;
        return match;
      }
      const value = lookup(name);
      if (value === undefined) {
        why ??= `$${name} is set outside this command`;
      } else if (value === null) {
        why ??= `$${name} may not hold the value set on this line`;
      } else if (splits && q === "" && /\s/.test(value)) {
        why ??= `$${name} has spaces, so the shell may split it`;
      } else {
        return value;
      }
      return match;
    });
    if (why !== undefined) {
      return { why };
    }
    text += out;
  }
  return { text };
}

/** A path word as the shell would hand it to rm or cd: { path, why }, why null when it's known. */
function pathOf(word, lookup) {
  const expanded = expandWord(word, lookup);
  if (expanded.why !== undefined) {
    return { path: word.text, why: expanded.why };
  }
  const first = word.parts[0];
  const bareTilde = first.q === "" && first.s.startsWith("~");
  if (bareTilde && !/^~(\/|$)/.test(first.s)) {
    return { path: word.text, why: `${first.s.split("/")[0]} names another home folder` };
  }
  if (!bareTilde && expanded.text.startsWith("~")) {
    return { path: `./${expanded.text}`, why: null }; // a quoted or stored ~ is a plain name
  }
  return { path: expanded.text, why: null };
}

// ---- Measuring the blast radius -------------------------------------------

/**
 * { summary, lines, note, clear } for the pane. clear is true only when the
 * measurement is complete and shows nothing at risk. Never throws: a failed
 * read is said, not hidden.
 */
async function measure($, risk, cwd) {
  try {
    if (risk.kind === "rm") {
      return await measureRm($, risk, cwd);
    }
    if (risk.kind === "migrate") {
      return await measureMigrations($, risk, cwd);
    }
    return await measureGit($, risk, cwd);
  } catch (error) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${String(error?.message ?? error).slice(0, 200)}` };
  }
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
// First line: files bytes paths complete temp. complete is 0 when find couldn't
// read everything; temp is 1 when every path is inside Claude Code's per-user
// temp folder, /tmp/claude-<uid> (/private/tmp/claude-<uid> on macOS).
const RM_SCRIPT = `
shopt -s nullglob dotglob
unset CDPATH
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0 1 0"; exit 0; fi
root=""
r="/tmp/claude-$(id -u)"
if [[ -d "$r" && ! -L "$r" && -O "$r" ]]; then root=$(cd -P -- "$r" 2>/dev/null && pwd -P); fi
temp=0
if [[ -n "$root" ]]; then
  temp=1
  for p in "\${paths[@]}"; do
    real=""
    if [[ -d "$p" ]]; then
      real=$(cd -P -- "$p" 2>/dev/null && pwd -P)
    else
      parent=$(cd -P -- "$(dirname -- "$p")" 2>/dev/null && pwd -P) && real="\${parent%/}/$(basename -- "$p")"
    fi
    if [[ -z "$real" || "$real" != "$root"/?* ]]; then temp=0; break; fi
  done
fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" ! -type d 2>/dev/null | wc -l | tr -d ' ')
complete=1
if (( files == 0 )); then find "\${paths[@]}" >/dev/null 2>&1 || complete=0; fi
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]} $complete $temp"
find "\${paths[@]}" ! -type d 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureRm($, risk, cwd) {
  if (risk.targets.length === 0) {
    return { summary: "rm with no paths", lines: [], note: "No paths to expand.", clear: true };
  }
  const unknown = risk.targets.filter((t) => t.why !== null);
  const known = risk.targets.filter((t) => t.why === null);
  const named = risk.targets.map((t) => t.raw).join(" ");
  const run = await $.process.run(["bash", "-c", RM_SCRIPT, "blast-radius", ...known.map((t) => t.path)], { cwd, timeoutMs: 15000 });
  const [head, ...rest] = run.stdout.split("\n").filter((l) => l !== "");
  if (run.exitCode !== 0 || !/^\d+ \d+ \d+ [01] [01]$/.test(head ?? "")) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Measuring failed: ${run.stderr.trim().slice(0, 200)}` };
  }
  const [files, bytes, found, complete, temp] = head.split(" ").map(Number);
  const whatever = unknown.length === 0 ? "" : `, plus whatever ${unknown.map((t) => t.raw).join(" ")} names`;
  const unknownNote = unknown.length === 0 ? "" : ` I can't tell what ${unknown[0].raw} names: ${unknown[0].why}.`;
  if (!found) {
    return {
      summary: unknown.length === 0 ? `delete nothing: no file matches ${named}` : `delete whatever ${unknown.map((t) => t.raw).join(" ")} names`,
      lines: [],
      note: unknown.length === 0 ? "The paths don't exist, so rm has nothing to remove." : unknownNote.trim(),
      clear: unknown.length === 0,
    };
  }
  const where = temp === 1 ? " in Claude Code's temp folder" : "";
  if (!files) {
    return {
      summary: `delete ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}${where}${whatever}`,
      lines: [],
      note: `Paths: ${named}.${unknownNote}`,
      clear: unknown.length === 0 && (complete === 1 || temp === 1),
    };
  }
  return {
    summary: `delete ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})${where}${whatever}`,
    lines: rest.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${named}.${unknownNote}`,
    clear: unknown.length === 0 && temp === 1,
  };
}

async function measureGit($, risk, cwd) {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk, cwd);
  }
  if (risk.kind === "git-clean") {
    return await measureClean($, risk, cwd);
  }
  const status = await $.process.run(["git", "status", "--porcelain"], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  if (risk.kind === "git-reset") {
    return await measureReset($, risk, cwd, rows);
  }
  // checkout -- . and restore . put back the index's copy, so only unstaged
  // changes go. From a commit, or with --staged too, staged changes go as well.
  const both = risk.source !== null || risk.args.includes("--staged") || risk.args.includes("-S");
  const lost = both ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run(["git", "diff", "--shortstat", both ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  const note = risk.source !== null
    ? `It restores from ${risk.source}, which can also overwrite untracked files, so it's held even when nothing is listed.`
    : stat.stdout.trim() !== "" ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : "From git status --porcelain.";
  return {
    summary: lost.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note,
    clear: risk.source === null && lost.length === 0,
  };
}

// Prints, from NUL-separated paths on stdin, the ones that exist.
const EXISTS_SCRIPT = `while IFS= read -r -d '' p; do if [[ -e "$p" || -L "$p" ]]; then printf '%s\\n' "$p"; fi; done; true`;

async function measureReset($, risk, cwd, rows) {
  const git = (...args) => $.process.run(["git", ...args], { cwd, timeoutMs: 15000 });
  const end = risk.args.indexOf("--");
  const target = (end === -1 ? risk.args : risk.args.slice(0, end)).find((a) => !a.startsWith("-"));
  const changes = rows.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${rows.length} ${rows.length === 1 ? "file" : "files"}`;
  const changed = rows.map((l) => `${l.slice(0, 2)} ${l.slice(3)}`);
  const stat = await git("diff", "--shortstat", "HEAD");
  const statNote = stat.stdout.trim() !== "" ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : "From git status --porcelain.";
  const listed = (all) => ({ lines: all.slice(0, LIST_MAX), more: Math.max(0, all.length - LIST_MAX) });
  if (target === undefined) {
    return { summary: changes, ...listed(changed), note: statNote, clear: rows.length === 0 };
  }
  const head = await git("rev-parse", "--verify", "--quiet", "HEAD^{commit}");
  const to = await git("rev-parse", "--verify", "--quiet", `${target}^{commit}`);
  if (head.exitCode !== 0 || to.exitCode !== 0) {
    return { summary: `${changes}, and move to ${target}`, ...listed(changed), note: `Couldn't find ${target}, so I can't tell which commits it would drop.` };
  }
  const from = head.stdout.trim();
  const onto = to.stdout.trim();
  if (onto === from) {
    return { summary: changes, ...listed(changed), note: statNote, clear: rows.length === 0 };
  }
  // reset --hard <commit> also moves the branch, dropping the commits <commit>
  // doesn't have, and writes <commit>'s files over untracked ones in the way.
  const log = await git("log", "--oneline", "--no-decorate", `${onto}..${from}`);
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  const added = await git("-c", "core.quotepath=off", "diff", "--name-only", "-z", "--no-renames", "--no-relative", "--diff-filter=A", from, onto);
  const top = await git("rev-parse", "--show-toplevel");
  if (log.exitCode !== 0 || added.exitCode !== 0 || top.exitCode !== 0) {
    return { summary: `${changes}, and move to ${target}`, ...listed(changed), note: `Couldn't compare HEAD with ${target}.` };
  }
  const exists = await $.process.run(["bash", "-c", EXISTS_SCRIPT], { cwd: top.stdout.trim(), stdin: added.stdout, timeoutMs: 15000 });
  const inWay = exists.stdout.split("\n").filter((l) => l !== "");
  const parts = [];
  if (rows.length > 0) {
    parts.push(changes);
  }
  if (dropped.length > 0) {
    parts.push(`drop ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"} that ${target} doesn't have`);
  }
  if (inWay.length > 0) {
    parts.push(`overwrite ${inWay.length} untracked ${inWay.length === 1 ? "file" : "files"}`);
  }
  return {
    summary: parts.length === 0 ? `move to ${target}: discard nothing and drop no commits` : parts.join(", "),
    ...listed([...changed, ...dropped.map((l) => `commit ${l}`), ...inWay.map((p) => `untracked ${p}`)]),
    note: `${dropped.length > 0 ? "Dropped commits stay in the reflog for a while. " : ""}${statNote}`,
    clear: parts.length === 0,
  };
}

async function measureClean($, risk, cwd) {
  const flags = [];
  const paths = [];
  let forces = 0;
  for (let i = 0; i < risk.args.length; i += 1) {
    const a = risk.args[i];
    if (a === "--") {
      paths.push(...risk.args.slice(i + 1));
      break;
    }
    if (a === "-e" || a === "--exclude") {
      flags.push(a, risk.args[i + 1] ?? "");
      i += 1;
    } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
      flags.push(a);
    } else if (a === "--force") {
      forces += 1;
    } else if (/^-[a-zA-Z]+$/.test(a)) {
      forces += (a.match(/f/g) ?? []).length;
      const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
      if (kept !== "-") {
        flags.push(kept);
      }
    } else if (!a.startsWith("-")) {
      paths.push(a);
    }
  }
  // -f twice also removes nested git repositories, and a dry run only lists them with -f twice.
  const force = forces > 1 ? ["-f", "-f"] : [];
  const run = await $.process.run(["git", "clean", "-n", ...force, ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
  if (run.exitCode !== 0) {
    return { summary: "git clean (could not dry-run it)", lines: [], note: run.stderr.trim().slice(0, 200) };
  }
  const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13));
  return {
    summary: gone.length === 0 ? "remove nothing: no untracked files match" : `remove ${gone.length} untracked ${gone.length === 1 ? "path" : "paths"}`,
    lines: gone.slice(0, LIST_MAX),
    more: Math.max(0, gone.length - LIST_MAX),
    note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    clear: gone.length === 0,
  };
}

// Push options that touch more than the one branch measured here.
const WIDE_PUSH = new Set(["--all", "--mirror", "--tags", "--delete", "--prune", "--branches"]);

async function measurePush($, risk, cwd) {
  const flags = risk.args.filter((a) => a.startsWith("-"));
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  const wide = positional.length > 2 || spec.startsWith(":") || flags.some((f) => WIDE_PUSH.has(f) || /^-[a-zA-Z]*d/.test(f));
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (!branch) {
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  } else if (branch === "HEAD") {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  const ref = `${remote}/${branch}`;
  const known = await $.process.run(["git", "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
  }
  const log = await $.process.run(["git", "log", "--oneline", "--no-decorate", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").filter((l) => l !== "");
  let note = `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`;
  let fresh = false;
  if (!wide && log.exitCode === 0 && dropped.length === 0) {
    // Nothing dropped as of the last fetch. Before running it unasked, check
    // that the branch on the remote hasn't moved since.
    let live = null;
    try {
      live = await $.process.run(["git", "ls-remote", "--exit-code", remote, `refs/heads/${branch}`], { cwd, timeoutMs: 15000, env: { GIT_TERMINAL_PROMPT: "0" } });
    } catch {
      live = null;
    }
    const tip = live?.stdout.split("\n").map((l) => l.split("\t")).find(([, name]) => name === `refs/heads/${branch}`)?.[0];
    fresh = live?.exitCode === 2 || (live?.exitCode === 0 && tip === known.stdout.trim());
    if (!fresh) {
      note = live?.exitCode === 0
        ? `${branch} on ${remote} has moved since the last fetch, so the push may drop commits not listed here. Run git fetch first.`
        : `Couldn't reach ${remote} to check that ${branch} hasn't moved since the last fetch.`;
    }
  } else if (wide) {
    note = `${note} It pushes more than this one branch, so it's held either way.`;
  }
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note,
    clear: !wide && dropped.length === 0 && fresh,
  };
}

const MIGRATION_LISTERS = {
  django: { argv: ["python3", "manage.py", "showmigrations", "--plan"], pending: (l) => l.startsWith("[ ]"), strip: (l) => l.slice(4) },
  alembic: { argv: ["alembic", "history", "-r", "current:head"], pending: (l) => l.includes("->"), strip: (l) => l },
  rails: { argv: ["bin/rails", "db:migrate:status"], pending: (l) => /^\s*down\b/.test(l), strip: (l) => l.trim() },
  prisma: { argv: ["npx", "--no-install", "prisma", "migrate", "status"], pending: (l) => /^\s{2}\S/.test(l), strip: (l) => l.trim() },
};

// Migrations are always held, even with nothing pending: `prisma migrate reset`
// and similar commands change the database without a pending migration.
async function measureMigrations($, risk, cwd) {
  const lister = MIGRATION_LISTERS[risk.tool];
  if (lister === undefined) {
    return { summary: "run migrations", lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." };
  }
  let run;
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 });
  } catch (error) {
    run = { exitCode: -1, stdout: "", stderr: String(error?.message ?? error) };
  }
  if (run.exitCode !== 0) {
    return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${lister.argv.join(" ")} failed).` };
  }
  const pending = run.stdout.split("\n").filter(lister.pending).map(lister.strip);
  return {
    summary: pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${pending.length === 1 ? "migration" : "migrations"}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(" ")}.`,
  };
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report) {
  return Math.min(24, 9 + report.lines.length + (report.more ? 1 : 0));
}

function draw(t, state) {
  const { Box, Text, Button } = t;
  const { report } = state;
  const list = report.lines.map((line, i) => Text({ key: `l${i}`, children: `  ${line}`, wrap: "truncate-end" }));
  if (report.more) {
    list.push(Text({ key: "more", dimColor: true, children: `  + ${report.more} more` }));
  }
  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "yellow",
    paddingX: 1,
    children: [
      Text({ key: "title", bold: true, color: "yellow", children: `⚠ Blast Radius · ${state.risk.label}` }),
      Text({ key: "cmd", children: [Text({ dimColor: true, children: "Command  " }), Text({ bold: true, children: state.command })], wrap: "truncate-end" }),
      Text({ key: "sum", children: [Text({ dimColor: true, children: "Would    " }), Text({ color: "red", bold: true, children: report.summary })] }),
      Box({ key: "list", flexDirection: "column", marginTop: 1, children: list }),
      report.note ? Text({ key: "note", dimColor: true, italic: true, children: report.note, wrap: "wrap" }) : null,
      Box({
        key: "buttons",
        marginTop: 1,
        gap: 2,
        children: [
          Button({ key: "proceed", label: "Proceed", hotkey: "1", plain: true, onPress: decide("proceed") }),
          Button({ key: "cancel", label: "Cancel", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          Text({ key: "hint", dimColor: true, children: "Claude is waiting on your answer" }),
        ],
      }),
    ],
  });
}
