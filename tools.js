/**
 * Schema helpers for deciding which parts of a tool call Jev can fill itself.
 * Jev can represent two enumerable shapes:
 *   - Choice/Flag: one value from an `enum` (or a boolean's true/false).
 *   - Set: any number of values from an array property whose `items.enum`
 *     is fixed - filled as one Noul (yes/no) question per candidate item.
 * Anything else (free text, numbers, unconstrained arrays) needs the LLM
 * fallback, whether or not the property is marked `required` - an optional
 * free-text field can still be essential to the user's requested action.
 */

export function enumValues(schema) {
  if (!schema) return null;
  if (Array.isArray(schema.enum)) return schema.enum;
  if (schema.type === 'boolean') return [true, false];
  return null;
}

/** Candidate values for an array property whose items are drawn from a fixed enum. */
export function setItemValues(schema) {
  if (schema?.type === 'array' && Array.isArray(schema.items?.enum)) return schema.items.enum;
  return null;
}

function isEnumerable(schema) {
  return enumValues(schema) !== null || setItemValues(schema) !== null;
}

/** Choice/Flag-shaped properties: one value picked from a fixed list. */
export function choiceProperties(tool) {
  return Object.entries(tool.inputSchema?.properties || {}).filter(
    ([, schema]) => enumValues(schema) !== null,
  );
}

/** Set-shaped properties: any number of values picked from a fixed list. */
export function setProperties(tool) {
  return Object.entries(tool.inputSchema?.properties || {}).filter(
    ([, schema]) => setItemValues(schema) !== null,
  );
}

/** Properties Jev cannot represent at all - why the LLM has to take over for these. */
export function unfillableProperties(tool) {
  const properties = tool.inputSchema?.properties || {};
  return Object.entries(properties).filter(([, schema]) => !isEnumerable(schema));
}
