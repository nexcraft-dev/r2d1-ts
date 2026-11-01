import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRelease } from '../scripts/release-policy.mjs';

const tag = (version, runId = '1') => ({ version, tag: `v${version}`, sha: 'a'.repeat(40), runId });
const choose = (overrides = {}) =>
  selectRelease({ published: [], tags: [], runId: '2', ...overrides });

test('the first formal release is 1.0.0 and pre-1.0/prerelease history does not change it', () => {
  assert.equal(choose().version, '1.0.0');
  assert.equal(
    choose({ published: ['0.1.0', '1.0.0-beta.1'], tags: [tag('0.9.0')] }).version,
    '1.0.0',
  );
});

test('the highest occupied stable version across npm and Git determines the next patch', () => {
  assert.equal(choose({ published: ['1.0.0'], tags: [tag('1.0.0')] }).version, '1.0.1');
  assert.equal(choose({ published: ['1.0.9', '1.0.10'] }).version, '1.0.11');
  assert.equal(choose({ published: ['1.2.3', '2.0.0'] }).version, '2.0.1');
});

test('an unpublished reserved tag is resumed without allocating another version', () => {
  const result = choose({ published: ['1.0.0'], tags: [tag('1.0.0'), tag('1.0.1')] });
  assert.equal(result.mode, 'resume');
  assert.equal(result.version, '1.0.1');
});

test('rerunning the original workflow keeps its release even after npm publication', () => {
  const result = choose({ published: ['1.0.0'], tags: [tag('1.0.0', '2')] });
  assert.equal(result.mode, 'resume');
  assert.equal(result.version, '1.0.0');
});

test('explicit recovery selects the existing immutable tag even when npm already has that version', () => {
  const result = choose({
    published: ['1.0.0', '1.0.1'],
    tags: [tag('1.0.0'), tag('1.0.1')],
    resumeTag: 'v1.0.0',
  });
  assert.equal(result.version, '1.0.0');
  assert.equal(result.mode, 'resume');
  assert.throws(() => choose({ resumeTag: 'v1.0.0' }), /does not exist/);
  assert.throws(() => choose({ resumeTag: '--force' }), /resume_tag/);
});

test('a version intent already on main can repair a missing tag without another version commit', () => {
  const result = choose({ published: ['1.0.0'], tags: [tag('1.0.0')], untagged: [tag('1.0.1')] });
  assert.equal(result.mode, 'repair');
  assert.equal(result.version, '1.0.1');
});

test('ambiguous pending releases fail instead of silently choosing or overwriting one', () => {
  assert.throws(() => choose({ tags: [tag('1.0.0'), tag('1.0.1')] }), /Multiple unpublished/);
  assert.throws(() => choose({ tags: [tag('1.0.0', '2'), tag('1.0.1', '2')] }), /same run ID/);
  assert.throws(() => choose({ untagged: [tag('1.0.0'), tag('1.0.1')] }), /Multiple untagged/);
});
