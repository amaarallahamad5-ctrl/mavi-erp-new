'use strict';
// Private operational summaries only: never record requests, sessions or users.
const {monitorEventLoopDelay} = require('node:perf_hooks');
function startDiagnostics({intervalMs=30000, log=console.log}={}) {
  if (process.env.MAVI_DIAGNOSTICS === '0') return {stop(){}};
  const delay = monitorEventLoopDelay({resolution:20});
  delay.enable();
  const mib = n => Math.round(n / (1024 * 1024) * 10) / 10;
  const nsToMs = n => Math.round(n / 1e6 * 10) / 10;
  const timer = setInterval(() => {
    try {
      const m = process.memoryUsage();
      const sample = {
        timestamp: new Date().toISOString(),
        uptime_s: Math.round(process.uptime()),
        rss_mib: mib(m.rss), heap_used_mib: mib(m.heapUsed),
        heap_total_mib: mib(m.heapTotal), external_mib: mib(m.external),
        event_loop_p99_ms: nsToMs(delay.percentile(99)),
        event_loop_max_ms: nsToMs(delay.max),
      };
      log('[mavi-diagnostics] ' + JSON.stringify(sample));
    } catch (e) {
      // Diagnostics must not take the service down or print request data.
      console.error('[mavi-diagnostics] sampling failed');
    } finally { delay.reset(); }
  }, intervalMs);
  timer.unref();
  return {stop(){clearInterval(timer);delay.disable()}};
}
module.exports={startDiagnostics};
