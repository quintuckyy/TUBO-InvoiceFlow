import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStatus } from '../src/processing/governmentClient.js';
import { computeBackoffMs, decideNextStep } from '../src/processing/retryPolicy.js';

const policy = { maxAutoAttempts: 3, baseMs: 1000, maxMs: 5000 };

test('backoff grows exponentially and is capped', () => {
  const noJitter = () => 1; // upper bound of the jitter range
  assert.equal(computeBackoffMs(1, policy, noJitter), 1000);
  assert.equal(computeBackoffMs(2, policy, noJitter), 2000);
  assert.equal(computeBackoffMs(3, policy, noJitter), 4000);
  assert.equal(computeBackoffMs(10, policy, noJitter), 5000);
  assert.equal(computeBackoffMs(3, policy, () => 0), 2000); // lower bound is half
});

test('production retry policy outlasts a 30-minute outage even with the shortest jitter', () => {
  const production = { maxAutoAttempts: 14, baseMs: 5000, maxMs: 10 * 60 * 1000 }; // defaults in src/config.js
  const totalWait = (random) => {
    let total = 0;
    // Waits happen after attempts 1..13; attempt 14 failing means FAILED.
    for (let attempt = 1; attempt < production.maxAutoAttempts; attempt++) {
      total += computeBackoffMs(attempt, production, random);
    }
    return total;
  };
  assert.ok(totalWait(() => 0) >= 30 * 60 * 1000, 'shortest retry window must exceed 30 minutes');
  assert.ok(totalWait(() => 1) <= 75 * 60 * 1000, 'longest retry window should stay bounded');
});

test('HTTP statuses map to the right outcome', () => {
  assert.equal(classifyStatus(200), 'SUCCESS');
  assert.equal(classifyStatus(400), 'REJECTED');
  assert.equal(classifyStatus(503), 'RETRYABLE_ERROR');
  assert.equal(classifyStatus(429), 'RETRYABLE_ERROR');
  assert.equal(classifyStatus(401), 'ERROR');
});

test('retryable failures are retried until the budget is exhausted', () => {
  assert.equal(decideNextStep('TIMEOUT', 1, policy, 0).status, 'RETRYING');
  assert.equal(decideNextStep('RETRYABLE_ERROR', 2, policy, 0).status, 'RETRYING');
  assert.equal(decideNextStep('RETRYABLE_ERROR', 3, policy, 0).status, 'FAILED');
});

test('permanent outcomes are not retried automatically', () => {
  assert.equal(decideNextStep('SUCCESS', 1, policy).status, 'SUBMITTED');
  assert.equal(decideNextStep('REJECTED', 1, policy).status, 'REJECTED');
  assert.equal(decideNextStep('ERROR', 1, policy).status, 'FAILED');
});
