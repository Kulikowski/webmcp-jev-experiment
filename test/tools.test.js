import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumValues, setItemValues, choiceProperties, setProperties, unfillableProperties } from '../tools.js';

test('enumValues: reads a JSON Schema enum array', () => {
  assert.deepEqual(enumValues({ type: 'string', enum: ['north', 'south'] }), ['north', 'south']);
});

test('enumValues: treats boolean as an implicit two-value enum', () => {
  assert.deepEqual(enumValues({ type: 'boolean' }), [true, false]);
});

test('enumValues: returns null for free-text/numeric schemas and missing schemas', () => {
  assert.equal(enumValues({ type: 'string' }), null);
  assert.equal(enumValues({ type: 'number' }), null);
  assert.equal(enumValues(undefined), null);
});

test('setItemValues: reads enum values nested under array items ("Set" shape)', () => {
  const schema = { type: 'array', items: { type: 'string', enum: ['pool', 'wifi'] } };
  assert.deepEqual(setItemValues(schema), ['pool', 'wifi']);
});

test('setItemValues: returns null for a non-array, or an array without items.enum', () => {
  assert.equal(setItemValues({ type: 'string' }), null);
  assert.equal(setItemValues({ type: 'array', items: { type: 'string' } }), null);
  assert.equal(setItemValues(undefined), null);
});

test('choiceProperties: picks up enum and boolean properties, ignores free-text ones', () => {
  const tool = {
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['north', 'south'] },
        confirm: { type: 'boolean' },
        note: { type: 'string' },
      },
    },
  };
  const names = choiceProperties(tool)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(names, ['confirm', 'direction']);
});

test('choiceProperties/setProperties/unfillableProperties: classify the filter_search_results schema', () => {
  // The exact tool schema this classification logic was reported broken against.
  const tool = {
    name: 'filter_search_results',
    description: 'Filter the search results by max price and required amenities',
    inputSchema: {
      type: 'object',
      properties: {
        max_price: { type: 'number', description: 'Maximum price per night' },
        amenities: {
          type: 'array',
          items: { type: 'string', enum: ['pool', 'wifi', 'parking'] },
          description: 'Required amenities',
        },
      },
    },
  };

  assert.deepEqual(choiceProperties(tool), []);

  const sets = setProperties(tool);
  assert.equal(sets.length, 1);
  assert.equal(sets[0][0], 'amenities');

  const remaining = unfillableProperties(tool);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0][0], 'max_price');
});

test('unfillableProperties: a tool with only enumerable properties (Choice + Set) needs nothing else', () => {
  const tool = {
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['north', 'south'] },
        amenities: { type: 'array', items: { type: 'string', enum: ['pool'] } },
      },
    },
  };
  assert.deepEqual(unfillableProperties(tool), []);
});

test('unfillableProperties: an optional free-text property still counts - required-ness is irrelevant', () => {
  const tool = {
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      // deliberately no "required" array at all
    },
  };
  assert.equal(unfillableProperties(tool).length, 1);
  assert.equal(unfillableProperties(tool)[0][0], 'note');
});

test('unfillableProperties: a tool with no properties, or no inputSchema, is vacuously enumerable', () => {
  assert.deepEqual(unfillableProperties({ inputSchema: { type: 'object', properties: {} } }), []);
  assert.deepEqual(unfillableProperties({ name: 'look' }), []);
});
