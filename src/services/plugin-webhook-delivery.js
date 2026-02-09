/**
 * Plugin Webhook Delivery Service
 *
 * Handles the HTTP delivery of events to webhook-type plugins.
 * Includes HMAC signature generation for payload verification
 * (same pattern as GitHub webhooks).
 *
 * Webhook plugins receive POST requests with:
 *   Headers:
 *     X-GitSwarm-Event: <event_type>
 *     X-GitSwarm-Delivery: <event_id>
 *     X-GitSwarm-Signature-256: sha256=<hmac>
 *     Content-Type: application/json
 *
 *   Body:
 *     { event, installation_id, repo_id, config, data }
 *
 * Plugins respond with:
 *   { actions: [{ action, target_type, target_id, data }] }
 */

import crypto from 'crypto';

class PluginWebhookDelivery {
  constructor({ timeout = 10000 } = {}) {
    this.timeout = timeout;
  }

  /**
   * Deliver an event payload to a webhook URL.
   *
   * @param {object} options
   * @param {string} options.url - Webhook endpoint URL
   * @param {string} options.secretHash - SHA-256 hash of the webhook secret
   * @param {string} options.eventId - Unique event ID for idempotency
   * @param {string} options.eventType - Event type header
   * @param {object} options.payload - JSON payload to deliver
   * @returns {Promise<{status: number, body: object, actions: Array}>}
   */
  async deliver({ url, secretHash, eventId, eventType, payload }) {
    const body = JSON.stringify(payload);

    // Generate HMAC signature
    // Note: we sign with the hash of the secret, not the secret itself.
    // The plugin owner has the actual secret; we store only the hash.
    // For signature verification, we use a derived signing key.
    const signature = this._generateSignature(body, secretHash);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitSwarm-Event': eventType,
          'X-GitSwarm-Delivery': eventId,
          'X-GitSwarm-Signature-256': `sha256=${signature}`,
          'User-Agent': 'GitSwarm-Hookshot/1.0',
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let responseBody = {};
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          responseBody = await response.json();
        } catch {
          responseBody = {};
        }
      }

      if (!response.ok) {
        const error = new Error(`Webhook returned ${response.status}: ${response.statusText}`);
        error.statusCode = response.status;
        throw error;
      }

      return {
        status: response.status,
        body: responseBody,
        actions: responseBody.actions || [],
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        const timeoutError = new Error(`Webhook timed out after ${this.timeout}ms`);
        timeoutError.statusCode = 408;
        throw timeoutError;
      }

      throw error;
    }
  }

  /**
   * Generate HMAC-SHA256 signature for payload verification.
   */
  _generateSignature(body, secretHash) {
    return crypto
      .createHmac('sha256', secretHash)
      .update(body)
      .digest('hex');
  }
}

export default PluginWebhookDelivery;
