import assert from 'node:assert/strict';

export function stable(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    return undefined;
  const parts = version.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

export function compare(a, b) {
  const left = stable(a),
    right = stable(b);
  assert.ok(left && right, 'Expected canonical stable versions');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

/** Tags reserve versions. Registry entries are immutable, including entries without Git tags. */
export function selectRelease({ published, tags, runId, resumeTag = '', untagged = [] }) {
  const releases = tags.filter((t) => stable(t.version) && compare(t.version, '1.0.0') >= 0);
  const versions = published.filter((v) => stable(v) && compare(v, '1.0.0') >= 0);
  const sameRun = releases.filter((t) => t.runId === runId);
  assert.ok(
    sameRun.length <= 1,
    'Multiple release tags have the same run ID. Inspect them before recovery.',
  );
  if (resumeTag) {
    assert.ok(
      /^v/.test(resumeTag) &&
        stable(resumeTag.slice(1)) &&
        compare(resumeTag.slice(1), '1.0.0') >= 0,
      'resume_tag must be vX.Y.Z at or above v1.0.0',
    );
    const target = releases.find((t) => t.tag === resumeTag);
    assert.ok(target, 'Recovery tag does not exist. Never invent or move a recovery tag.');
    if (sameRun.length)
      assert.equal(target.sha, sameRun[0].sha, 'A rerun must retain its original release');
    return { ...target, mode: 'resume' };
  }
  if (sameRun.length) return { ...sameRun[0], mode: 'resume' };
  const highest = [...versions, ...releases.map((t) => t.version)].sort(compare).at(-1);
  // A version-only commit without a tag is a recoverable partial Git state.
  const repair = untagged.filter(
    (t) =>
      stable(t.version) &&
      compare(t.version, '1.0.0') >= 0 &&
      (!highest || compare(t.version, highest) >= 0),
  );
  assert.ok(repair.length <= 1, 'Multiple untagged release intents require manual inspection');
  if (repair.length) return { ...repair[0], mode: 'repair' };
  const latestPublished = versions.sort(compare).at(-1);
  const pending = releases.filter(
    (t) =>
      !published.includes(t.version) &&
      (!latestPublished || compare(t.version, latestPublished) > 0),
  );
  assert.ok(pending.length <= 1, 'Multiple unpublished tags exist. Select resume_tag explicitly.');
  if (pending.length) return { ...pending[0], mode: 'resume' };
  if (!highest) return { mode: 'new', version: '1.0.0', tag: 'v1.0.0' };
  const [major, minor, patch] = stable(highest);
  assert.ok(Number.isSafeInteger(patch + 1), 'Patch version overflow');
  const version = `${major}.${minor}.${patch + 1}`;
  return { mode: 'new', version, tag: `v${version}` };
}
