/**
 * Builtin Plugins — Tier 1 (deterministic automations) for CLI.
 *
 * These run locally in Mode A or Mode B. Tier 2 (AI) and Tier 3
 * (governance) plugins are server-only and dispatch to GitHub Actions.
 *
 * Each plugin has:
 *   trigger: string  — the event that fires this plugin
 *   execute: async (federation, repo, eventData) => result
 */

export const BUILTIN_PLUGINS = {
  /**
   * Auto-promote buffer to main when stabilization passes.
   * Respects the repo's auto_promote_on_green setting.
   */
  promote_buffer_to_main: {
    trigger: 'stabilization_passed',
    async execute(federation, repo, event) {
      if (!repo.auto_promote_on_green) return { skipped: true, reason: 'auto_promote_off' };
      try {
        const result = await federation.promote({ tag: event.tag });
        return { promoted: true, ...result };
      } catch (err) {
        return { promoted: false, error: err.message };
      }
    },
  },

  /**
   * Auto-revert the last merge when stabilization fails.
   * Respects the repo's auto_revert_on_red setting.
   * Note: the main stabilize() method already handles revert logic,
   * so this plugin is a no-op by default to avoid double-revert.
   * It's here as an extension point for repos that want custom revert behavior.
   */
  auto_revert_on_red: {
    trigger: 'stabilization_failed',
    async execute(federation, repo, event) {
      // The stabilize() method already handles auto_revert_on_red directly.
      // This plugin exists as a named hook for the plugin system but defers
      // to the built-in revert logic to avoid double-revert.
      return { skipped: true, reason: 'handled_by_stabilize' };
    },
  },
};
