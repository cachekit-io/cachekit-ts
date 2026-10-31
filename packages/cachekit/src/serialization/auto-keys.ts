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
 * The longest a memo window runs. The call that opens a window sets the timer
 * that ends it, and Node.js keeps the async context a timer was set in until it
 * fires: the caller's AsyncLocalStorage stores, a whole request perhaps. Node.js
 * offers no way to set a timer outside every context, so the window is kept
 * short: its timer is set to release that context within one second, though
 * it can run late (see AutoKeys). A function called again and again with the
 * same arguments keys them in full about once a second, or once per ttl if
 * that is shorter.
 */
const MEMO_MAX_WINDOW_MS = 1000;

/**
 * Runs `callback` once, `ms` milliseconds from now, without holding the process
 * open, and returns a function that cancels it.
 */
export type UnrefTimeout = (callback: () => void, ms: number) => () => void;

/** The argument types the memo takes. */
type MemoArg = string | number | boolean | null | undefined;

/**
 * A call's key and, for a memoised call, a place for its caller to keep what
 * the key led to last time (wrap() keeps the L1 entry there), so a repeat call
 * reaches it without another lookup. A call that is not memoised gets a slot of
 * its own, which nothing keeps.
 */
export interface KeySlot<E> {
  readonly key: string;
  entry: E | undefined;
}

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
 * entries on request. A timer also empties it one ttl, the wrap's, after its
 * first entry, or one second after it if that is sooner (see
 * MEMO_MAX_WINDOW_MS), though the function is not called again; so it is set
 * to drop an argument no later than L1 stops serving a value stored with that
 * ttl, even when a removal on another instance never reaches this one. The
 * timer can run late, for example when the event loop is busy or the process
 * is suspended (Node.js timers keep the monotonic clock, which stops while a
 * host sleeps), and the memo keeps its arguments until it runs. A call that
 * comes one ttl or more after the first entry, before the timer has run,
 * empties the memo first, so no entry is served past its ttl. A call under
 * another ttl empties it too, as a change of namespace does, and a call under
 * a ttl of 0, which never expires, stores no entry.
 */
export class AutoKeys<E = unknown> {
  private namespace: string | undefined;
  private prefix = '';
  /**
   * Single-argument calls, keyed by the argument. A Map compares keys by
   * SameValueZero: by type and value, with NaN equal to itself (kept out) and 0
   * equal to -0 (one key).
   */
  private readonly one = new Map<MemoArg, KeySlot<E>>();
  /** Calls with no argument or two to eight, keyed by tupleOf(). */
  private readonly many = new Map<string, KeySlot<E>>();
  /**
   * When its entries expire, one ttl after the first, in Date.now()
   * milliseconds, the clock L1 expires entries by. Its timer empties it at
   * this time or sooner. Infinity while it is empty, and then a call that
   * stores no entry reads no clock.
   */
  private until = Infinity;
  /** The ttl, in seconds, the running window was started under. */
  private windowTtl = 0;
  /** Cancels the timer that empties the memo when its window ends. */
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
    return this.slot(namespace, args, useMemo, ttlSeconds).key;
  }

  /**
   * key(), as the call's slot. `now` is Date.now() when the caller has read it
   * already; without it the clock is read only if the memo needs it.
   */
  slot(
    namespace: string,
    args: unknown[],
    useMemo: boolean,
    ttlSeconds: number,
    now?: number
  ): KeySlot<E> {
    // A JavaScript caller can pass any namespace: key it as generateKey does.
    if (typeof namespace !== 'string') return unkept(generateKey(namespace, args));
    if (namespace !== this.namespace) {
      this.namespace = namespace;
      this.prefix = `${namespace}:`;
      this.forget(); // every entry holds the old prefix
    }
    if (
      this.until !== Infinity &&
      (ttlSeconds !== this.windowTtl || (now ?? Date.now()) >= this.until)
    ) {
      this.forget();
    }
    if (!this.memoising || !useMemo) return unkept(this.prefix + generateParamsHash(args));
    if (args.length === 1) {
      const arg = args[0];
      if (!isMemoArg(arg) || !withinBudget(arg)) {
        return unkept(this.prefix + generateParamsHash(args));
      }
      let slot = this.one.get(arg);
      if (slot === undefined) {
        slot = unkept(this.prefix + generateParamsHash(args));
        if (this.admit(ttlSeconds, now)) {
          this.one.set(typeof arg === 'string' ? ownString(arg) : arg, slot);
        }
      }
      return slot;
    }
    const tuple = tupleOf(args);
    if (tuple === undefined) return unkept(this.prefix + generateParamsHash(args));
    let slot = this.many.get(tuple);
    if (slot === undefined) {
      slot = unkept(this.prefix + generateParamsHash(args));
      if (this.admit(ttlSeconds, now)) this.many.set(ownString(tuple), slot);
    }
    return slot;
  }

  /** Drop every memoised argument. */
  forget(): void {
    this.one.clear();
    this.many.clear();
    this.until = Infinity;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /**
   * Makes room for one more entry, emptying a full memo, and starts a window if
   * none is running. False when the entry must not be stored: a ttl of 0 never
   * expires, and set() rejects a negative, NaN or infinite one.
   */
  private admit(ttlSeconds: number, now: number | undefined): boolean {
    const setTimer = this.setTimer;
    if (setTimer === undefined || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
    if (this.one.size + this.many.size >= MEMO_MAX_ENTRIES) this.forget();
    if (this.until === Infinity) {
      // The window opens only once its timer is set, so a timer that cannot be
      // set leaves no window without one.
      const cancel = setTimer(() => this.forget(), Math.min(ttlSeconds * 1000, MEMO_MAX_WINDOW_MS));
      // A ttl too long to count in milliseconds would make this Infinity, which
      // marks an empty memo, so it counts as the longest finite one.
      this.until = (now ?? Date.now()) + Math.min(ttlSeconds * 1000, Number.MAX_VALUE);
      this.windowTtl = ttlSeconds;
      this.cancelTimer = cancel;
    }
    return true;
  }
}

/** The slot of a key nothing keeps. */
function unkept<E>(key: string): KeySlot<E> {
  return { key, entry: undefined };
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
