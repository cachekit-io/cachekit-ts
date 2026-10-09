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
 * - `table(row)`: an array whose every element matches `row`;
 * - `oneOf(...values)`: a string equal to one of `values`;
 * - an object: a JSON object holding at least the listed fields;
 * - a list of the above, any of which passes; `'undefined'` in it makes a
 *   field optional.
 */

type Kind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'undefined';

class Table {
  constructor(readonly row: Shape) {}
}

class OneOf {
  constructor(readonly values: readonly string[]) {}
}

export interface ObjectShape {
  readonly [field: string]: Shape;
}

type Single = Kind | Table | OneOf | ObjectShape;

export type Shape = Single | Single[];

/** An array whose every element matches `row`. */
export function table(row: Shape): Table {
  return new Table(row);
}

/** A string equal to one of `values`. */
export function oneOf(...values: string[]): OneOf {
  return new OneOf(values);
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/** The kind of value a single shape accepts. */
function kindOfShape(shape: Single): string {
  if (typeof shape === 'string') return shape;
  if (shape instanceof Table) return 'array';
  return shape instanceof OneOf ? 'string' : 'object';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws a TypeError naming `file` and the field's path unless `value` matches `shape`. */
export function assertFixture(value: unknown, shape: ObjectShape, file: string): void {
  const check = (v: unknown, s: Shape, path: string): void => {
    const fail = (expected: string, got = kindOf(v)) =>
      new TypeError(`${file}: ${path || '(root)'}: expected ${expected}, got ${got}`);
    const alternatives: Single[] = Array.isArray(s) ? s : [s];
    const match = alternatives.find((a) => kindOfShape(a) === kindOf(v));
    if (match === undefined) throw fail(alternatives.map(kindOfShape).join(' | '));
    if (match instanceof Table) {
      if (!Array.isArray(v)) throw fail('array');
      v.forEach((row, i) => check(row, match.row, `${path}[${i}]`));
      return;
    }
    if (match instanceof OneOf) {
      if (!match.values.some((allowed) => allowed === v)) {
        throw fail(`one of ${JSON.stringify(match.values)}`, JSON.stringify(v));
      }
      return;
    }
    if (typeof match === 'string') return;
    if (!isRecord(v)) throw fail('object');
    for (const [field, fieldShape] of Object.entries(match)) {
      check(v[field], fieldShape, path ? `${path}.${field}` : field);
    }
  };
  check(value, shape, '');
}
