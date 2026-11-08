# Pocket-Dairy: User Experience and Operating Workflows

## 1. UX direction
Pocket-Dairy should feel as immediate and low-friction as Google Keep while retaining its own brand and self-hosted capabilities. Notes and capture are primary; administration and metadata are secondary. Web and mobile should share concepts but use platform-appropriate interaction patterns.

## 2. Web application shell
**Top bar**
- Brand/home.
- Global search and shortcut hint.
- Workspace switcher/context.
- Notifications.
- Theme toggle.
- Account menu.

**Primary navigation**
- Notes.
- Reminders.
- Labels.
- Archive.
- Trash.
- Settings/account.

Keep navigation compact; avoid putting every filter in the sidebar.

## 3. Notes home
- Quick-capture composer at top.
- Pinned section when non-empty.
- Notes grid or compact list.
- Filter/sort controls.
- Load-more pagination.
- Clear loading, empty, error, and offline states.
- Workspace context always visible.

## 4. Quick capture
- Start with lightweight text composer.
- Expand title/body when focused.
- Toggle checklist mode.
- Fast actions for reminder, labels, color, image, archive, and voice typing where supported.
- Save without opening full editor.
- Closing must not discard committed content.
- Do not show success until local or server persistence actually occurred.

## 5. Note cards
Possible content:
- Title and body preview.
- Checklist progress and first few items.
- Image thumbnail / attachment indicator.
- Label chips.
- Reminder indicator.
- Pin/favorite marker.
- Color and updated time where useful.

Actions:
- Open/edit, pin, reminder, labels, color, archive, trash, more.
Desktop hover actions need touch-friendly equivalents. Avoid displaying every metadata field on every card.

## 6. Editor
**Header:** back/close, title, save state, pin/favorite, history, share (only if supported), more actions.

**Body:** comfortable writing width, title/content, checklist, Markdown toolbar/preview where supported, attachment strip, image viewer, drawing, metadata.

**Truthful states:**
- Editing.
- Saving.
- Saved to server.
- Saved locally / waiting to sync.
- Offline.
- Conflict needs attention.
- Save failed / retry.

Web must not show server-saved before acknowledgement. Mobile must distinguish durable local save from successful sync.

## 7. Search and filters
- Reachable throughout notes area.
- Debounced live results.
- Active filter chips and clear-all.
- Workspace scope visible.
- Keyboard focus and Escape behavior.
- Helpful no-results state.
- Sort options separate from filters.
- Preserve query during pagination.

## 8. Labels, folders, categories
- Labels are flexible and many-to-many.
- Inline label creation from note.
- Case-insensitive duplicate prevention.
- Rename/delete shows impact.
- Unlabelled notes remain easy to find.
- Avoid deep nesting by default.
- Keep folders/categories only if their distinct behavior is understandable.

## 9. Reminders and calendar
- Common presets plus custom date/time.
- Display user's local timezone.
- Easy edit/remove.
- Dedicated upcoming and overdue view.
- Calendar is an optional navigation aid.
- Explain notification permission and best-effort mobile behavior.

## 10. Archive and Trash
- Archive removes from main Notes but preserves data.
- Trash is reversible.
- Restore returns note to sensible active state.
- Permanent deletion requires confirmation.
- Empty Trash clearly states irreversibility.
- Counts and search semantics must agree.

## 11. Mobile UX
- Prioritize Notes, Search, Reminders, Settings/More.
- Floating create action within easy reach.
- Native keyboard and safe-area behavior.
- Touch targets around 44 pt or larger.
- Pull-to-refresh without breaking offline mode.
- Visible server and sync state.
- Offline create/edit and attachment retry.
- Native share, image, and document pickers.
- No hover-dependent controls.
- Keep editor controls reachable with keyboard open.

## 12. First-run and server setup
- Explain that the app connects to a user's own server.
- Validate URL and server identity before login.
- Explain incompatible API versions.
- Retry when server unavailable.
- Do not forward credentials to another host after redirect.
- Keep server-scoped credentials secure.
- Make active server/account unmistakable.

## 13. Offline and sync UX
Display online/offline, last successful sync, pending count, failed count, conflicts, retry, and safe full-resync action.
- Local edits appear immediately.
- Pending state survives app restart.
- Transient errors retry with backoff.
- Terminal errors show reason and recovery.
- Conflicts require explicit Keep Mine / Use Server.
- Session expiry must not erase pending edits.
- Do not claim guaranteed background sync.

## 14. Accessibility and localization
- Semantic controls and headings.
- Keyboard navigation and visible focus.
- Screen-reader labels for icon-only actions.
- Light/dark contrast.
- Reduced motion.
- Mobile text scaling.
- Localized date/time/number formatting.
- IANA timezone support.
- Prepare English and Japanese strings; avoid hardcoded text scattered in logic.

## 15. Visual system
- Retain Pocket-Dairy brand assets and existing tokens.
- Define spacing, radii, typography, surfaces, borders, semantic colors.
- Support light/dark themes.
- Note colors are accents, not sole status indicators.
- Standardize cards, buttons, chips, popovers, dialogs, banners, and empty states.
- Respect reduced motion.
- Avoid visual clutter and excessive metadata.

## 16. Error handling
Every async action needs loading, actionable error, retry where safe, duplicate-submit prevention, and no silent dismissal.
Examples: oversized attachment, expired session, conflict, partial import, unavailable server.

## 17. UX acceptance checklist
- [ ] Quick plain note and checklist capture.
- [ ] Clear grid/list cards and actions.
- [ ] Distinct pin/archive/trash/restore behavior.
- [ ] Inline label management.
- [ ] Search works by keyboard and touch.
- [ ] Truthful autosave and sync states.
- [ ] Recoverable conflict UI.
- [ ] Attachment progress and retry.
- [ ] Mobile editor works with keyboard open.
- [ ] Offline edits survive restart.
- [ ] Icon actions have accessible names.
- [ ] Both themes remain readable.
