// Print one sha256 over a set of files: each file's content and basename.
//
// Usage: node digest-files.mjs <file>...
//
// A job hands files to a later job as an artifact, and any job in the run can
// replace an artifact by name. None can rewrite another job's outputs, so the
// producing job puts this digest in an output and the consuming job recomputes
// it over what it downloaded. Basenames are in the digest because a binary's
// name picks the npm package it ships in. Node, not sha256sum: the build
// matrix spans Linux, macOS and Windows, and sha256sum's line format differs
// between their runner images.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node digest-files.mjs <file>...');
  process.exit(2);
}

const read = (file) => {
  try {
    return readFileSync(file);
  } catch (error) {
    console.error(`digest-files: cannot read ${file}: ${error.code ?? error.message}`);
    process.exit(1);
  }
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const lines = files.map((file) => `${sha256(read(file))}  ${basename(file)}\n`).sort();
console.log(sha256(lines.join('')));
