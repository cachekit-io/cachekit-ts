// Refuse to release a package while a workspace package it depends on has
// commits release-please would release that no release carries yet.
//
// Usage: node release-order-gate.mjs <package-dir> [<rev>]
//   from the repository root, with full history and tags, GITHUB_REPOSITORY
//   set, and gh authenticated (GH_TOKEN) to read pull requests.
//
// pnpm pack writes each `workspace:` dependency as the version in that
// package's package.json at the packed commit, and release-please releases
// each package from its own pull request, in whatever order they merge. So the
// SDK can release pinned to a core whose newer commits are still waiting in
// the core's release PR; npm serves the old core, so no later check notices.
//
// For each workspace dependency, this lists the commits after its release tag
// (`<component>-v<version>`, the version pnpm would pin) that touch its path,
// and decides as release-please 17 does whether each is releasable: the
// merged PR's BEGIN_COMMIT_OVERRIDE block replaces the commit message, the
// message splits into BEGIN_NESTED_COMMIT blocks and blank-line-separated
// conventional headers, and a message is releasable when its type has a
// visible section in release-please-config.json's changelog-sections, or it
// is a breaking change (`!` or a BREAKING CHANGE footer). Any such commit
// refuses the release (exit 1). Anything this cannot read, including a missing
// tag or a failed lookup, refuses too (exit 2).
import { execFileSync } from 'node:child_process';

class CannotCheck extends Error {}

// A stalled API call must refuse, not hang the job until its own timeout.
const timeout = Number(process.env.RELEASE_ORDER_GATE_TIMEOUT_MS) || 60_000;
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 26,
      timeout,
    });
  } catch (e) {
    const why =
      e.code === 'ETIMEDOUT' ? `timed out after ${timeout} ms` : (e.stderr || e.message).trim();
    throw new CannotCheck(`${cmd} ${args.join(' ')} failed: ${why}`);
  }
};
const git = (...args) => run('git', args);

const [dir, rev = 'HEAD'] = process.argv.slice(2);
if (!dir) {
  console.log('Usage: node release-order-gate.mjs <package-dir> [<rev>]');
  process.exit(2);
}

let ahead = 0;
try {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new CannotCheck('GITHUB_REPOSITORY is not set');
  const commit = git('rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`).trim();
  const readJson = (path) => {
    const text = git('show', `${commit}:${path}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new CannotCheck(`${path} at ${commit} is not JSON`);
    }
  };

  const config = readJson('release-please-config.json');
  if (!Array.isArray(config['changelog-sections']) || !config.packages) {
    throw new CannotCheck('release-please-config.json has no changelog-sections or packages');
  }
  const visible = new Set(config['changelog-sections'].filter((s) => !s.hidden).map((s) => s.type));

  const pkg = readJson(`${dir}/package.json`);
  const siblings = Object.entries({
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
    ...pkg.dependencies,
  })
    .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('workspace:'))
    .map(([name]) => name);

  const prBodies = new Map();
  // The PR release-please reads: the one this commit merged, else the first.
  const prBody = (sha) => {
    if (!prBodies.has(sha)) {
      let prs;
      try {
        prs = JSON.parse(run('gh', ['api', `repos/${repo}/commits/${sha}/pulls`]));
      } catch (e) {
        throw e instanceof CannotCheck
          ? e
          : new CannotCheck(`the pull requests of ${sha} are not JSON`);
      }
      if (!Array.isArray(prs)) throw new CannotCheck(`the pull requests of ${sha} are not a list`);
      const pr = prs.find((p) => p.merge_commit_sha === sha) ?? prs[0];
      prBodies.set(sha, pr?.body ?? '');
    }
    return prBodies.get(sha);
  };

  for (const name of siblings) {
    const found = Object.entries(config.packages).find(([, p]) => p['package-name'] === name);
    if (!found || !found[1].component) {
      throw new CannotCheck(
        `${name} is a workspace dependency with no release-please package and component`
      );
    }
    const [path, { component }] = found;
    const { version } = readJson(`${path}/package.json`);
    const tag = `${component}-v${version}`;
    let base;
    try {
      base = git('rev-parse', '--verify', '--end-of-options', `refs/tags/${tag}^{commit}`).trim();
    } catch {
      throw new CannotCheck(`no tag ${tag} for ${name}@${version}, the version ${dir} would pin`);
    }
    try {
      git('merge-base', '--is-ancestor', base, commit);
    } catch {
      throw new CannotCheck(`${tag} is not an ancestor of ${commit}`);
    }

    const releasable = [];
    for (const entry of git('log', '-z', '--format=%H%n%B', `${base}..${commit}`, '--', path).split(
      '\0'
    )) {
      if (!entry) continue;
      const sha = entry.slice(0, entry.indexOf('\n'));
      const override = (prBody(sha).split('BEGIN_COMMIT_OVERRIDE')[1] || '')
        .split('END_COMMIT_OVERRIDE')[0]
        .trim();
      for (const message of splitMessages(override || entry.slice(sha.length + 1))) {
        const header = message.trim().split(/\r?\n/)[0];
        const m = /^(\w+)(?:\([^()\r\n]*\))?(!)?: \S/.exec(header);
        if (!m) continue; // release-please skips a message it cannot parse
        if (
          visible.has(m[1]) ||
          m[2] ||
          /^BREAKING CHANGE: \S/m.test(message) ||
          /BREAKING-CHANGE:\s*\S/.test(message)
        ) {
          releasable.push(`${sha.slice(0, 7)} ${header}`);
        }
      }
    }

    if (releasable.length === 0) {
      console.log(`${name}@${version}: nothing releasable on ${path} since ${tag}.`);
      continue;
    }
    ahead++;
    console.log(`${name}@${version}: releasable since ${tag}:`);
    for (const line of releasable) console.log(`  ${line}`);
    console.log(
      `::error::${name} has ${releasable.length} releasable change(s) since ${tag}, and ${dir} would pin ${version} without them. Release ${name} first, then this package — refusing to release.`
    );
  }
} catch (e) {
  console.log(`::error::Cannot check release order: ${e.message} — refusing to release.`);
  process.exit(2);
}
if (ahead) process.exit(1);
console.log(`Release order OK: every workspace dependency of ${dir} at ${rev} is released.`);

// release-please's splitMessages (src/commit.ts): BEGIN_NESTED_COMMIT blocks
// are messages of their own, and the rest splits at each blank line that is
// followed by a conventional header.
function splitMessages(message) {
  const parts = message.split('BEGIN_NESTED_COMMIT');
  const messages = [parts.shift()];
  for (const part of parts) {
    const [nested, ...rest] = part.split('END_NESTED_COMMIT');
    messages.push(nested);
    messages[0] += rest.join('END_NESTED_COMMIT');
  }
  return [
    ...messages[0]
      .split(
        /\r?\n\r?\n(?=(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(.*?\))?: )/
      )
      .filter(Boolean),
    ...messages.slice(1),
  ];
}
