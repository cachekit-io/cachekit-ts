// Print the package/package.json that `pnpm publish <tarball>` would publish,
// or exit 1 with an ::error line. Usage: node packed-manifest.mjs <tarball>
//
// pnpm (tar-stream) reads the first entry whose path.normalize(name), with
// backslashes then made slashes, is package/package.json. Another tar reader
// can disagree on which entry that is: GNU tar applies a pax global header's
// path to later entries, tar-stream does not. So this reads the archive the
// way tar-stream does, and refuses anything outside the plain subset where the
// two cannot differ: checksummed USTAR headers, regular files and empty
// directories, octal fields, no pax, GNU long-name or link entries. pnpm pack
// writes only that subset. Exactly one entry may normalise to
// package/package.json, and its name must be that literally.
import { readFileSync } from 'node:fs';
import { normalize } from 'node:path';
import { gunzipSync } from 'node:zlib';

const refuse = (why) => {
  console.log(`::error::Tarball ${why} — refusing to publish.`);
  process.exit(1);
};

let tar;
try {
  tar = gunzipSync(readFileSync(process.argv[2]));
} catch (e) {
  refuse(`cannot be gunzipped (${e.message})`);
}

const str = (b, at, len) => {
  const f = b.subarray(at, at + len);
  const nul = f.indexOf(0);
  return f.subarray(0, nul < 0 ? len : nul).toString('utf8');
};
const oct = (b, at, len, what, off) => {
  const f = b.subarray(at, at + len).toString('latin1');
  if (!/^[0-7]+[ \0]+$/.test(f)) refuse(`has a non-octal ${what} field at byte ${off}`);
  return parseInt(f, 8);
};

const found = [];
for (let off = 0; off < tar.length; ) {
  if (tar.length - off < 512) refuse(`ends inside a header at byte ${off}`);
  const h = tar.subarray(off, off + 512);
  let sum = 8 * 32;
  for (let i = 0; i < 512; i++) if (i < 148 || i >= 156) sum += h[i];
  if (sum === 8 * 32) {
    off += 512; // tar-stream skips a zero block and reads on
    continue;
  }
  if (oct(h, 148, 8, 'checksum', off) !== sum) refuse(`has a bad header checksum at byte ${off}`);
  if (h.subarray(257, 265).toString('latin1') !== 'ustar\x0000')
    refuse(`has a non-USTAR header at byte ${off}`);
  const flag = String.fromCharCode(h[156]);
  if (!['0', '\0', '5'].includes(flag)) refuse(`has an entry of type '${flag}' at byte ${off}`);
  const size = oct(h, 124, 12, 'size', off);
  const name = h[345] ? `${str(h, 345, 155)}/${str(h, 0, 100)}` : str(h, 0, 100);
  if (size > 0 && (flag === '5' || name.endsWith('/')))
    refuse(`has a directory with data at byte ${off}`);
  const start = off + 512;
  off = start + Math.ceil(size / 512) * 512;
  if (off > tar.length) refuse(`ends inside the data of '${name}'`);
  if (normalize(name.replaceAll('\\', '/')) === 'package/package.json') {
    found.push({ name, body: tar.subarray(start, start + size) });
  }
}

if (found.length !== 1 || found[0].name !== 'package/package.json') {
  refuse(
    `entries pnpm may read as package/package.json are [${found.map((f) => JSON.stringify(f.name))}], expected exactly "package/package.json"`
  );
}
process.stdout.write(found[0].body);
