# Pocket Diary Brand Guidelines

> **Status:** Draft — for internal alignment
> **Version:** 1.0

---

## Brand Identity

### Name
**Pocket Diary** — Two words, capitalized. Not "Pocket-Diary", "pocketdiary", or "PocketDiary".

### Tagline
> *Capture first, organize later.*

### Mission
A self-hosted, fast, low-friction place to capture thoughts, lists, images, links, reminders, and everyday information — with full data ownership.

### Personality
| Trait | Expression |
|-------|------------|
| **Simple** | No clutter, progressive disclosure |
| **Reliable** | Auto-save, offline-first, no silent data loss |
| **Respectful** | Your data, your server, your rules |
| **Calm** | Soft colors, generous whitespace, reduced motion |
| **Capable** | Power features when needed (search, labels, reminders, sync) |

---

## Visual Identity

### Logo
| Variant | Use Case | File |
|---------|----------|------|
| **Primary** | App icon, favicon, login screen | `logo.svg` (vector) |
| **Wordmark** | Header, marketing, docs | `logo-wordmark.svg` |
| **Monochrome** | Single-color printing, watermarks | `logo-mono.svg` |

**Logo Construction:**
- Icon: Stylized "P" + diary page fold
- Colors: Primary blue gradient → teal accent
- Clear space: 1× icon height on all sides
- Minimum size: 24px (digital), 10mm (print)

**Don'ts:**
- ❌ Stretch, rotate, recolor
- ❌ Add drop shadows, outlines
- ❌ Place on busy backgrounds
- ❌ Use icon without wordmark at small sizes

### Color Palette

#### Primary
| Name | Hex | RGB | Use |
|------|-----|-----|-----|
| **Primary Blue** | `#2563EB` | 37, 99, 235 | Primary actions, links, focus rings |
| **Primary Blue Dark** | `#1D4ED8` | 29, 78, 216 | Hover states |
| **Primary Blue Light** | `#DBEAFE` | 219, 234, 254 | Backgrounds, badges |

#### Secondary (Note Colors — 12)
| Name | Hex | Use |
|------|-----|-----|
| Default | `#FFFFFF` | Neutral |
| Red | `#FEF2F2` | Urgent, personal |
| Orange | `#FFF7ED` | Creative |
| Yellow | `#FEFCE8` | Ideas |
| Green | `#F0FDF4` | Tasks, done |
| Teal | `#F0FDFA` | Projects |
| Blue | `#EFF6FF` | Work |
| Dark Blue | `#EEF2FF` | Deep focus |
| Purple | `#FAF5FF` | Learning |
| Pink | `#FDF2F8` | Personal |
| Brown | `#FDF8F3` | Journal |
| Gray | `#F3F4F6` | Minimal |

#### Semantic
| Name | Light | Dark | Use |
|------|-------|------|-----|
| Success | `#16A34A` | `#22C55E` | Saved, synced, confirmed |
| Warning | `#D97706` | `#F59E0B` | Pending, sync in progress |
| Error | `#DC2626` | `#EF4444` | Failed, conflict, destructive |
| Info | `#2563EB` | `#3B82F6` | Neutral actions, links |

#### Neutrals
| Name | Light | Dark |
|------|-------|------|
| Background | `#F9FAFB` | `#111827` |
| Surface | `#FFFFFF` | `#1F2937` |
| Border | `#E5E7EB` | `#374151` |
| Text Primary | `#111827` | `#F9FAFB` |
| Text Secondary | `#6B7280` | `#9CA3AF` |

---

## Typography

### Font Stack
```css
font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
```

### Scale
| Token | Size | Weight | Line Height | Use |
|-------|------|--------|-------------|-----|
| Display | 2.25rem (36px) | 700 | 1.25 | Marketing hero |
| H1 | 1.875rem (30px) | 700 | 1.25 | Page titles |
| H2 | 1.5rem (24px) | 600 | 1.3 | Section headers |
| H3 | 1.25rem (20px) | 600 | 1.4 | Card titles |
| Body LG | 1.125rem (18px) | 400 | 1.6 | Lead paragraphs |
| Body | 1rem (16px) | 400 | 1.5 | Default text |
| Body SM | 0.875rem (14px) | 400 | 1.5 | Metadata, captions |
| Caption | 0.75rem (12px) | 500 | 1.4 | Labels, badges |
| Mono | 0.875rem (14px) | 400 | 1.6 | Code, timestamps |

---

## Iconography

### Style
- **Outline** (default) — 2px stroke, 24×24px viewBox
- **Filled** — for active states (pin, favorite)
- **Rounded corners** (2px), consistent stroke width

### Source
- **Primary:** Custom SVG set (`frontend/icons/`)
- **Fallback:** Heroicons Outline / Material Symbols (licensed)

### Key Icons
| Concept | Icon | Variants |
|---------|------|----------|
| Note | Document | Outline/Filled |
| Checklist | Check squares | |
| Pin | Pushpin | Outline/Filled (pinned) |
| Favorite | Star | Outline/Filled (favorited) |
| Reminder | Bell | Outline/Filled (active) |
| Label | Tag | |
| Folder | Folder | |
| Category | Palette | |
| Archive | Box | |
| Trash | Trash can | |
| Settings | Gear | |
| Search | Magnifying glass | |
| Menu | Hamburger | |
| Close | X | |
| More | 3 dots horizontal | |
| Chevron | Down/Up/Left/Right | |

---

## UI Components

### Buttons
| Variant | Background | Text | Border | Use |
|---------|------------|------|--------|-----|
| Primary | Primary Blue | White | None | Main actions |
| Secondary | Gray 100 | Gray 900 | Gray 200 | Supporting actions |
| Ghost | Transparent | Gray 700 | None | Subtle actions |
| Destructive | Red 600 | White | None | Delete, remove |

**States:** Hover (darker), Active (darker), Focus (ring), Disabled (40% opacity)

### Cards (Notes)
- **Radius:** 12px (`--radius-xl`)
- **Shadow:** `sm` (default), `md` (hover), `lg` (dragging)
- **Border:** 1px Gray 200 (light) / Gray 600 (dark)
- **Color accent:** Top border 3px in note color (pinned/favorite)

### Form Controls
- **Input/Select:** 40px height, 8px radius, Gray 200 border
- **Focus:** Blue 500 border + 3px focus ring
- **Error:** Red 500 border + Red 500 text
- **Label:** 14px, Medium, Gray 700

### Badges/Chips
- **Radius:** Full (9999px)
- **Padding:** 4px 8px (sm), 6px 10px (md)
- **Label:** Gray 100 bg, Gray 700 text
- **Reminder:** Blue 50 bg, Blue 700 text
- **Dot status:** 8px dot + label

---

## Motion & Animation

### Principles
- **Purposeful:** Guide attention, not decorate
- **Fast:** 150-300ms max
- **Respectful:** Honor `prefers-reduced-motion`

### Standard Durations
| Motion | Duration | Easing |
|--------|----------|--------|
| Micro (hover, focus) | 150ms | ease-out |
| Standard (modal, popover) | 200ms | ease-out |
| Complex (page transition) | 300ms | ease-in-out |

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
```

---

## Voice & Tone

### Writing Principles
| Principle | Do | Don't |
|-----------|-----|-------|
| **Clear** | "Note saved" | "Your note has been successfully persisted" |
| **Concise** | "Sync failed" | "There was an issue synchronizing your data" |
| **Human** | "Welcome back!" | "Authentication successful" |
| **Actionable** | "Check your connection and try again" | "Error 500" |
| **Respectful** | "We couldn't save that. Want to retry?" | "Failed. Retry?" |

### Terminology
| Concept | Term | Avoid |
|---------|------|-------|
| Note | **Note** (not "memo", "card", "entry") | Memo, card |
| Checklist item | **Task** / **Item** | Todo, checkbox |
| Workspace | **Workspace** | Team, project, org |
| Label | **Label** | Tag, category (technical) |
| Pin | **Pin** | Stick, fix |
| Archive | **Archive** | Hide, remove |
| Trash | **Trash** | Delete, bin |
| Sync | **Sync** | Synchronize, backup |

### Error Messages
| Situation | Message |
|-----------|---------|
| Save failed | "Couldn't save. Check connection and try again." |
| Conflict | "This note was edited elsewhere. Choose which version to keep." |
| Offline | "You're offline. Changes saved locally — will sync when online." |
| Upload failed | "File too large (max 5MB) or unsupported type." |
| Permission denied | "You don't have permission for that action." |
| Not found | "Note not found. It may have been moved or deleted." |

---

## Applications

### Web App
- **Favicon:** 32×32, 16×16, SVG
- **PWA Manifest:** `manifest.json` (name, icons, theme_color)
- **Theme Color:** Primary Blue (`#2563EB`)

### Mobile App
- **App Icon:** 1024×1024 (App Store), adaptive icon (Android)
- **Splash Screen:** Logo centered, Primary Blue background
- **Platform:** iOS (SF Symbols compatible), Android (Material You)

### Documentation
- **Headers:** H1 = Page title, H2 = Sections
- **Code Blocks:** Monospace, syntax highlighted
- **Screenshots:** 2x resolution, subtle shadow, rounded corners

### Marketing
- **Hero:** "Capture first, organize later." + screenshot
- **Screenshots:** Real app, anonymized data
- **Colors:** Primary Blue + Note color accents

---

## Co-Branding & Partnerships

### Allowed
- "Powered by Pocket Diary" (link to repo)
- "Self-hosted with Pocket Diary"

### Not Allowed
- ❌ Modified logo
- ❌ "Official" without permission
- ❌ Implying endorsement

---

## Assets

### Repository
```
docs/
├── architecture/
│   ├── design-system/
│   │   ├── tokens.json
│   │   ├── tokens.css
│   │   ├── component-library.md
│   │   └── brand-guidelines.md
│   └── ...
├── screenshots/
│   ├── desktop-dashboard.png
│   ├── desktop-editor.png
│   ├── desktop-landing.png
│   ├── mobile-landing.png
│   ├── mobile-dashboard.png
│   └── mobile-editor.png
└── product-blueprint/
    └── ...
```

### Figma (Future)
> Design system to be published as Figma Community file

---

## Legal

### Trademarks
- **Pocket Diary** — Trademark of TECHSHAN AI Office
- **Logo** — Copyright TECHSHAN AI Office

### License
- **Code:** MIT
- **Documentation:** CC BY 4.0
- **Brand Assets:** All rights reserved (contact for usage)

### Attribution
> Pocket Diary — Self-hosted notes. https://github.com/raushan2015/Pocket-Diary