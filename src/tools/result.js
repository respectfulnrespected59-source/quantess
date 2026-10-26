/**
 * Tool result wrapper - every tool returns this shape
 */
export function toolResult({ status, summary, nextActions = [], artifacts = [], data = null, error = null }) {
  return { status, summary, nextActions, artifacts, data, error };
}
