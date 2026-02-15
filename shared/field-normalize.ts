/**
 * Field Normalization Utility
 *
 * Converts between camelCase and snake_case for sync protocol fields.
 * The CLI sends camelCase (JS convention), the server stores snake_case
 * (SQL convention). This utility normalizes at the boundary so individual
 * handlers don't need scattered fallback patterns.
 */

/**
 * Convert a camelCase string to snake_case.
 * Example: 'baseBranch' -> 'base_branch'
 */
export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter: string) => `_${letter.toLowerCase()}`);
}

/**
 * Normalize an object's keys from camelCase to snake_case.
 * BUG-14 fix: Recursively normalizes nested objects (previously shallow-only).
 * Keys that are already snake_case pass through unchanged.
 *
 * @param obj - Input object with potentially mixed-case keys
 * @returns New object with snake_case keys
 */
export function normalizeKeys(obj: Record<string, unknown>): Record<string, unknown>;
export function normalizeKeys(obj: unknown): unknown;
export function normalizeKeys(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;

  const input = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const snakeKey: string = camelToSnake(key);
    // Recursively normalize nested objects
    const normalizedValue: unknown = (value && typeof value === 'object' && !Array.isArray(value))
      ? normalizeKeys(value as Record<string, unknown>)
      : value;
    // If both camelCase and snake_case versions exist, prefer the explicit snake_case
    if (snakeKey !== key && input[snakeKey] !== undefined) {
      result[snakeKey] = input[snakeKey];
    } else {
      result[snakeKey] = normalizedValue;
    }
  }
  return result;
}
