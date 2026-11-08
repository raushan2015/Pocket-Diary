# Pocket Diary Keyboard Shortcuts Reference

> **Platform:** Web (Desktop) | Mobile (External Keyboard)
> **Convention:** `Mod` = `Ctrl` (Windows/Linux) or `Cmd` (macOS)

---

## Global Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `N` | Create new note | Notes list, any view |
| `/` | Focus global search | Anywhere (except inputs) |
| `Esc` | Close modal / Clear search / Dismiss toast | Modal open, search focused, toast visible |
| `G` then `N` | Go to Notes | Anywhere |
| `G` then `R` | Go to Reminders | Anywhere |
| `G` then `L` | Go to Labels | Anywhere |
| `G` then `A` | Go to Archive | Anywhere |
| `G` then `T` | Go to Trash | Anywhere |
| `G` then `S` | Go to Settings | Anywhere |
| `?` | Show keyboard shortcuts help | Anywhere |

---

## Navigation

| Shortcut | Action |
|----------|--------|
| `Tab` | Next focusable element |
| `Shift + Tab` | Previous focusable element |
| `Enter` | Activate focused button/link |
| `Space` | Toggle checkbox / Activate button |
| `Arrow Up/Down` | Navigate lists, dropdowns, menus |
| `Arrow Left/Right` | Navigate tabs, horizontal menus |
| `Home` | First item in list |
| `End` | Last item in list |
| `Page Up/Down` | Scroll list by page |

---

## Notes List / Grid

| Shortcut | Action |
|----------|--------|
| `J` / `↓` | Next note |
| `K` / `↑` | Previous note |
| `Enter` | Open focused note |
| `O` | Open focused note (alternative) |
| `P` | Toggle pin on focused note |
| `F` | Toggle favorite on focused note |
| `L` | Open label menu for focused note |
| `C` | Open color menu for focused note |
| `H` | Archive focused note |
| `Delete` / `Backspace` | Move focused note to trash |
| `Shift + Delete` | Permanently delete (with confirmation) |
| `R` | Set reminder on focused note |
| `D` | Duplicate focused note |
| `Ctrl/Cmd + Click` | Multi-select notes |
| `Shift + Click` | Range select |

---

## Note Editor

### Editing
| Shortcut | Action |
|----------|--------|
| `Mod + S` | Save explicitly (auto-save also runs) |
| `Mod + Z` | Undo |
| `Mod + Shift + Z` / `Mod + Y` | Redo |
| `Mod + A` | Select all |
| `Mod + C` | Copy |
| `Mod + V` | Paste |
| `Mod + X` | Cut |
| `Mod + F` | Find in note |
| `Mod + G` | Find next |
| `Mod + Shift + G` | Find previous |

### Formatting (Markdown)
| Shortcut | Action | Markdown |
|----------|--------|----------|
| `Mod + B` | Bold | `**text**` |
| `Mod + I` | Italic | `*text*` |
| `Mod + U` | Underline | `<u>text</u>` (HTML) |
| `Mod + Shift + S` | Strikethrough | `~~text~~` |
| `Mod + Shift + 7` | Toggle checklist | `- [ ] item` |
| `Mod + Shift + .` | Inline code | `` `code` `` |
| `Mod + Shift + C` | Code block | ```code``` |
| `Mod + K` | Insert link | `[text](url)` |
| `Mod + Shift + K` | Insert image | `![alt](url)` |
| `Mod + ]` | Increase heading | `#` → `##` |
| `Mod + [` | Decrease heading | `##` → `#` |
| `Mod + Shift + L` | Bullet list | `- item` |
| `Mod + Shift + N` | Numbered list | `1. item` |
| `Mod + Shift + Q` | Blockquote | `> quote` |
| `Mod + Shift + H` | Horizontal rule | `---` |

### Editor Navigation
| Shortcut | Action |
|----------|--------|
| `Mod + ←/→` | Word jump |
| `Mod + ↑/↓` | Paragraph jump |
| `Home` / `End` | Line start/end |
| `Mod + Home` / `Mod + End` | Document start/end |
| `Alt + ↑/↓` | Move line up/down |
| `Mod + D` | Duplicate line |
| `Mod + Shift + K` | Delete line |

### Editor UI
| Shortcut | Action |
|----------|--------|
| `Mod + Shift + P` | Toggle preview (split view) |
| `Mod + Shift + M` | Toggle fullscreen |
| `Mod + ,` | Open settings |
| `Esc` | Exit editor (prompts if unsaved) |

---

## Search

| Shortcut | Action |
|----------|--------|
| `/` | Focus search input |
| `Esc` | Clear search / Close results |
| `Enter` | Execute search / Open selected result |
| `↑/↓` | Navigate results |
| `Mod + Enter` | Open result in new tab |
| `Mod + K` | Clear search (alternative) |

### Search Query Syntax (Type in search box)
```
meeting notes          # Full-text search
label:design           # Label filter
folder:projects        # Folder filter
category:work          # Category filter
status:pending         # Status filter
priority:high          # Priority filter
pinned:true            # Pinned only
favorite:true          # Favorites only
reminder:true          # Has reminder
archived:true          # Archived notes
deleted:true           # Trashed notes
created:>2024-01-01    # Date range (not yet implemented)
```

---

## Reminders

| Shortcut | Action |
|----------|--------|
| `R` | Set reminder on selected note |
| `Mod + Shift + R` | Open reminders view |
| `D` | Dismiss reminder notification |
| `S` | Snooze (not yet implemented) |

---

## Modals & Dialogs

| Shortcut | Action |
|----------|--------|
| `Esc` | Close (Cancel) |
| `Enter` | Confirm (primary action) |
| `Tab` / `Shift+Tab` | Navigate focus within modal |
| `Mod + Enter` | Submit form (if focused in input) |

---

## Mobile (External Keyboard)

All desktop shortcuts work with external keyboard on iPad/Android.

**Additional Mobile:**
| Shortcut | Action |
|----------|--------|
| `Cmd + N` | New note (iPad) |
| `Cmd + /` | Focus search (iPad) |
| `Cmd + ,` | Settings (iPad) |
| `Cmd + W` | Close note / Go back |
| `Cmd + [ / ]` | Navigate back/forward |

---

## Accessibility Notes

- **Focus visible:** All interactive elements show focus ring (`--shadow-focus`)
- **Skip links:** Press `Tab` at page top → "Skip to main content"
- **ARIA labels:** All icon-only buttons have `aria-label`
- **Reduced motion:** `prefers-reduced-motion` disables animations
- **High contrast:** `prefers-contrast: high` increases borders
- **Screen readers:** Tested with NVDA, VoiceOver, TalkBack

---

## Customization

> Not yet implemented. Planned: Settings → Keyboard Shortcuts → Remap keys

---

## Cheat Sheet (Printable)

```
┌─────────────────────────────────────────────────────────────┐
│ POCKET DIARY - KEYBOARD SHORTCUTS                          │
├─────────────────────────────────────────────────────────────┤
│ GLOBAL                                                       │
│   N          New note                    /       Search     │
│   Esc        Close/Clear                 ?       Help       │
├─────────────────────────────────────────────────────────────┤
│ NOTES LIST                                                   │
│   J/K        Next/Prev note            Enter   Open note    │
│   P          Toggle pin                F       Toggle fav   │
│   H          Archive                   Del      Trash       │
│   R          Reminder                  L       Labels       │
│   C          Color                     D       Duplicate   │
├─────────────────────────────────────────────────────────────┤
│ EDITOR                                                       │
│   Mod+S      Save                    Mod+Z     Undo        │
│   Mod+B      Bold                    Mod+I     Italic      │
│   Mod+Shift+7  Checklist             Mod+K     Link        │
│   Mod+Shift+.  Inline code           Mod+Shift+C Code block │
│   Mod+Shift+P  Toggle preview        Mod+,     Settings    │
├─────────────────────────────────────────────────────────────┤
│ SEARCH                                                       │
│   /          Focus                   Enter   Open result    │
│   label:x    Filter by label         folder:x  Filter      │
└─────────────────────────────────────────────────────────────┘
```