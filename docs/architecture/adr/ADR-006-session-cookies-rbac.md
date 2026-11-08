# ADR 006: Session Cookies + Workspace RBAC

**Status:** Accepted
**Date:** 2024-01-12
**Deciders:** Security Team, Backend Team
**Technical Story:** Authentication & authorization design

## Context

Authentication requirements:
- Self-hosted: no external identity provider dependency
- Cookie-based sessions for browser (CSRF-resistant with SameSite)
- Mobile: secure credential storage, token-based API calls
- Workspace isolation: strict tenant boundaries
- Role-based access: owner, admin, editor, viewer
- Session revocation: per-device, password change revokes all
- No JWT in localStorage (XSS risk)

## Decision

**HTTP-only Secure Cookies + Server-side Session Store (SQLite)** with:
- Argon2id password hashing (memory-hard, configurable)
- High-entropy session tokens (256-bit), stored as SHA-256 hashes
- `memo_session` cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`
- Mobile: tokens stored in `expo-secure-store` (Keychain/Keystore), sent as `Cookie` header
- Workspace RBAC enforced at service layer (every route → service → membership check)
- Roles: `owner` > `admin` > `editor` > `viewer`
- Invitations: email + token (SHA-256 stored), consent-based acceptance

## Consequences

### Positive
- **XSS-resistant**: Tokens never accessible to JavaScript
- **CSRF-resistant**: SameSite=Lax blocks cross-site POSTs; double-submit not needed
- **Revocable**: Server can invalidate sessions instantly (logout, password change, admin revoke)
- **Audit trail**: `sessions` table tracks device, IP, UA, expiry
- **Workspace isolation**: Membership verified on every operation; cross-tenant returns 404 (not 403)
- **Mobile parity**: Same session model, credentials in platform secure enclave

### Negative
- **Cookie domain issues**: Subdomain deployments need `Domain` attribute config
- **Proxy trust required**: `X-Forwarded-For` for rate limiting behind reverse proxy (TRUST_PROXY env)
- **Mobile cookie handling**: Must manually manage Cookie header (Expo fetch doesn't auto-handle)
- **No stateless scaling**: Sessions in SQLite = single instance (see ADR-002)

### Neutral
- **Session sliding expiry**: Activity extends `expiresAt` (7 days default)
- **Password change revokes all**: Except current session
- **Instance admin**: First registered user gets `isInstanceAdmin` flag (backup status access)

## Alternatives Considered

| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| JWT in localStorage | Stateless, scales horizontally | XSS steals tokens; no revocation without blocklist | Security risk |
| JWT in HTTP-only cookie | Stateless + XSS-safe | Still no revocation; token size in cookie header | Revocation needed |
| OAuth/OIDC (Keycloak, etc.) | Enterprise features, SSO | External dependency, complex self-hosting | Violates zero-config principle |
| API Keys | Simple for automation | No user context, no workspace RBAC, rotation manual | Doesn't fit interactive app |
| Magic Links / Passwordless | No passwords to leak | Email delivery dependency, UX friction | Password + session is simpler |

## Implementation Notes

- `backend/src/plugins/auth.ts`: `authenticate()` hook, `request.user`, session lookup
- `backend/src/services/auth.ts`: `createSession`, `revokeSession`, `verifyPassword`, `hashPassword`
- `workspace.service.ts`: `verifyWorkspaceMembership(db, userId, workspaceId, allowedRoles?)`
- Every mutating route calls `verifyWorkspaceMembership` with required role
- Cross-tenant queries: `workspaceId` from request → verify membership → scope SQL
- Mobile: `services/auth/session-manager.ts` handles cookie persistence + SecureStore

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [SameSite Cookies Explained](https://web.dev/samesite-cookies-explained/)