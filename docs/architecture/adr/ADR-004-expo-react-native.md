# ADR 004: Expo + React Native for Mobile (Offline-First)

**Status:** Accepted
**Date:** 2024-01-20
**Deciders:** Mobile Team
**Technical Story:** Mobile client technology selection

## Context

Mobile client requirements:
- **Offline-first**: Full read/write offline, sync when online
- **Cross-platform**: iOS and Android from single codebase
- **Native feel**: Platform-appropriate UI, keyboard handling, safe areas
- **Secure storage**: Credentials in Keychain/Keystore, not plaintext
- **Background sync**: Best-effort sync when app backgrounded
- **Share extension**: Capture from other apps (iOS Share Sheet, Android Share)

## Decision

**Expo Router + React Native (TypeScript)** with:
- `expo-sqlite` for local database (mirrors server schema subset)
- `expo-secure-store` for credentials (Keychain/Keystore)
- `@tanstack/react-query` for server state + optimistic updates
- Durable SQLite outbox for mutation queue (FIFO, idempotent)
- Custom sync engine: push local → pull remote → reconcile conflicts
- Expo Router for file-based navigation + deep linking

## Consequences

### Positive
- **Single codebase**: ~85% shared between iOS/Android/Web
- **Expo managed workflow**: No Xcode/Android Studio for development; OTA updates via Expo Updates
- **Native modules accessible**: SecureStore, SQLite, Notifications, DocumentPicker, Camera
- **TypeScript end-to-end**: Shared Zod schemas with backend (via `services/api/contracts`)
- **Offline-first architecture**: Local SQLite = source of truth for reads; outbox = write queue
- **Expo Go for testing**: Instant preview on physical devices

### Negative
- **Expo limitations**: Some native modules require config plugins or prebuild (`npx expo prebuild`)
- **Bundle size**: ~25MB base + assets (larger than pure native)
- **Background execution limits**: iOS severely restricts background tasks; Android Doze mode
- **No guaranteed background sync**: Must communicate this limitation to users
- **Expo SDK upgrades**: Annual major versions with breaking changes

### Neutral
- **EAS Build for production**: Cloud builds for App Store / Play Store submission
- **Web support**: `expo start --web` runs mobile code in browser (useful for debugging)
- **Sync contract versioned**: Mobile/backend negotiate capabilities via `/system/info`

## Alternatives Considered

| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| React Native CLI (bare) | Full native control, smaller bundle | Xcode/Android Studio required, slower iteration, no Expo SDK | Higher dev friction |
| Flutter | Single codebase, native performance, great tooling | Dart language, different ecosystem, no Expo-like managed workflow | Team expertise in React/TS |
| Capacitor/Ionic | Web-based, single codebase | WebView performance, limited native access, not truly offline-first | Offline SQLite + sync needs native |
| PWA only | Zero install, single codebase | No secure credential storage, no background sync, no share extension, iOS PWA limitations | Doesn't meet offline/security requirements |
| Separate native (Swift/Kotlin) | Best platform integration | 2x development effort, skill divergence | Resource constraints |

## Implementation Notes

- Local schema in `mobile-apps/services/db/schema.ts` (subset of server schema)
- Outbox table: `id, entityType, entityId, operation, payload, serverVersion, status, createdAt, retryCount`
- Sync flow: `local transaction + outbox insert` → `push outbox (FIFO)` → `pull workspace (paginated)` → `reconcile`
- Conflict policy: Server version check → 409 → park conflict → user resolves (Keep Mine / Use Server)
- Credentials: `expo-secure-store` (iOS Keychain, Android Keystore) — never AsyncStorage or SQLite
- Notifications: `expo-notifications` (local + push via FCM/APNs); reminder reconciliation after sync
- Deep links: `pocketdiary://` scheme + Universal Links / App Links for server URL

## References

- [Mobile Architecture Doc](../mobile-architecture.md)
- [Sync Contract Specification](../sync-contract.md)
- [Expo Documentation](https://docs.expo.dev/)