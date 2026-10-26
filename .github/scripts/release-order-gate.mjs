// Refuse to release a package while a workspace package it depends on has an
// open release-please release PR.
//
// Usage: node release-order-gate.mjs <package-dir>
//   from the repository root, with GITHUB_REPOSITORY set and gh authenticated
//   (GH_TOKEN) to read pull requests.
//
// pnpm pack writes each `workspace:` dependency as the version in that
// package's package.json at the packed commit, and release-please releases
// each package from its own pull request, in whatever order they merge. So the
// SDK can release pinned to a core whose newer commits are still waiting in
// the core's release PR; npm serves the old core, so no later check notices.
//
// The gate asks release-please itself instead of re-deriving its rules: an open
// PR from a dependency's release branch
// (release-please--branches--main--components--<component>) is release-please's
// own decision that the dependency has unreleased changes. Release-please opens
// and updates those PRs in the same step that tags a release, so in the Release
// workflow they reflect main at the commit being released. Any open one refuses
// (exit 1). Anything this cannot read, including a failed or stalled lookup,
// refuses too (exit 2).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

class CannotCheck extends Error {}

// The Release workflow runs only on main, so release-please targets main.
const TARGET_BRANCH = 'main';
// A stalled API call must refuse, not hang the job until its own timeout.
const timeout = Number(process.env.RELEASE_ORDER_GATE_TIMEOUT_MS) || 60_000;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CannotCheck(`cannot read ${path} (${e.message})`);
  }
};

const openPulls = (repo, branch) => {
  const args = [
    'api',
    `repos/${repo}/pulls?state=open&head=${repo.split('/')[0]}:${branch}&per_page=100`,
  ];
  let out;
  try {
    out = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
  } catch (e) {
    const why =
      e.code === 'ETIMEDOUT' ? `timed out after ${timeout} ms` : (e.stderr || e.message).trim();
    throw new CannotCheck(`gh ${args.join(' ')} failed: ${why}`);
  }
  let pulls;
  try {
    pulls = JSON.parse(out);
  } catch {
    throw new CannotCheck(`the open pull requests from ${branch} are not JSON`);
  }
  if (!Array.isArray(pulls))
    throw new CannotCheck(`the open pull requests from ${branch} are not a list`);
  // The head filter is the server's; a fork's branch of the same name is not ours.
  return pulls.filter((p) => p?.head?.ref === branch && p?.head?.repo?.full_name === repo);
};

const [dir] = process.argv.slice(2);
if (!dir) {
  console.log('Usage: node release-order-gate.mjs <package-dir>');
  process.exit(2);
}

let held = 0;
try {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo?.includes('/')) throw new CannotCheck('GITHUB_REPOSITORY is not set to <owner>/<repo>');
  const config = readJson('release-please-config.json');
  const pkg = readJson(`${dir}/package.json`);
  const siblings = Object.entries({
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
    ...pkg.dependencies,
  })
    .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('workspace:'))
    .map(([name]) => name);

  for (const name of siblings) {
    const found = Object.values(config.packages ?? {}).find((p) => p['package-name'] === name);
    if (!found?.component) {
      throw new CannotCheck(
        `${name} is a workspace dependency with no release-please package and component`
      );
    }
    const branch = `release-please--branches--${TARGET_BRANCH}--components--${found.component}`;
    const pulls = openPulls(repo, branch);
    if (pulls.length === 0) {
      console.log(`${name}: no open release PR.`);
      continue;
    }
    held++;
    for (const p of pulls) {
      console.log(
        `::error::${name} has an open release PR, ${p.html_url} ("${p.title}"), so ${dir} would pin the previous ${name}. Merge it and let it publish, then release this package — refusing to release.`
      );
    }
  }
} catch (e) {
  console.log(`::error::Cannot check release order: ${e.message} — refusing to release.`);
  process.exit(2);
}
if (held) process.exit(1);
console.log(`Release order OK: no workspace dependency of ${dir} has an open release PR.`);
