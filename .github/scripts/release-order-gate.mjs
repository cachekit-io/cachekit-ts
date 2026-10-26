// Refuse to release a package while a workspace package it depends on has
// unreleased changes, or, when packing, while the checkout would pin an older
// release of it than main has.
//
// Usage: node release-order-gate.mjs <package-dir> [--packing]
//   from the repository root, with GITHUB_REPOSITORY set and gh authenticated
//   (GH_TOKEN) to read pull requests and contents.
//
// pnpm pack writes each `workspace:` dependency as the version in that
// package's package.json at the packed commit, and release-please releases
// each package from its own pull request, in whatever order they merge. So the
// SDK can release pinned to a core whose newer commits are still waiting in
// the core's release PR; npm serves the old core, so no later check notices.
//
// Two checks, each refusing with exit 1:
// - An open PR from a dependency's release branch
//   (release-please--branches--main--components--<component>) is
//   release-please's own decision that the dependency has unreleased changes.
//   Release-please opens and updates those PRs in the same step that tags a
//   release, so in the Release workflow they reflect main at the commit being
//   released.
// - With --packing, the checkout is what will be packed, so each dependency's
//   version in it must equal the version main's .release-please-manifest.json
//   records as released. A re-run of a refused release re-packs its old tag
//   after the dependency has released, when no PR is open any more; this is
//   what refuses it.
// Anything this cannot read, including a failed or stalled lookup, refuses too
// (exit 2).
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

// gh's answer parsed as JSON; what names the answer in errors.
const ghJson = (what, ...args) => {
  let out;
  try {
    out = execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
  } catch (e) {
    const why =
      e.code === 'ETIMEDOUT' ? `timed out after ${timeout} ms` : (e.stderr || e.message).trim();
    throw new CannotCheck(`gh api ${args.join(' ')} failed: ${why}`);
  }
  try {
    return JSON.parse(out);
  } catch {
    throw new CannotCheck(`${what} are not JSON`);
  }
};

const openPulls = (repo, branch) => {
  const pulls = ghJson(
    `the open pull requests from ${branch}`,
    `repos/${repo}/pulls?state=open&head=${repo.split('/')[0]}:${branch}&per_page=100`
  );
  if (!Array.isArray(pulls))
    throw new CannotCheck(`the open pull requests from ${branch} are not a list`);
  // Every row must be readable before any is dropped: a row this cannot read
  // is not evidence that no release is pending. head.repo is null when a
  // fork has been deleted, which makes that PR foreign, not unreadable.
  for (const p of pulls) {
    const repoOk =
      p?.head?.repo === null ||
      (typeof p?.head?.repo === 'object' && typeof p.head.repo.full_name === 'string');
    if (typeof p?.head?.ref !== 'string' || !repoOk) {
      throw new CannotCheck(`an open pull request from ${branch} has no readable head`);
    }
  }
  // The head filter is the server's; a fork's branch of the same name is not ours.
  return pulls.filter((p) => p.head.ref === branch && p.head.repo?.full_name === repo);
};

const releasedOnMain = (repo) => {
  const manifest = ghJson(
    `the contents of .release-please-manifest.json on ${TARGET_BRANCH}`,
    '-H',
    'Accept: application/vnd.github.raw+json',
    `repos/${repo}/contents/.release-please-manifest.json?ref=${TARGET_BRANCH}`
  );
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new CannotCheck(`.release-please-manifest.json on ${TARGET_BRANCH} is not an object`);
  }
  return manifest;
};

const args = process.argv.slice(2);
const packing = args.includes('--packing');
const [dir, ...extra] = args.filter((a) => a !== '--packing');
if (!dir || extra.length) {
  console.log('Usage: node release-order-gate.mjs <package-dir> [--packing]');
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
  const deps = siblings.map((name) => {
    const found = Object.entries(config.packages ?? {}).find(([, p]) => p['package-name'] === name);
    if (!found?.[1].component) {
      throw new CannotCheck(
        `${name} is a workspace dependency with no release-please package and component`
      );
    }
    const [path, { component }] = found;
    return {
      name,
      path,
      component,
      pinned: packing ? readJson(`${path}/package.json`).version : null,
    };
  });

  // Every PR read finishes before the manifest read starts. A dependency's
  // release merging while the gate runs closes its PR and moves main's
  // manifest past the pin, and the manifest never moves back. So a merge
  // before a PR read shows in the manifest read after it, and a merge after
  // a PR read was seen there as an open PR: no order of events passes stale
  // pins. Read the other way round, a merge between the reads passed.
  for (const { name, component } of deps) {
    const branch = `release-please--branches--${TARGET_BRANCH}--components--${component}`;
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

  if (packing) {
    const released = releasedOnMain(repo);
    for (const { name, path, pinned } of deps) {
      const latest = released[path];
      if (typeof latest !== 'string' || !latest) {
        throw new CannotCheck(
          `.release-please-manifest.json on ${TARGET_BRANCH} has no version for ${path}`
        );
      }
      if (pinned === latest) {
        console.log(`${name}: pins ${pinned}, as released on ${TARGET_BRANCH}.`);
        continue;
      }
      held++;
      console.log(
        `::error::${dir} would pin ${name}@${pinned}, but ${TARGET_BRANCH} has released ${name}@${latest}. A re-run packs this checkout's pins again; release from ${TARGET_BRANCH} instead — refusing to release.`
      );
    }
  }
} catch (e) {
  console.log(`::error::Cannot check release order: ${e.message} — refusing to release.`);
  process.exit(2);
}
if (held) process.exit(1);
console.log(`Release order OK: no workspace dependency of ${dir} has an open release PR.`);
