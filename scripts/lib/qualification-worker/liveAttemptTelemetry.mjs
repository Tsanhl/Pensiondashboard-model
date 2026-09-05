export function combineGenerationTelemetry(records = []) {
  const events = [];
  let nextAttempt = 0;
  let lastFailureReason = null;
  let recoveredFromTruncation = false;
  for (const record of records) {
    recoveredFromTruncation ||= Boolean(record.telemetry?.recovered_from_truncation);
    const localMap = new Map();
    for (const raw of record.telemetry?.generation_attempt_ledger || []) {
      if (raw.event === "ATTEMPT_STARTED") {
        nextAttempt += 1;
        localMap.set(Number(raw.attempt),nextAttempt);
      }
      const attempt = localMap.get(Number(raw.attempt));
      if (!attempt) throw new Error("Qualification generation ledger contains an event before ATTEMPT_STARTED.");
      const event = { ...raw,attempt };
      if (event.event === "ATTEMPT_STARTED" && attempt > 1) event.retry_reason = event.retry_reason || record.request_retry_reason || lastFailureReason;
      events.push(event);
      if (event.event === "ATTEMPT_FAILED") lastFailureReason = event.reason || null;
    }
  }
  const secondStart = events.find((event) => event.event === "ATTEMPT_STARTED" && event.attempt === 2);
  return { attempts:nextAttempt,events,retryUsed:nextAttempt === 2,retryReason:secondStart?.retry_reason || null,recoveredFromTruncation };
}
