# Alert: ReminderDeliveryFailed

**Severity:** Warning
**Source:** Reminder scan logs / Notification table `emailSentAt`/`pushSentAt` null / User reports missing reminder
**Runbook:** This file

## Symptoms
- Reminders not delivered (email, push, or in-app)
- Scan logs show "Failed to send email" / "Push failed"
- `notifications` table has entries with `emailSentAt` = NULL, `pushSentAt` = NULL
- User timezone issues (reminder fires at wrong time)

## Diagnosis Steps

1. **Check reminder scan logs**
   ```bash
   docker compose logs memo-manager --since=2h | grep -i reminder
   # Look for: "scan completed", "email failed", "push failed", "skipped"
   ```

2. **Check notification delivery status**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
     "SELECT id, type, emailSentAt, pushSentAt, readAt FROM notifications WHERE createdAt > $(date -d '1 hour ago' +%s)000;"
   ```

3. **Verify SMTP (if email expected)**
   ```bash
   # Test SMTP connectivity
   docker compose exec memo-manager nc -zv ${SMTP_HOST} ${SMTP_PORT}
   # Check mailer logs
   docker compose logs memo-manager | grep -i smtp
   ```

4. **Verify VAPID (if push expected)**
   ```bash
   # Check push subscriptions exist
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
     "SELECT COUNT(*) FROM push_subscriptions;"
   # Check VAPID keys configured
   env | grep VAPID
   ```

5. **Check timezone handling**
   - Reminder stored as UTC epoch ms
   - User timezone from `users.timezone` (IANA)
   - Email formatted in user TZ; push uses server TZ (best effort)

## Mitigation

| Issue | Action |
|-------|--------|
| SMTP down | In-app notifications still work; email deferred to next scan |
| VAPID invalid | Regenerate keys; update env; push falls back to in-app |
| Timezone wrong | User updates profile; server uses `users.timezone` |
| Scan not running | Check `REMINDER_SCAN_INTERVAL_MS`; restart if stuck |

## Resolution

| Root Cause | Fix |
|------------|-----|
| SMTP auth failure | Fix `SMTP_USER`/`SMTP_PASS`; test with `swaks` |
| VAPID key rotation | Generate new keys; update env; clients re-subscribe |
| Duplicate reminders | Dedupe key: `(userId, memoId, reminderTime)` unique index |
| Scan overlap | `pg_advisory_lock` equivalent: single-instance scan (already) |

## Escalation

- **< 1 hour**: On-call checks scan logs; verifies delivery channels
- **< 4 hours**: If critical reminders missed, manual notification
- **< 24 hours**: Root cause; improve monitoring

## Post-Incident

- [ ] Add alert on `notifications` with null `emailSentAt` + `pushSentAt` > 1h old
- [ ] Test reminder delivery in staging with real SMTP/VAPID
- [ ] Document timezone behavior for users
- [ ] Add "Test Reminder" button in settings