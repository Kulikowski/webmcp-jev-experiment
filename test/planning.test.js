import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJevQuestions,
  interpretDecision,
  finalizeHybridDecision,
  columnFor,
  FINISH_CHOICE,
} from '../planning.js';

const lookTool = {
  name: 'look',
  description: 'Look around',
  inputSchema: { type: 'object', properties: {} },
};

const moveTool = {
  name: 'move',
  description: 'Move the player',
  inputSchema: {
    type: 'object',
    properties: { direction: { type: 'string', enum: ['north', 'south', 'east', 'west'] } },
    required: ['direction'],
  },
};

// The exact schema this whole hybrid-filling design was built to handle.
const filterTool = {
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

test('buildJevQuestions: routes over every tool plus __finish_task__', () => {
  const { routeCriteria, questions } = buildJevQuestions([lookTool, moveTool]);
  assert.deepEqual(Object.keys(routeCriteria).sort(), ['__finish_task__', 'look', 'move']);
  assert.equal(questions.route.type, 'choice');
  assert.deepEqual(Object.keys(questions.route.criteria).sort(), ['__finish_task__', 'look', 'move']);
});

test('buildJevQuestions: builds one Choice question per enum/boolean property', () => {
  const { questions, argumentPlans } = buildJevQuestions([moveTool]);
  const plans = argumentPlans.get('move');
  assert.equal(plans.choicePlans.length, 1);
  assert.equal(plans.choicePlans[0].name, 'direction');
  const q = questions[plans.choicePlans[0].questionId];
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria).sort(), ['east', 'north', 'south', 'west']);
});

test('buildJevQuestions: builds one Noul question per candidate item of a Set property', () => {
  const { questions, argumentPlans } = buildJevQuestions([filterTool]);
  const plans = argumentPlans.get('filter_search_results');
  assert.equal(plans.setPlans.length, 1);
  assert.equal(plans.setPlans[0].name, 'amenities');
  assert.equal(plans.setPlans[0].items.length, 3);
  for (const { questionId } of plans.setPlans[0].items) {
    assert.equal(questions[questionId].type, 'noul');
  }
  // max_price is not enumerable, so it gets no speculative question at all.
  assert.equal(plans.choicePlans.length, 0);
});

test('buildJevQuestions: a tool with no properties contributes no argument questions', () => {
  const { argumentPlans } = buildJevQuestions([lookTool]);
  assert.deepEqual(argumentPlans.get('look'), { choicePlans: [], setPlans: [] });
});

test('interpretDecision: __finish_task__ ends the run under the Jev provider', () => {
  const { routeCriteria, argumentPlans } = buildJevQuestions([lookTool]);
  const response = { answers: { route: { choice: FINISH_CHOICE, confidence: 0.9, probabilities: {} } } };
  const decision = interpretDecision({ response, tools: [lookTool], routeCriteria, argumentPlans });
  assert.equal(decision.finished, true);
  assert.equal(decision.provider, 'Jev');
});

test('interpretDecision: an unrecognized route choice also finishes gracefully instead of throwing', () => {
  const { routeCriteria, argumentPlans } = buildJevQuestions([lookTool]);
  const response = { answers: { route: { choice: 'not_a_real_tool', confidence: 0.5, probabilities: {} } } };
  const decision = interpretDecision({ response, tools: [lookTool], routeCriteria, argumentPlans });
  assert.equal(decision.finished, true);
  assert.equal(decision.provider, 'Jev');
});

test('interpretDecision: a fully enumerable tool needs no LLM and fills its Choice argument', () => {
  const { routeCriteria, argumentPlans } = buildJevQuestions([lookTool, moveTool]);
  const plan = argumentPlans.get('move').choicePlans[0];
  const response = {
    answers: {
      route: { choice: 'move', confidence: 0.95, probabilities: { move: 0.95, look: 0.05 } },
      [plan.questionId]: {
        choice: 'north',
        confidence: 0.8,
        probabilities: { north: 0.8, south: 0.1, east: 0.05, west: 0.05 },
      },
    },
  };
  const decision = interpretDecision({ response, tools: [lookTool, moveTool], routeCriteria, argumentPlans });
  assert.equal(decision.finished, false);
  assert.equal(decision.needsLLM, undefined);
  assert.equal(decision.provider, 'Jev');
  assert.deepEqual(decision.args, { direction: 'north' });
});

test('interpretDecision: filter_search_results - Jev fills amenities, max_price is left for the LLM', () => {
  const { routeCriteria, argumentPlans } = buildJevQuestions([filterTool]);
  const items = argumentPlans.get('filter_search_results').setPlans[0].items;
  const answers = {
    route: { choice: 'filter_search_results', confidence: 0.9, probabilities: { filter_search_results: 0.9 } },
  };
  for (const { item, questionId } of items) {
    answers[questionId] = { noul: item === 'pool' ? 0.9 : 0.1 };
  }

  const decision = interpretDecision({
    response: { answers },
    tools: [filterTool],
    routeCriteria,
    argumentPlans,
  });

  assert.equal(decision.finished, false);
  assert.equal(decision.needsLLM, true);
  assert.deepEqual(decision.jevArgs, { amenities: ['pool'] });
  assert.equal(decision.remaining.length, 1);
  assert.equal(decision.remaining[0][0], 'max_price');
  assert.deepEqual(decision.narrowedTool.inputSchema.properties.max_price, filterTool.inputSchema.properties.max_price);
  assert.equal('amenities' in decision.narrowedTool.inputSchema.properties, false);
});

test('interpretDecision: a Set property with every item below threshold is omitted from args entirely', () => {
  const { routeCriteria, argumentPlans } = buildJevQuestions([filterTool]);
  const items = argumentPlans.get('filter_search_results').setPlans[0].items;
  const answers = {
    route: { choice: 'filter_search_results', confidence: 0.9, probabilities: {} },
  };
  for (const { questionId } of items) answers[questionId] = { noul: 0.1 };

  const decision = interpretDecision({
    response: { answers },
    tools: [filterTool],
    routeCriteria,
    argumentPlans,
  });
  assert.equal('amenities' in decision.jevArgs, false);
});

test('finalizeHybridDecision: merges Jev and LLM args and explains the split in the note', () => {
  const decision = {
    tool: filterTool,
    jevArgs: { amenities: ['pool'] },
    remaining: [['max_price', filterTool.inputSchema.properties.max_price]],
    jevFilledCount: 1,
    confidence: 0.9,
    reasoning: 'reasoning text',
  };
  const final = finalizeHybridDecision(decision, {
    llmArgs: { max_price: 100 },
    provider: 'Anthropic',
    model: 'Sonnet 5',
  });

  assert.deepEqual(final.args, { amenities: ['pool'], max_price: 100 });
  assert.equal(final.provider, 'Anthropic');
  assert.match(final.note, /Routed to Anthropic \(Sonnet 5\)/);
  assert.match(final.note, /"max_price"/);
  assert.match(final.note, /Jev already filled 1 enumerable argument itself/);
});

test('finalizeHybridDecision: pluralizes correctly when the LLM had to fill more than one argument', () => {
  const decision = {
    tool: { name: 'x' },
    jevArgs: {},
    remaining: [
      ['a', { type: 'string' }],
      ['b', { type: 'number' }],
    ],
    jevFilledCount: 0,
    confidence: 0.5,
    reasoning: '',
  };
  const final = finalizeHybridDecision(decision, { llmArgs: { a: '1', b: 2 }, provider: 'OpenAI', model: 'GPT-5.6' });
  assert.match(final.note, /arguments "a".*"b"/);
  assert.doesNotMatch(final.note, /Jev already filled/);
});

test('columnFor: Jev goes to the jev column, every other provider to llm', () => {
  assert.equal(columnFor('Jev'), 'jev');
  assert.equal(columnFor('Anthropic'), 'llm');
  assert.equal(columnFor('OpenAI'), 'llm');
  assert.equal(columnFor('Google'), 'llm');
});
