export class NotificationExecutionService {
  static async execute(payload = {}, timeoutSeconds = 60, logCallback = () => {}) {
    const to = payload.to || 'user@example.com';
    const channel = payload.channel || 'email';
    const subject = payload.subject || 'Notification from Distributed Job Scheduler';
    const template = payload.template || 'default_template';

    logCallback('info', `Dispatching ${channel} notification to ${to} (Subject: "${subject}")`);

    const startTime = Date.now();
    // Simulate real network / SMTP delivery latency
    const delay = Math.floor(Math.random() * 150) + 50;
    await new Promise((r) => setTimeout(r, delay));

    // Simulated conditional error if specified
    if (payload.simulateFailure) {
      throw new Error(`SMTP Gateway rejected recipient: ${to} (Error: Relay access denied)`);
    }

    const durationMs = Date.now() - startTime;
    logCallback('info', `Notification delivered via ${channel} gateway in ${durationMs}ms`);

    return {
      delivered: true,
      channel,
      recipient: to,
      subject,
      durationMs,
      messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    };
  }
}
