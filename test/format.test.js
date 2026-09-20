import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatConfidence,
  indent,
  formatRanked,
  formatRouteReasoning,
  formatCall,
  formatResult,
  normalizeResult,
  stableStringify,
} from '../format.js';

test('formatConfidence: formats a number to 2 decimals, else n/a', () => {
  assert.equal(formatConfidence(0.8234), '0.82');
  assert.equal(formatConfidence(undefined), 'n/a');
  assert.equal(formatConfidence(null), 'n/a');
  assert.equal(formatConfidence('0.9'), 'n/a');
});

test('indent: prefixes every line with two spaces', () => {
  assert.equal(indent('a\nb'), '  a\n  b');
  assert.equal(indent('solo'), '  solo');
});

test('formatRanked: sorts by probability descending and marks the chosen key', () => {
  const lines = formatRanked({ a: 0.1, b: 0.7, c: 0.2 }, 'b').split('\n');
  assert.equal(lines[0], '→ b: 0.70');
  assert.equal(lines[1], '  c: 0.20');
  assert.equal(lines[2], '  a: 0.10');
});

test('formatRanked: reports missing probabilities explicitly instead of crashing', () => {
  assert.match(formatRanked(undefined, 'x'), /no probability breakdown/);
});

test('formatRouteReasoning: reports a missing route explicitly', () => {
  assert.equal(formatRouteReasoning(undefined, {}), 'No route answer returned.');
});

test('formatRouteReasoning: ranks candidates by probability and marks the chosen one', () => {
  const route = { choice: 'look', confidence: 0.9, probabilities: { look: 0.9, move: 0.1 } };
  const text = formatRouteReasoning(route, { look: 'Look around', move: 'Move somewhere' });
  assert.match(text, /Selected "look" \(confidence 0\.90\)/);
  assert.match(text, /→ look \(0\.90\): Look around/);
  assert.match(text, / {2}move \(0\.10\): Move somewhere/);
});

test('formatRouteReasoning: flags an all-or-nothing split as informative on its own', () => {
  const route = { choice: 'look', probabilities: { look: 1, move: 0 } };
  assert.match(formatRouteReasoning(route, { look: 'a', move: 'b' }), /all-or-nothing split/);
});

test('formatRouteReasoning: does not flag a genuinely mixed distribution', () => {
  const route = { choice: 'look', probabilities: { look: 0.6, move: 0.4 } };
  assert.doesNotMatch(formatRouteReasoning(route, { look: 'a', move: 'b' }), /all-or-nothing split/);
});

test('formatCall: renders name(args) as compact JSON', () => {
  assert.equal(formatCall('move', { direction: 'north' }), 'move({"direction":"north"})');
});

test('formatResult: pretty-prints a JSON string result', () => {
  assert.equal(formatResult('{"success":true}'), '{\n  "success": true\n}');
});

test('formatResult: passes a non-JSON string through as-is', () => {
  assert.equal(formatResult('plain text'), 'plain text');
});

test('formatResult: reports undefined as the literal string "null"', () => {
  assert.equal(formatResult(undefined), 'null');
});

test('normalizeResult: parses a JSON string result into an object', () => {
  assert.deepEqual(normalizeResult('{"a":1}'), { a: 1 });
});

test('normalizeResult: leaves a non-JSON string, and non-string values, alone', () => {
  assert.equal(normalizeResult('plain text'), 'plain text');
  assert.deepEqual(normalizeResult({ a: 1 }), { a: 1 });
});

test('stableStringify: key order does not affect the output', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
});

test('stableStringify: distinguishes genuinely different values', () => {
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('stableStringify: handles arrays and nested objects, still order-independent inside them', () => {
  assert.equal(
    stableStringify({ list: [1, 2], obj: { z: 1, a: 2 } }),
    '{"list":[1,2],"obj":{"a":2,"z":1}}',
  );
});
