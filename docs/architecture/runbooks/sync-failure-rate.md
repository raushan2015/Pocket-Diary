# Alert: SyncFailureRateHigh

**Severity:** Warning
**Source:** Mobile sync metrics / Backend logs: `/api/v1/memos` 409/5xx from mobile clients / User reports "Sync failed"
**Runbook:** This file

## Symptoms
- Mobile users report "Sync failed" banner
- Elevated 409 (conflict) or 5xx on `/memos` from mobile User-Agent
- Outbox queue growing on devices (not draining)
- Conflict resolution UI showing frequently

## Diagnosis Steps

1. **Check backend sync errors**
   ```bash
   docker compose logs memo-manager --since=1h | grep -E '(mobile|expo).* (409|500)'
   # Group by error type
   ```

2. **Check conflict rate**
   ```bash
   docker compose logs memo-manager --since=1h | grep -c 'MemoConflictError'
   # Compare to baseline
   ```

3. **Check outbox processing**
   - Mobile: Settings → Sync → "Pending: X, Failed: Y"
   - Backend: No direct visibility; check mobile logs via TestFlight/TestFairy

4. **Common causes**
   - Schema mismatch (mobile/server version skew)
   - Large attachment uploads timing out
   - Clock skew (reminder timestamps)
   - Server version bump without mobile update

## Mitigation

| Issue | Action |
|-------|--------|
| Schema mismatch | Deploy compatible versions; check `/system/info` capability endpoint |
| Attachment timeout | Increase `bodyLimit` (8MB default); chunk uploads |
| Clock skew | Ensure NTP on server; mobile uses server time for reminders |
| Version skew | Coordinate releases; mobile checks `/system/info` on startup |

## Resolution

| Root Cause | Fix |
|------------|-----|
| Mobile bug | Hotfix via Expo Updates (OTA) or App Store |
| Server bug | Patch + deploy; maintain backward compatibility |
| Network | Advise user: retry on WiFi; check firewall |
| Data corruption | See [DatabaseCorruption](./database-corruption.md) |

## Escalation

- **< 1 hour**: On-call checks logs; identifies pattern
- **< 4 hours**: If widespread, coordinate mobile + backend hotfix
- **< 24 hours**: Post-mortem; improve sync resilience

## Post-Incident

- [ ] Add sync success/failure metrics to backend
- [ ] Improve conflict UX (auto-merge for non-overlapping edits)
- [ ] Test upgrade/downgrade matrix in CI
- [ ] Document sync contract versioning