/**
 * Load-time shape checks for the vendored protocol fixtures in test/protocol/.
 *
 * `JSON.parse` returns `any`, so a cast on its result checks nothing: a
 * re-vendored fixture that renames a table fails at collection with
 * "Cannot read properties of undefined", naming no field. Each suite instead
 * passes the parsed value, typed `unknown`, through its own
 * `asserts value is X` function built on `assertFixture`, which throws naming
 * the path of the first field that is missing or of the wrong kind.
 *
 * A shape is data:
 * - a kind (`'string'`, `'number'`, ...): the value's typeof, with `null` and
 *   arrays told apart from objects;
 * - a list of kinds, any of which passes; `'undefined'` makes a field optional;
 * - `table(row)`: an array whose every element matches `row`;
 * - an object: a JSON object holding at least the listed fields.
 */

type Kind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'undefined';

class Table {
  constructor(readonly row: Shape) {}
}

export interface ObjectShape {
  readonly [field: string]: Shape;
}

export type Shape = Kind | Kind[] | Table | ObjectShape;

/** An array whose every element matches `row`. */
export function table(row: Shape): Table {
  return new Table(row);
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws a TypeError naming `file` and the field's path unless `value` matches `shape`. */
export function assertFixture(value: unknown, shape: ObjectShape, file: string): void {
  const check = (v: unknown, s: Shape, path: string): void => {
    const fail = (expected: string) =>
      new TypeError(`${file}: ${path || '(root)'}: expected ${expected}, got ${kindOf(v)}`);
    if (s instanceof Table) {
      if (!Array.isArray(v)) throw fail('array');
      v.forEach((row, i) => check(row, s.row, `${path}[${i}]`));
      return;
    }
    if (typeof s === 'string' || Array.isArray(s)) {
      const kinds = typeof s === 'string' ? [s] : s;
      if (!kinds.some((k) => k === kindOf(v))) throw fail(kinds.join(' | '));
      return;
    }
    if (!isRecord(v)) throw fail('object');
    for (const [field, fieldShape] of Object.entries(s)) {
      check(v[field], fieldShape, path ? `${path}.${field}` : field);
    }
  };
  check(value, shape, '');
}
