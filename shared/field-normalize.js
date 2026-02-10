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
export function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Normalize an object's keys from camelCase to snake_case.
 * Non-string keys and nested objects are left as-is (shallow transform).
 * Keys that are already snake_case pass through unchanged.
 *
 * @param {object} obj - Input object with potentially mixed-case keys
 * @returns {object} New object with snake_case keys
 */
export function normalizeKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = camelToSnake(key);
    // If both camelCase and snake_case versions exist, prefer the explicit snake_case
    if (snakeKey !== key && obj[snakeKey] !== undefined) {
      result[snakeKey] = obj[snakeKey];
    } else {
      result[snakeKey] = value;
    }
  }
  return result;
}
