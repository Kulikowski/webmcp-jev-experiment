/**
 * Pure decision logic for turning a page's WebMCP tools into a Jev request,
 * and a Jev response back into a tool call. No DOM, no chrome.*, no direct
 * network calls (the LLM fallback call itself stays in sidebar.js - this
 * module only prepares its narrowed schema and merges its result back in) -
 * safe to unit test directly against fixture responses.
 */

import {
  enumValues,
  setItemValues,
  choiceProperties,
  setProperties,
  unfillableProperties,
} from './tools.js';
import { formatConfidence, formatRanked, formatRouteReasoning, indent } from './format.js';

export const FINISH_CHOICE = '__finish_task__';

export function columnFor(provider) {
  return provider === 'Jev' ? 'jev' : 'llm';
}

/** Builds the single batched Jev request: routing plus every candidate tool's
 *  speculative Choice/Noul argument questions. */
export function buildJevQuestions(tools, finishChoice = FINISH_CHOICE) {
  const routeCriteria = {};
  const questions = {};
  const argumentPlans = new Map();

  for (const [toolIndex, tool] of tools.entries()) {
    routeCriteria[tool.name] = tool.description || tool.name;

    const choicePlans = [];
    for (const [propertyIndex, [name, schema]] of choiceProperties(tool).entries()) {
      const questionId = `arg_${toolIndex}_${propertyIndex}`;
      const criteria = {};
      const valueByChoice = {};

      for (const value of enumValues(schema)) {
        const key = String(value);
        criteria[key] = key;
        valueByChoice[key] = value;
      }

      questions[questionId] = {
        type: 'choice',
        instructions:
          `If the next action is "${tool.name}" (${tool.description || 'no description'}), ` +
          `what should its "${name}" argument be? ${schema.description || ''}`,
        criteria,
      };
      choicePlans.push({ name, questionId, valueByChoice });
    }

    // "Set" properties (an array whose items are drawn from a fixed enum, so
    // any number of them may apply) get one Noul yes/no question per
    // candidate item - Jev has no primitive for "pick a subset" directly.
    const setPlans = [];
    for (const [propertyIndex, [name, schema]] of setProperties(tool).entries()) {
      const items = setItemValues(schema).map((item, itemIndex) => {
        const questionId = `set_${toolIndex}_${propertyIndex}_${itemIndex}`;
        questions[questionId] = {
          type: 'noul',
          instructions:
            `If the next action is "${tool.name}" (${tool.description || 'no description'}), ` +
            `should "${item}" be included in its "${name}" argument? ${schema.description || ''}`,
        };
        return { item, questionId };
      });
      setPlans.push({ name, items });
    }

    argumentPlans.set(tool.name, { choicePlans, setPlans });
  }

  routeCriteria[finishChoice] =
    'Stop only when the user objective is clearly complete, or no available tool can make further progress.';
  questions.route = {
    type: 'choice',
    instructions:
      'Given the user objective and the chronological tool-call history, which single action should happen next? ' +
      'Use tool results to continue working. Do not stop merely because one tool has run. ' +
      'Choose "__finish_task__" only when the objective is complete or further progress is impossible.',
    criteria: routeCriteria,
  };

  return { questions, routeCriteria, argumentPlans };
}

/** Turns a Jev response into a decision. Either a finished/pure-Jev result,
 *  or `{ needsLLM: true, ... }` describing what's left for the LLM fallback
 *  (the actual LLM call happens in sidebar.js; see `finalizeHybridDecision`). */
export function interpretDecision({ response, tools, routeCriteria, argumentPlans, finishChoice = FINISH_CHOICE }) {
  const route = response.answers.route;
  const routeReasoning = formatRouteReasoning(route, routeCriteria);

  if (!route || route.choice === finishChoice) {
    return { finished: true, provider: 'Jev', confidence: route?.confidence, reasoning: routeReasoning };
  }

  const tool = tools.find((candidate) => candidate.name === route.choice);
  if (!tool) {
    return { finished: true, provider: 'Jev', confidence: route.confidence, reasoning: routeReasoning };
  }

  const plans = argumentPlans.get(tool.name) || { choicePlans: [], setPlans: [] };
  const jevArgs = {};
  const argLines = [];

  for (const plan of plans.choicePlans) {
    const answer = response.answers[plan.questionId];
    const choice = answer?.choice;
    if (choice !== undefined && choice in plan.valueByChoice) {
      jevArgs[plan.name] = plan.valueByChoice[choice];
    }
    argLines.push(
      `"${plan.name}" = ${choice ?? 'n/a'} (confidence ${formatConfidence(answer?.confidence)})\n` +
        indent(formatRanked(answer?.probabilities, choice)),
    );
  }

  for (const plan of plans.setPlans) {
    const included = [];
    const itemLines = [];
    for (const { item, questionId } of plan.items) {
      const p = response.answers[questionId]?.noul;
      const yes = typeof p === 'number' && p >= 0.5;
      if (yes) included.push(item);
      itemLines.push(`${yes ? '✓' : '✗'} ${item}: ${typeof p === 'number' ? p.toFixed(2) : 'n/a'}`);
    }
    if (included.length) jevArgs[plan.name] = included;
    argLines.push(`"${plan.name}" = ${JSON.stringify(included)}\n${indent(itemLines.join('\n'))}`);
  }

  const reasoning = argLines.length ? `${routeReasoning}\n\n${argLines.join('\n\n')}` : routeReasoning;
  const remaining = unfillableProperties(tool);
  const jevFilledCount = plans.choicePlans.length + plans.setPlans.length;

  if (remaining.length === 0) {
    return { finished: false, tool, args: jevArgs, provider: 'Jev', confidence: route.confidence, reasoning };
  }

  // Jev filled whatever enumerable properties this tool has; only the
  // remaining free-text/numeric ones need to go to the LLM.
  const narrowedProperties = Object.fromEntries(remaining);
  const narrowedRequired = (tool.inputSchema?.required || []).filter((name) => name in narrowedProperties);
  const narrowedTool = {
    ...tool,
    inputSchema: {
      type: 'object',
      properties: narrowedProperties,
      ...(narrowedRequired.length ? { required: narrowedRequired } : {}),
    },
  };

  return {
    finished: false,
    needsLLM: true,
    tool,
    narrowedTool,
    jevArgs,
    remaining,
    jevFilledCount,
    confidence: route.confidence,
    reasoning,
  };
}

/** Merges the LLM's answer for the remaining properties into a `needsLLM`
 *  decision, producing the final tool call plus its explanatory note. */
export function finalizeHybridDecision(decision, { llmArgs, provider, model }) {
  const note =
    `Routed to ${provider} (${model}): argument${decision.remaining.length === 1 ? '' : 's'} ` +
    decision.remaining
      .map(([name, schema]) => `"${name}" (type "${schema?.type || 'unknown'}", not enumerable)`)
      .join(', ') +
    ' need free text - not enumerable, so Jev cannot fill them.' +
    (decision.jevFilledCount
      ? ` Jev already filled ${decision.jevFilledCount} enumerable argument${decision.jevFilledCount === 1 ? '' : 's'} itself.`
      : '');

  return {
    finished: false,
    tool: decision.tool,
    args: { ...decision.jevArgs, ...llmArgs },
    provider,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    note,
  };
}
