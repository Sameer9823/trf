import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ANALYSIS_STATUS_TRANSITIONS, COA_STATUS_TRANSITIONS, TRF_STATUS_TRANSITIONS,
  canTransitionAnalysis, canTransitionTrf,
} from '@trf/shared';

test('a TRF cannot leave a terminal status', () => {
  assert.deepEqual(TRF_STATUS_TRANSITIONS.Completed, []);
  assert.deepEqual(TRF_STATUS_TRANSITIONS.Cancelled, []);
  for (const status of ['Completed', 'Cancelled'] as const) {
    for (const target of Object.keys(TRF_STATUS_TRANSITIONS) as (keyof typeof TRF_STATUS_TRANSITIONS)[]) {
      assert.equal(canTransitionTrf(status, target), false, `${status} -> ${target} must be rejected`);
    }
  }
});

test('TRF statuses move forward one step at a time', () => {
  assert.equal(canTransitionTrf('New', 'Assigned'), true);
  assert.equal(canTransitionTrf('New', 'Completed'), false);
  assert.equal(canTransitionTrf('Analysis Completed', 'COA Pending'), true);
  assert.equal(canTransitionTrf('COA Pending', 'Completed'), true);
  // Every non-terminal status can be cancelled.
  for (const status of ['New', 'Assigned', 'In Progress', 'Analysis Completed', 'COA Pending'] as const) {
    assert.equal(canTransitionTrf(status, 'Cancelled'), true, `${status} -> Cancelled must be allowed`);
  }
});

test('a completed analysis can only be sent for a re-test', () => {
  assert.deepEqual(ANALYSIS_STATUS_TRANSITIONS.Completed, ['Re-test Required']);
  assert.equal(canTransitionAnalysis('Completed', 'In Progress'), false);
  assert.equal(canTransitionAnalysis('In Progress', 'Completed'), true);
  assert.equal(canTransitionAnalysis('Re-test Required', 'In Progress'), true);
  assert.deepEqual(ANALYSIS_STATUS_TRANSITIONS.Cancelled, []);
});

test('COA moves Pending to Issued without skipping review', () => {
  assert.deepEqual(COA_STATUS_TRANSITIONS.Pending, ['Draft']);
  assert.equal(COA_STATUS_TRANSITIONS.Draft.includes('Approved'), false);
  assert.equal(COA_STATUS_TRANSITIONS['Under Review'].includes('Approved'), true);
  assert.deepEqual(COA_STATUS_TRANSITIONS.Issued, []);
});

test('an unknown status allows nothing', () => {
  assert.equal(canTransitionTrf('Cancelled', 'Draft' as never), false);
  assert.equal(canTransitionAnalysis('Cancelled', 'Completed' as never), false);
});
