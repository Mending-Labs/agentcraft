// A strict recogniser for PowerShell scripts that only read, used by auto mode for the lead (whose
// inspection scripts, e.g. `Get-ChildItem ... | ForEach-Object { $f = $_; ... }`, the general policy
// cannot verify: a `$f = $_` assignment reads to it as a command named by a variable).
//
// It answers "provably read-only" or gives the reason it is not. Allowlist only:
//   - every command in command position is a read-only cmdlet (or alias), or git with a read
//     subcommand; language keywords are fine; ForEach-Object only with script blocks
//   - no method calls, no `::` (static .NET calls), no `&` / dot-sourcing, no redirection, no
//     backticks, no here-strings, no `$(...)` inside double quotes, no `${...}`
//   - variables: only `$_` / `$PSItem` / `$true` / `$false` / `$null` and those the script assigns
//     itself (so `$env:`, `$HOME`, `$PROFILE`... are refused: they would point the reads elsewhere),
//     inside double-quoted strings too
//   - every literal absolute path is inside one of `roots` (repo, workspaces), or anywhere else that
//     is not sensitive: not a whole drive, not the home folder or a folder holding it, not AppData,
//     not a dot-folder of the home (.ssh, .aws, .codex, .agentcraft...), not a key or secrets file
//     (*.pem, *.key, id_rsa, .env, secrets*.json, credentials*, *.kdbx...); no UNC, `~`,
//     drive-relative (`C:x`) or provider (`Env:`, `HKLM:`) paths, no `..` walking up
// Anything else is "not proven": the caller keeps asking the user.
import os from 'node:os';
import path from 'node:path';
import { isInsideOrEqual } from './util/fsx.js';

const SENSITIVE_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.env(\..*)?|.*\.(pem|key|pfx|p12|kdbx|keystore|jks|ovpn)|secrets?([._-].*)?\.(json|ya?ml|toml|txt)|credentials?(\..*)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$/i;

/** Why reading `p` (outside the repo and workspaces) would be sensitive, or undefined. */
export function sensitivePath(p: string): string | undefined {
  const abs = path.resolve(p);
  const home = os.homedir();
  if (path.parse(abs).root.replace(/[\\/]+$/, '') === abs.replace(/[\\/]+$/, '')) return 'a whole drive';
  if (isInsideOrEqual(home, abs)) return 'the home folder (or a folder holding it)';
  for (const d of [process.env.APPDATA, process.env.LOCALAPPDATA].filter((x): x is string => !!x)) if (isInsideOrEqual(abs, d)) return 'AppData';
  if (isInsideOrEqual(abs, home)) {
    const first = path.relative(home, abs).split(/[\\/]/)[0] ?? '';
    if (first.startsWith('.') || first.toLowerCase() === 'appdata') return `${first} in the home folder`;
  }
  if (abs.split(/[\\/]/).some((seg) => SENSITIVE_NAME.test(seg))) return 'a key or secrets file';
  return undefined;
}

const READ_CMDS = new Set([
  'get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi', 'get-itemproperty', 'gp', 'test-path', 'join-path', 'split-path',
  'resolve-path', 'rvpa', 'get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'select-object', 'select',
  'where-object', 'where', '?', 'foreach-object', '%', 'sort-object', 'sort', 'group-object', 'group',
  'measure-object', 'measure', 'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'fw', 'out-string',
  'out-host', 'write-output', 'echo', 'write', 'write-host', 'convertto-json', 'convertfrom-json', 'get-date',
  'get-location', 'pwd', 'gl', 'get-filehash', 'compare-object', 'compare', 'get-unique', 'select-xml',
]);
const KEYWORDS = new Set(['if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch', 'return', 'break', 'continue', 'try', 'catch', 'finally']);
const GIT_READ_SUBS = new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'ls-files', 'describe', 'rev-list', 'shortlog', 'blame', 'cat-file', 'ls-tree', 'merge-base', 'for-each-ref', 'show-ref', 'grep', 'name-rev', 'check-ignore', 'count-objects', 'whatchanged', 'cherry', 'range-diff', 'show-branch', 'version']);
const GIT_VALUE_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace']);
/** branch / tag listing modes (a name after them is a pattern or a commit, not a new ref) */
const GIT_LIST_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current', '-v', '-vv', '--verbose', '-n']);
const GIT_REF_CHANGES: Record<string, RegExp> = {
  branch: /^(-[dDmMcCfu]|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track|create-reflog))$/,
  // for tag, -a is --annotate (it creates one)
  tag: /^(-[dasfmFu]|--(delete|annotate|sign|force|message|file|local-user|create-reflog))$/,
};
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);
const GIT_CONFIG_WRITES = /^(--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)|-e)$/;

/** Why the git call whose arguments start at `tokens[from]` is not a plain read. */
function gitProblem(tokens: string[], from: number): string | undefined {
  let end = from;
  while (end < tokens.length && !CURL_STOP.has(tokens[end]!)) end++;
  const args = tokens.slice(from, end);
  // -c core.pager=..., aliases, --exec-path: git would run a command of the script's choosing
  if (args.some((a) => a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path'))) return 'git -c / --exec-path (git could run a command)';
  if (args.some((a) => a === '--output' || a === '-O' || a.startsWith('--open-files-in-pager') || a === '--ext-diff')) return 'git writing a file or starting a program';
  let j = 0;
  while (j < args.length && args[j]!.startsWith('-')) j += GIT_VALUE_OPTS.has(args[j]!) ? 2 : 1;
  const sub = (args[j] ?? '').toLowerCase();
  const rest = args.slice(j + 1);
  const next = (rest[0] ?? '').toLowerCase();
  if (GIT_READ_SUBS.has(sub)) return undefined;
  if (sub === 'worktree' && next === 'list') return undefined;
  if (sub === 'remote' && (next === '' || next === '-v' || next === 'get-url' || next === 'show')) return undefined;
  if (sub === 'stash' && (next === 'list' || next === 'show')) return undefined;
  if (sub === 'reflog' && (next === '' || next === 'show' || next.startsWith('-'))) return undefined;
  if (sub === 'branch' || sub === 'tag') {
    const changes = GIT_REF_CHANGES[sub]!;
    const change = rest.find((a) => changes.test(a));
    if (change) return `git ${sub} ${change} changes refs`;
    const listing = sub === 'branch' ? rest.length === 0 || rest.some((a) => GIT_LIST_FLAGS.has(a)) : rest.length === 0 || rest.some((a) => GIT_LIST_FLAGS.has(a) && a !== '-a');
    if (listing) return undefined;
    return `git ${sub} with a name creates a ${sub}`;
  }
  if (sub === 'config') {
    if (rest.some((a) => GIT_CONFIG_WRITES.test(a))) return 'git config changing a setting';
    if (rest.some((a) => GIT_CONFIG_READS.has(a))) return undefined;
    return 'git config without --get / --list may set a value';
  }
  return `git ${sub || '(no subcommand)'} may change things`;
}
const BUILTIN_VARS = new Set(['_', 'psitem', 'true', 'false', 'null', 'matches', 'lastexitcode']);

/** curl flags that change nothing (single letters may be combined: -sSL). */
const CURL_FLAGS = new Set(['--silent', '--show-error', '--location', '--head', '--include', '--verbose', '--insecure', '--fail', '--fail-with-body', '--compressed', '--http1.1', '--http2', '--no-progress-meter', '--globoff']);
const CURL_LETTERS = new Set('sSLIivkfg'.split(''));
/** ... and the ones taking a value that changes nothing either (the value is skipped). */
const CURL_VALUE_FLAGS = new Set(['-w', '--write-out', '-m', '--max-time', '--connect-timeout', '-H', '--header', '-A', '--user-agent', '-e', '--referer', '--retry', '-r', '--range']);
const DISCARD = new Set(['nul', '-', '$null', '/dev/null']);
const CURL_STOP = new Set([';', '|', '}', ')', '&&', '||']);

/** Why the curl call starting at `tokens[from]` is not a plain read (GET/HEAD, nothing sent, output discarded or shown). */
function curlProblem(tokens: string[], from: number): string | undefined {
  for (let j = from; j < tokens.length && !CURL_STOP.has(tokens[j]!); j++) {
    const a = tokens[j]!;
    if (!a.startsWith('-')) continue; // the URL
    const next = (tokens[j + 1] ?? '').toLowerCase();
    if (a === '-o' || a === '--output') {
      if (!DISCARD.has(next)) return 'curl writing a file (-o)';
      j++;
    } else if (a === '-D' || a === '--dump-header') {
      if (next !== '-') return 'curl writing headers to a file (-D)';
      j++;
    } else if (a === '-X' || a === '--request') {
      if (next !== 'get' && next !== 'head') return `curl ${a} ${tokens[j + 1] ?? ''} (only GET and HEAD are reads)`;
      j++;
    } else if (CURL_VALUE_FLAGS.has(a)) {
      j++;
    } else if (CURL_FLAGS.has(a) || (/^-[A-Za-z]+$/.test(a) && [...a.slice(1)].every((c) => CURL_LETTERS.has(c)))) {
      continue;
    } else {
      return `curl ${a} (it may send data or write files)`;
    }
  }
  return undefined;
}

/** Why `script` is not provably read-only (undefined: it is). */
export function psReadOnlyProblem(script: string, roots: string[]): string | undefined {
  if (/@['"]/.test(script)) return 'a here-string';
  // strings: single-quoted are literal; double-quoted expand variables (checked) and $(...) (refused)
  const strings: string[] = [];
  const expanding: string[] = [];
  let bad: string | undefined;
  const code = script.replace(/'(?:[^']|'')*'|"(?:[^"`]|`.)*"/g, (s) => {
    if (s.startsWith('"')) {
      if (/\$[({]/.test(s)) bad = 'a subexpression inside a double-quoted string';
      expanding.push(s.slice(1, -1));
      strings.push(s.slice(1, -1));
    } else {
      strings.push(s.slice(1, -1).replace(/''/g, "'"));
    }
    return ' S ';
  });
  if (bad) return bad;
  if (/['"]/.test(code)) return 'an unterminated string';
  if (code.includes('`')) return 'a backtick escape';
  if (code.includes('::')) return 'a static .NET call';
  if (/\.\s*[A-Za-z_]\w*\s*\(/.test(code)) return 'a method call';
  if (/(^|[^&])&(?!&)/.test(code)) return 'the & call operator';
  if (/(^|[;{(|])\s*\.\s+\S/.test(code)) return 'dot-sourcing';
  if (code.includes('>')) return 'a redirection';
  if (code.includes('${')) return 'a ${...} variable';
  if (/\.\.[\\/]/.test(code) || strings.some((s) => /(^|[\\/])\.\.([\\/]|$)/.test(s))) return 'a path walking up with ..';

  // variables: assigned by the script (`$x =`, `foreach ($x in`) or built in
  const assigned = new Set<string>();
  for (const m of code.matchAll(/\$([A-Za-z_]\w*)\s*[+\-*/]?=(?!=)/g)) assigned.add(m[1]!.toLowerCase());
  for (const m of code.matchAll(/\bforeach\s*\(\s*\$([A-Za-z_]\w*)\s+in\b/gi)) assigned.add(m[1]!.toLowerCase());
  for (const m of [code, ...expanding].join(' ').matchAll(/\$([A-Za-z_]\w*)(:?)/g)) {
    const name = m[1]!.toLowerCase();
    if (m[2]) return `the scoped variable $${m[1]}:`;
    if (!BUILTIN_VARS.has(name) && !assigned.has(name)) return `the variable $${m[1]} (not set by the script)`;
  }

  // literal paths, in strings and bare words
  const candidates = [...strings, ...code.split(/[\s,;|(){}=]+/)];
  for (const c of candidates) {
    const w = c.trim();
    if (w.startsWith('\\\\')) return `the UNC path ${w}`;
    if (w.startsWith('~')) return 'a path in the home folder (~)';
    if (/^[A-Za-z]:(?![\\/])/.test(w)) return `the drive-relative path ${w}`;
    if (/^(env|hklm|hkcu|hkey_\w+|registry|cert|function|variable|alias|wsman)::?/i.test(w)) return `the provider path ${w}`;
    // a drive letter on its own (not the "s:/" of "https://")
    for (const m of w.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^,;|]*/g)) {
      const p = m[0].trim();
      // key and secrets files ask even inside the repo; elsewhere, only sensitive places ask
      if (p.split(/[\\/]/).some((seg) => SENSITIVE_NAME.test(seg))) return `the path ${p} (a key or secrets file)`;
      if (roots.some((r) => isInsideOrEqual(path.resolve(p), r))) continue;
      const why = sensitivePath(p);
      if (why) return `the path ${p} (${why})`;
    }
  }

  // commands: walk the tokens, tracking command position and `@{...}` hashtables
  const tokens = code.match(/&&|\|\||@\{|[;|{}(),=]|[^\s;|{}(),=]+/g) ?? [];
  const blocks: Array<'block' | 'hash'> = [];
  let cmdPos = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const inHash = blocks[blocks.length - 1] === 'hash';
    if (t === '@{' || t === '{') {
      blocks.push(t === '@{' ? 'hash' : 'block');
      cmdPos = true;
      continue;
    }
    if (t === '}') {
      blocks.pop();
      cmdPos = false;
      continue;
    }
    // after a separator or `(` a command may start
    if (t === ';' || t === '|' || t === '(' || t === '&&' || t === '||') {
      cmdPos = true;
      continue;
    }
    // ... and after the `=` of an assignment (`$x =`, `$x +=`) or a hashtable key, but not after an
    // option's `=` (`--untracked-files=no`)
    if (t === '=') {
      const prev = tokens[i - 1] ?? '';
      const target = /^[+\-*/%]$/.test(prev) ? (tokens[i - 2] ?? '') : prev;
      cmdPos = target.startsWith('$') || inHash;
      continue;
    }
    if (t === ')' || t === ',') {
      cmdPos = false;
      continue;
    }
    // `foreach ($x in <command>)`: what follows `in` runs
    if (t.toLowerCase() === 'in') {
      cmdPos = true;
      continue;
    }
    if (!cmdPos) continue;
    cmdPos = false;
    const lower = t.toLowerCase();
    if (inHash && tokens[i + 1] === '=') continue; // a hashtable key
    if (t === 'S' || /^[$@[\d!-]/.test(t)) {
      // a value, a cast, a negation (`-not`, `!`): a command, if any, comes after the negation
      if (t.startsWith('-') || t === '!') cmdPos = true;
      continue;
    }
    if (KEYWORDS.has(lower)) {
      cmdPos = ['else', 'try', 'finally', 'do', 'return'].includes(lower);
      continue;
    }
    if (lower === 'git' || lower === 'git.exe') {
      const problem = gitProblem(tokens, i + 1);
      if (problem) return problem;
      continue;
    }
    if (lower === 'curl' || lower === 'curl.exe') {
      const problem = curlProblem(tokens, i + 1);
      if (problem) return problem;
      continue;
    }
    if (!READ_CMDS.has(lower)) return `the command ${t}`;
    // `ForEach-Object Name` / `-MemberName` calls that method on every item: only script blocks
    if (lower === 'foreach-object' || lower === '%') {
      let j = i + 1;
      while (/^-(process|begin|end)$/i.test(tokens[j] ?? '')) j++;
      if (tokens[j] !== '{') return `${t} without a script block`;
    }
  }
  return undefined;
}
