/** Escape a value for use *inside* a single-quoted shell string. */
export function shellQuote(v: string): string {
  return v.replace(/'/g, "'\\''");
}

// Characters that are safe to leave bare in a shell command. Anything else
// (spaces, quotes, $, ;, &, |, backticks, globs) has to be quoted or the
// shell will split, expand or execute part of the argument.
//
// `&` and `#` used to be in this set, which broke the commonest export there
// is: `curl http://host/a?x=1&y=2` pasted into a shell runs curl on `?x=1`
// in the BACKGROUND and reads `y=2` as a variable assignment, so every query
// parameter after the first vanishes without a word. `?`, `[`, `]` are globs
// and `~` expands to a home directory, so they are gone too — quoting a URL
// that did not strictly need it costs nothing.
const SAFE_BARE = /^[A-Za-z0-9_.:/=@,+%-]+$/;

/**
 * Render a complete shell argument, quoting only when it is actually needed.
 * Generated commands are meant to be pasted into a terminal, so an
 * unquoted value containing a space or a quote does not merely look wrong —
 * it runs as something other than what the request says.
 */
export function shellArg(v: string): string {
  if (v === "") return "''";
  return SAFE_BARE.test(v) ? v : `'${shellQuote(v)}'`;
}
