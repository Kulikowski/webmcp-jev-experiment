/**
 * Pure string formatting for the activity log. No DOM, no chrome.*, no
 * network - safe to unit test directly.
 */

export function formatConfidence(confidence) {
  return typeof confidence === 'number' ? confidence.toFixed(2) : 'n/a';
}

export function indent(text) {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

export function formatRanked(probabilities, chosen) {
  if (!probabilities) return '(no probability breakdown returned)';
  return Object.entries(probabilities)
    .sort(([, a], [, b]) => b - a)
    .map(([key, value]) => `${key === chosen ? '→' : ' '} ${key}: ${value.toFixed(2)}`)
    .join('\n');
}

// Jev never explains a choice in words - it only returns a probability per
// criterion. The only way to show "why" is to print the actual criterion
// text it compared the objective against, ranked by probability, so a human
// can judge the match themselves. When the winner takes 100% and everyone
// else gets exactly 0.00, that itself is informative: it means the objective
// had no semantic overlap at all with any other candidate's description.
export function formatRouteReasoning(route, routeCriteria) {
  if (!route) return 'No route answer returned.';
  const probabilities = route.probabilities || {};
  const ranked = Object.keys(routeCriteria)
    .sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))
    .map((name) => {
      const p = probabilities[name];
      const marker = name === route.choice ? '→' : ' ';
      const pct = typeof p === 'number' ? p.toFixed(2) : 'n/a';
      return `${marker} ${name} (${pct}): ${routeCriteria[name]}`;
    })
    .join('\n');
  const flat = Object.values(probabilities).every((p) => p === 0 || p === 1);
  const note = flat
    ? '\n(all-or-nothing split - the objective didn\'t overlap at all with the other candidates\' descriptions)'
    : '';
  return (
    `Selected "${route.choice}" (confidence ${formatConfidence(route.confidence)}) - ` +
    `criteria compared:\n${indent(ranked)}${note}`
  );
}

export function formatCall(name, args) {
  return `${name}(${JSON.stringify(args)})`;
}

export function formatResult(result) {
  if (result === undefined) return 'null';
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }
}

export function normalizeResult(result) {
  if (typeof result !== 'string') return result;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}
