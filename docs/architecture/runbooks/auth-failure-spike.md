# Alert: AuthFailureSpike

**Severity:** Warning
**Source:** Prometheus `rate(auth_failures_total[5m]) > 10` / Logs show repeated 401/403 / Account lockout events
**Runbook:** This file

## Symptoms
- Elevated failed login / register attempts
- Users report "Too many attempts" lockout
- Brute force / credential stuffing patterns in logs
- Rate limiter hitting on `/auth/login`, `/auth/register`

## Diagnosis Steps

1. **Check auth logs**
   ```bash
   docker compose logs memo-manager --since=30m | grep -E '(login|register).*40[13]'
   # Count by IP, email
   ```

2. **Check rate limiter state**
   ```bash
   # Rate limit keyed by IP (default) + per-account
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
     "SELECT * FROM rate_limit_counters ORDER BY count DESC LIMIT 20;"
   ```

3. **Identify attack vs. legit**
   - Many IPs, same emails → credential stuffing
   - Single IP, many emails → brute force
   - Legit user forgot password → help them reset

4. **Check account lockouts**
   ```bash
   docker compose exec memo-manager sqlite3 /app/data/memo_manager.db \
     "SELECT email, failed_login_attempts, locked_until FROM users WHERE locked_until > 0;"
   ```

## Mitigation

| Scenario | Action |
|----------|--------|
| Brute force (single IP) | Block IP at firewall / proxy; increase `RATE_LIMIT_MAX` temporarily |
| Credential stuffing | Enable CAPTCHA (not yet implemented); monitor |
| Legit user locked | Admin: `UPDATE users SET failed_login_attempts=0, locked_until=0 WHERE email='...';` |
| Distributed attack | Consider fail2ban / Cloudflare / Tailscale ACL |

## Resolution

- Rotate `COOKIE_SECRET` if session compromise suspected
- Add IP allowlist for known admin networks
- Review password policy (min 8 chars, letter + number)
- Monitor for session hijacking (check `sessions` table for anomalies)

## Escalation

- **< 30 min**: On-call reviews logs; blocks obvious attackers
- **< 2 hours**: If sustained, enable additional protections
- **< 24 hours**: Security review; consider WAF

## Post-Incident

- [ ] Review authentication audit log
- [ ] Update rate limit thresholds if needed
- [ ] Consider adding CAPTCHA / honeypot to login form
- [ ] Document attack pattern for future detection