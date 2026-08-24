import axios from 'axios';

export class HttpExecutionService {
  static isBlockedHost(hostname) {
    if (!hostname) return true;
    const lower = hostname.toLowerCase();

    // Block loopback, link-local, private IP patterns and internal metadata endpoints
    if (
      lower === 'localhost' ||
      lower === '127.0.0.1' ||
      lower === '::1' ||
      lower === '0.0.0.0' ||
      lower === '169.254.169.254' ||
      lower === 'metadata.google.internal' ||
      lower === 'redis' ||
      lower.startsWith('127.') ||
      lower.startsWith('10.') ||
      lower.startsWith('192.168.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lower)
    ) {
      return true;
    }
    return false;
  }

  static async execute(payload = {}, timeoutSeconds = 60, logCallback = () => {}) {
    const rawUrl = payload.url || 'https://httpbin.org/get';

    // SSRF Validation
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch (e) {
      throw new Error(`Invalid URL format: "${rawUrl}"`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Forbidden URL protocol "${parsedUrl.protocol}". Only HTTP and HTTPS are allowed.`);
    }

    if (this.isBlockedHost(parsedUrl.hostname)) {
      throw new Error(`Access to internal/private host "${parsedUrl.hostname}" is blocked for security.`);
    }

    const method = (payload.method || 'GET').toUpperCase();
    const headers = payload.headers || {};
    const data = payload.body || payload.data || null;

    logCallback('info', `Initiating HTTP ${method} request to ${parsedUrl.origin}${parsedUrl.pathname}`);

    const startTime = Date.now();
    try {
      const response = await axios({
        url: rawUrl,
        method,
        headers: {
          'User-Agent': 'DistributedJobScheduler/2.0 Worker',
          ...headers
        },
        data,
        timeout: Math.min(timeoutSeconds * 1000, 30000),
        validateStatus: () => true // capture all status codes
      });

      const durationMs = Date.now() - startTime;
      logCallback('info', `HTTP ${method} responded with status ${response.status} in ${durationMs}ms`);

      if (response.status >= 400) {
        throw new Error(`HTTP Request Failed with Status Code ${response.status}: ${JSON.stringify(response.data || {}).slice(0, 200)}`);
      }

      return {
        status: response.status,
        statusText: response.statusText,
        durationMs,
        headers: response.headers,
        data: response.data
      };
    } catch (err) {
      logCallback('error', `HTTP Execution Error: ${err.message}`);
      throw err;
    }
  }
}
