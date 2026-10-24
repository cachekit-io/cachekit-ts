import { generateKey, generateParamsHash } from './key-generator.js';

/**
 * A call is memoised only within cachekit-py's budget: at most this many
 * arguments, holding at most MEMO_MAX_STRING_LENGTH UTF-16 code units across
 * their strings.
 */
const MEMO_MAX_ARGS = 8;
const MEMO_MAX_STRING_LENGTH = 256;
/** Entries per wrapped function. A full memo is emptied, so a hit writes nothing. */
const MEMO_MAX_ENTRIES = 1024;
/**
 * The longest delay setTimeout takes, 2^31 - 1 ms (about 24.8 days); it runs a
 * longer one at once. A memo under a longer ttl empties this soon, never later.
 */
const MEMO_MAX_WINDOW_MS = 2 ** 31 - 1;

/**
 * Runs `callback` once, `ms` milliseconds from now, without holding the process
 * open, and returns a function that cancels it.
 */
export type UnrefTimeout = (callback: () => void, ms: number) => () => void;

/**
 * Cancels the pending timer of a memo collected before it fired. The timer holds
 * its memo weakly, so a function wrapped and dropped per request would otherwise
 * leave a timer behind for up to a ttl. Built on first use, where a memo is kept.
 */
let timersOfCollectedMemos: FinalizationRegistry<() => void> | undefined;

/** The argument types the memo takes. */
type MemoArg = string | number | boolean | null | undefined;

/**
 * The auto-mode keys of one wrapped function, `{namespace}:{hash}` exactly as
 * generateKey builds them. The `{namespace}:` prefix is the part that does not
 * depend on the arguments, so it is built once and rebuilt only when the
 * namespace changes: wrap() reads the namespace from its options on every call.
 *
 * Given a timer, it also remembers the key of each call whose every argument
 * is a string, number, boolean, null or undefined, within the budget above, so
 * a repeat call skips normalisation, MessagePack and BLAKE2b. Two calls share
 * an entry only when their arguments have the same types and values, and then
 * they pack to the same MessagePack, so the memo returns the key the full path
 * would. The one exception is 0 and -0, which share an entry and a key. NaN
 * never enters the memo: its bit pattern reaches the key, and NaNs with
 * different bits compare equal. Any other argument, or a call past the budget,
 * takes the full path every time.
 *
 * The memo holds copies of those arguments (see ownString), so a cache that
 * encrypts keeps none, and forget() empties it whenever the cache removes
 * entries on request. It also empties itself one ttl, the wrap's, after its
 * first entry, so it holds an argument no longer than L1 serves a value stored
 * with that ttl, even when a removal on another instance never reaches this
 * one. A timer empties it then, though the function is not called again: late
 * only by as long as the event loop is busy or the process is suspended (Node.js
 * timers keep the monotonic clock, which stops while a host sleeps). A call at or
 * past that time that comes before the timer runs empties it first, so no entry
 * is served past its ttl. A call under another ttl empties it too, as a change of
 * namespace does, and a call under a ttl of 0, which never expires, stores no
 * entry.
 */
export class AutoKeys {
  private namespace: string | undefined;
  private prefix = '';
  /**
   * Single-argument calls, keyed by the argument. A Map compares keys by
   * SameValueZero: by type and value, with NaN equal to itself (kept out) and 0
   * equal to -0 (one key).
   */
  private readonly one = new Map<MemoArg, string>();
  /** Calls with no argument or two to eight, keyed by tupleOf(). */
  private readonly many = new Map<string, string>();
  /**
   * When the memo empties itself, in Date.now() milliseconds, the clock L1
   * expires entries by. Infinity while it is empty, and then a call that stores
   * no entry reads no clock.
   */
  private until = Infinity;
  /** The ttl, in seconds, the running window was started under. */
  private windowTtl = 0;
  /** Cancels the timer that empties the memo at `until`. */
  private cancelTimer: (() => void) | undefined;
  readonly memoising: boolean;

  /** Without a timer to empty it on time, it keeps no memo. */
  constructor(private readonly setTimer: UnrefTimeout | undefined) {
    this.memoising = setTimer !== undefined;
  }

  /**
   * With `useMemo` false the call is keyed in full and nothing of it is kept.
   * `ttlSeconds` is the wrap's ttl.
   */
  key(namespace: string, args: unknown[], useMemo: boolean, ttlSeconds: number): string {
    // A JavaScript caller can pass any namespace: key it as generateKey does.
    if (typeof namespace !== 'string') return generateKey(namespace, args);
    if (namespace !== this.namespace) {
      this.namespace = namespace;
      this.prefix = `${namespace}:`;
      this.forget(); // every entry holds the old prefix
    }
    if (this.until !== Infinity && (ttlSeconds !== this.windowTtl || Date.now() >= this.until)) {
      this.forget();
    }
    if (!this.memoising || !useMemo) return this.prefix + generateParamsHash(args);
    if (args.length === 1) {
      const arg = args[0];
      if (!isMemoArg(arg) || !withinBudget(arg)) return this.prefix + generateParamsHash(args);
      let key = this.one.get(arg);
      if (key === undefined) {
        key = this.prefix + generateParamsHash(args);
        if (this.admit(ttlSeconds)) {
          this.one.set(typeof arg === 'string' ? ownString(arg) : arg, key);
        }
      }
      return key;
    }
    const tuple = tupleOf(args);
    if (tuple === undefined) return this.prefix + generateParamsHash(args);
    let key = this.many.get(tuple);
    if (key === undefined) {
      key = this.prefix + generateParamsHash(args);
      if (this.admit(ttlSeconds)) this.many.set(ownString(tuple), key);
    }
    return key;
  }

  /** Drop every memoised argument. */
  forget(): void {
    this.one.clear();
    this.many.clear();
    this.until = Infinity;
    if (this.cancelTimer !== undefined) {
      this.cancelTimer();
      this.cancelTimer = undefined;
      timersOfCollectedMemos?.unregister(this);
    }
  }

  /**
   * Makes room for one more entry, emptying a full memo, and starts a window if
   * none is running. False when the entry must not be stored: a ttl of 0 never
   * expires, and set() rejects a negative, NaN or infinite one.
   */
  private admit(ttlSeconds: number): boolean {
    const setTimer = this.setTimer;
    if (setTimer === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
    if (this.one.size + this.many.size >= MEMO_MAX_ENTRIES) this.forget();
    if (this.until === Infinity) {
      const ms = Math.min(ttlSeconds * 1000, MEMO_MAX_WINDOW_MS);
      // Held weakly: a pending timer must not keep a dropped function's memo.
      const memo = new WeakRef(this);
      // The window opens only once its timer is set, so a timer that cannot be
      // set leaves no window without one.
      const cancel = setTimer(() => memo.deref()?.forget(), ms);
      this.until = Date.now() + ms;
      this.windowTtl = ttlSeconds;
      this.cancelTimer = cancel;
      timersOfCollectedMemos ??= new FinalizationRegistry((cancelTimer) => cancelTimer());
      timersOfCollectedMemos.register(this, cancel, this);
    }
    return true;
  }
}

/**
 * A copy of `s` that shares no memory with it. V8 can hold a string as a slice
 * of a larger string, or as a tree of the strings it was joined from, and keeps
 * whatever it points into alive: a 128-character ID sliced from a 4 MiB request
 * body keeps the whole body. Built from the code units, the copy points into
 * nothing, so an entry costs what its own characters do.
 */
function ownString(s: string): string {
  const units = new Array<number>(s.length);
  for (let i = 0; i < s.length; i++) units[i] = s.charCodeAt(i);
  return String.fromCharCode(...units);
}

/** Is this argument of a type the memo takes? It says nothing of the budget. */
function isMemoArg(arg: unknown): arg is MemoArg {
  switch (typeof arg) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'undefined':
      return true;
    case 'object':
      return arg === null;
    default:
      return false;
  }
}

/** Neither NaN nor a string past the budget. */
function withinBudget(arg: MemoArg): boolean {
  return typeof arg === 'string' ? arg.length <= MEMO_MAX_STRING_LENGTH : arg === arg;
}

/**
 * The memo key of a call with no argument or two to eight, or undefined if it
 * must take the full path. It is checked in full before any of it is built, so
 * a call that passes an object pays only for the check. Each argument becomes a
 * field that starts with its type and ends where the field says, so no two
 * different tuples share one: `s<length>:<string>`, `n<number>;`, `t`, `f`, `l`
 * (null) and `u` (undefined). A number is written in its shortest round-trip
 * form, which differs between any two numbers except 0 and -0.
 */
function tupleOf(args: unknown[]): string | undefined {
  if (args.length > MEMO_MAX_ARGS) return undefined;
  let chars = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!isMemoArg(arg) || arg !== arg) return undefined; // arg !== arg: NaN
    if (typeof arg === 'string') chars += arg.length;
  }
  if (chars > MEMO_MAX_STRING_LENGTH) return undefined;
  let tuple = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (typeof arg) {
      case 'string':
        tuple += `s${arg.length}:${arg}`;
        break;
      case 'number':
        tuple += `n${arg};`;
        break;
      case 'boolean':
        tuple += arg ? 't' : 'f';
        break;
      default:
        tuple += arg === null ? 'l' : 'u';
    }
  }
  return tuple;
}
