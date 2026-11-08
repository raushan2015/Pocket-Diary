# Pocket Diary Component Library

> **Status**: Design specification — implementation in `frontend/css/components.css` and `mobile-apps/components/`

---

## Component Inventory

| Component | Web (CSS/JS) | Mobile (React Native) | Status |
|-----------|--------------|----------------------|--------|
| Button | ✅ | ✅ | Stable |
| IconButton | ✅ | ✅ | Stable |
| Input / Textarea | ✅ | ✅ | Stable |
| Select / Combobox | ✅ | ⚠️ (Picker) | Stable |
| Checkbox / Radio | ✅ | ✅ | Stable |
| Switch / Toggle | ✅ | ✅ | Stable |
| Card (Note) | ✅ | ✅ | Stable |
| Modal / Dialog | ✅ | ✅ | Stable |
| Popover / Tooltip | ✅ | ⚠️ (Popover) | Stable |
| Dropdown / Menu | ✅ | ✅ | Stable |
| Tabs | ✅ | ✅ | Stable |
| Toast / Snackbar | ✅ | ✅ | Stable |
| Badge / Chip | ✅ | ✅ | Stable |
| Avatar | ✅ | ✅ | Stable |
| Divider | ✅ | ✅ | Stable |
| Skeleton / Loading | ✅ | ✅ | Stable |
| Empty State | ✅ | ✅ | Stable |
| Progress Bar | ✅ | ✅ | Stable |
| File Upload | ✅ | ✅ | Stable |
| Color Picker | ✅ | ⚠️ | Partial |
| Date/Time Picker | ✅ | ✅ (Native) | Stable |
| Search Input | ✅ | ✅ | Stable |

---

## Component Specifications

### 1. Button

**Variants:** `primary`, `secondary`, `ghost`, `destructive`
**Sizes:** `sm`, `md`, `lg`
**States:** `default`, `hover`, `active`, `focus`, `disabled`, `loading`

```tsx
// Web (HTML + CSS classes)
<button class="pd-btn pd-btn--primary pd-btn--md">Save</button>
<button class="pd-btn pd-btn--secondary pd-btn--sm">Cancel</button>
<button class="pd-btn pd-btn--ghost">Learn more</button>
<button class="pd-btn pd-btn--destructive">Delete</button>

// Mobile (React Native)
<Button variant="primary" size="md" onPress={save}>Save</Button>
<Button variant="ghost" onPress={cancel}>Cancel</Button>
```

**CSS Tokens Used:**
- `--color-action-primary-bg`, `--color-action-primary-bg-hover`, `--color-action-primary-text`
- `--color-action-secondary-bg`, `--color-action-secondary-bg-hover`, `--color-action-secondary-text`
- `--color-action-ghost-bg-hover`, `--color-action-ghost-text`
- `--color-action-destructive-bg`, `--color-action-destructive-bg-hover`, `--color-action-destructive-text`
- `--space-2`, `--space-3`, `--space-4` (padding)
- `--radius-md`, `--font-weight-medium`, `--font-size-sm/base/lg`
- `--shadow-sm`, `--shadow-focus`

**Accessibility:**
- `aria-disabled` when disabled
- `aria-busy` when loading
- Focus visible outline via `--shadow-focus`
- Minimum touch target 44×44px (mobile)

---

### 2. IconButton

**Variants:** `ghost`, `subtle`
**Sizes:** `sm` (32px), `md` (40px), `lg` (48px)
**Use cases:** Toolbar actions, card actions, close buttons

```tsx
// Web
<button class="pd-icon-btn pd-icon-btn--ghost pd-icon-btn--md" aria-label="Pin note">
  <svg class="pd-icon"><use href="#icon-pin"/></svg>
</button>

// Mobile
<IconButton icon="pin" variant="ghost" size="md" onPress={togglePin} accessibilityLabel="Pin note" />
```

**CSS Tokens:** Same as Button + `--radius-full` for circular

---

### 3. Input / Textarea

**Variants:** `default`, `error`, `success`
**Sizes:** `sm`, `md`, `lg`
**Features:** Label, helper text, error message, character count, clear button

```tsx
// Web
<div class="pd-form-field">
  <label class="pd-label" for="title">Title</label>
  <input class="pd-input pd-input--md" id="title" type="text" placeholder="Untitled note" />
  <p class="pd-helper-text">Optional</p>
</div>

<textarea class="pd-textarea pd-textarea--md" rows="6" placeholder="Write something..."></textarea>

// Mobile
<TextField label="Title" placeholder="Untitled note" helperText="Optional" />
<TextArea label="Content" placeholder="Write something..." rows={6} />
```

**CSS Tokens:**
- `--color-surface-primary`, `--color-border-primary`, `--color-border-focus`, `--color-border-error`
- `--color-text-primary`, `--color-text-secondary`, `--color-text-error`
- `--space-2`, `--space-3` (padding), `--radius-md`
- `--shadow-focus` for focus ring

---

### 4. Card (Note Card)

**Variants:** `default`, `pinned`, `favorite`, `compact`, `grid`
**Content:** Title, content preview, checklist progress, image thumbnail, labels, reminder, pin/favorite badges, color accent
**Actions:** Open, pin, reminder, labels, color, archive, trash, more

```tsx
// Web (simplified)
<article class="pd-note-card pd-note-card--default" style="--note-color: var(--color-note-blue)">
  <div class="pd-note-card__header">
    <span class="pd-badge pd-badge--pin">Pinned</span>
    <button class="pd-icon-btn pd-icon-btn--ghost" aria-label="More actions">…</button>
  </div>
  <h3 class="pd-note-card__title">Meeting notes</h3>
  <p class="pd-note-card__preview">Action items: review design, update specs...</p>
  <div class="pd-note-card__meta">
    <span class="pd-chip pd-chip--label">design</span>
    <span class="pd-chip pd-chip--reminder">Tomorrow 9am</span>
  </div>
  <div class="pd-note-card__actions">
    <button class="pd-icon-btn">📌</button>
    <button class="pd-icon-btn">⏰</button>
    <button class="pd-icon-btn">🏷️</button>
    <button class="pd-icon-btn">🎨</button>
    <button class="pd-icon-btn">📦</button>
  </div>
</article>

// Mobile
<NoteCard note={note} variant="default" onPress={openNote} onLongPress={showActions} />
```

**CSS Tokens:**
- `--color-note-*` (background per color)
- `--color-note-border-*` (border accents)
- `--color-surface-primary`, `--color-text-primary/secondary`
- `--space-3`, `--space-4` (padding)
- `--radius-lg`, `--shadow-md`
- `--color-badge-*` for pin/favorite/reminder

---

### 5. Modal / Dialog

**Variants:** `default`, `confirmation`, `form`, `fullscreen` (mobile)
**Sizes:** `sm` (400px), `md` (560px), `lg` (720px), `full`
**Features:** Title, description, close button, action buttons, trap focus, ESC to close

```tsx
// Web
<div class="pd-modal pd-modal--open" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="pd-modal__backdrop"></div>
  <div class="pd-modal__container pd-modal--md">
    <header class="pd-modal__header">
      <h2 id="modal-title" class="pd-modal__title">Delete note?</h2>
      <button class="pd-icon-btn pd-icon-btn--ghost pd-modal__close" aria-label="Close">×</button>
    </header>
    <div class="pd-modal__content">This will move the note to trash.</div>
    <footer class="pd-modal__footer">
      <button class="pd-btn pd-btn--ghost">Cancel</button>
      <button class="pd-btn pd-btn--destructive">Delete</button>
    </footer>
  </div>
</div>

// Mobile (React Native Modal)
<Modal visible={isOpen} animationType="slide" presentationStyle="formSheet">
  <ModalHeader title="Delete note?" onClose={close} />
  <ModalContent>This will move the note to trash.</ModalContent>
  <ModalFooter>
    <Button variant="ghost" onPress={close}>Cancel</Button>
    <Button variant="destructive" onPress={confirmDelete}>Delete</Button>
  </ModalFooter>
</Modal>
```

**CSS Tokens:**
- `--color-surface-primary`, `--color-bg-overlay`
- `--radius-xl`, `--shadow-xl`
- `--space-4`, `--space-6` (padding)
- `--z-modal-backdrop`, `--z-modal`

---

### 6. Popover / Tooltip

**Variants:** `popover` (interactive), `tooltip` (hover-only)
**Positions:** `top`, `bottom`, `left`, `right`, `auto`
**Trigger:** `click` (popover), `hover`/`focus` (tooltip)

```tsx
// Web (Popover)
<div class="pd-popover pd-popover--open" role="menu">
  <div class="pd-popover__arrow"></div>
  <div class="pd-popover__content">
    <button class="pd-popover__item" role="menuitem">Pin</button>
    <button class="pd-popover__item" role="menuitem">Add reminder</button>
    <button class="pd-popover__item" role="menuitem">Change color</button>
    <button class="pd-popover__item pd-popover__item--destructive" role="menuitem">Archive</button>
  </div>
</div>

// Mobile (React Native Popover)
<Popover trigger={<IconButton icon="more" />}>
  <PopoverItem onPress={pin}>Pin</PopoverItem>
  <PopoverItem onPress={addReminder}>Add reminder</PopoverItem>
  <PopoverItem onPress={changeColor}>Change color</PopoverItem>
  <PopoverItem destructive onPress={archive}>Archive</PopoverItem>
</Popover>
```

**CSS Tokens:**
- `--color-surface-primary`, `--color-border-primary`
- `--radius-md`, `--shadow-lg`
- `--space-2` (item padding)
- `--z-popover`

---

### 7. Dropdown / Menu

**Variants:** `default`, `split`, `combobox`
**Features:** Keyboard navigation (Arrow keys, Enter, Escape), groups, dividers, icons, shortcuts

```tsx
// Web
<div class="pd-dropdown pd-dropdown--open">
  <button class="pd-btn pd-btn--secondary pd-dropdown__trigger" aria-haspopup="listbox" aria-expanded="true">
    Sort by <svg class="pd-icon pd-icon--chevron-down"></svg>
  </button>
  <ul class="pd-dropdown__menu" role="listbox">
    <li class="pd-dropdown__item" role="option" aria-selected="true">Updated ↓</li>
    <li class="pd-dropdown__item" role="option">Created ↓</li>
    <li class="pd-dropdown__item" role="option">Title A–Z</li>
    <li class="pd-dropdown__divider"></li>
    <li class="pd-dropdown__item" role="option">Priority</li>
  </ul>
</div>

// Mobile (Picker/Select)
<Select label="Sort by" value={sortBy} onValueChange={setSortBy}>
  <Select.Option value="updated-desc">Updated ↓</Select.Option>
  <Select.Option value="created-desc">Created ↓</Select.Option>
  <Select.Option value="title-asc">Title A–Z</Select.Option>
</Select>
```

---

### 8. Badge / Chip

**Variants:** `default`, `outline`, `dot`
**Colors:** Semantic (info, success, warning, error) + Note colors
**Sizes:** `sm`, `md`
**Use cases:** Labels, status indicators, filters, counts

```tsx
// Web
<span class="pd-chip pd-chip--label pd-chip--md">design</span>
<span class="pd-chip pd-chip--reminder pd-chip--sm">Tomorrow 9am</span>
<span class="pd-chip pd-chip--dot pd-chip--success">Synced</span>
<span class="pd-badge pd-badge--count">3</span>

// Mobile
<Chip label="design" variant="label" size="md" />
<Chip label="Synced" variant="dot" color="success" />
<Badge count={3} />
```

---

### 9. Toast / Snackbar

**Variants:** `info`, `success`, `warning`, `error`
**Positions:** `top-right`, `top-center`, `bottom-center` (mobile)
**Duration:** 4s (default), persistent (error)
**Actions:** Dismiss, Undo, Retry

```tsx
// Web
<div class="pd-toast pd-toast--success pd-toast--open" role="alert" aria-live="polite">
  <svg class="pd-toast__icon"><use href="#icon-check-circle"/></svg>
  <span class="pd-toast__message">Note saved</span>
  <button class="pd-toast__action" aria-label="Dismiss">×</button>
</div>

// Mobile (React Native Snackbar)
<Snackbar
  visible={showToast}
  message="Note saved"
  action={{ label: 'Undo', onPress: undo }}
  duration={4000}
  type="success"
/>
```

---

### 10. Avatar

**Sizes:** `xs` (24px), `sm` (32px), `md` (40px), `lg` (56px), `xl` (80px)
**Variants:** `image`, `initials`, `icon`
**Features:** Fallback chain, status indicator, clickable

```tsx
// Web
<div class="pd-avatar pd-avatar--md pd-avatar--image" style="background-image: url(...)"></div>
<div class="pd-avatar pd-avatar--lg pd-avatar--initials">JD</div>

// Mobile
<Avatar source={{ uri: user.avatarUrl }} size="md" fallback="JD" />
```

---

### 11. Skeleton / Loading

**Variants:** `text`, `circular`, `rectangular`, `card`
**Animation:** Pulse (respects `prefers-reduced-motion`)

```tsx
// Web
<div class="pd-skeleton pd-skeleton--text pd-skeleton--animation"></div>
<div class="pd-skeleton pd-skeleton--card pd-skeleton--animation"></div>

// Mobile
<Skeleton variant="text" width="80%" />
<Skeleton variant="card" />
```

---

### 12. Empty State

**Variants:** `default`, `search`, `offline`, `error`, `permission`
**Content:** Illustration, title, description, primary action, secondary action

```tsx
// Web
<div class="pd-empty-state">
  <svg class="pd-empty-state__illustration"><use href="#illustration-empty-notes"/></svg>
  <h3 class="pd-empty-state__title">No notes yet</h3>
  <p class="pd-empty-state__description">Create your first note to get started.</p>
  <button class="pd-btn pd-btn--primary">New note</button>
</div>

// Mobile
<EmptyState
  illustration="empty-notes"
  title="No notes yet"
  description="Create your first note to get started."
  primaryAction={{ label: 'New note', onPress: createNote }}
/>
```

---

## Theming

### Light Mode (Default)
All tokens defined in `:root` in `tokens.css`

### Dark Mode
Automatic via `@media (prefers-color-scheme: dark)` in `tokens.css`
Manual toggle: Add `.pd-theme-dark` to `<html>` or `<body>`

```css
/* Manual dark mode */
.pd-theme-dark {
  --color-bg-primary: var(--color-gray-900);
  --color-bg-secondary: var(--color-gray-800);
  /* ... all dark overrides from tokens.css @media block ... */
}
```

### High Contrast
```css
@media (prefers-contrast: high) {
  :root {
    --color-border-primary: var(--color-text-primary);
    --shadow-focus: 0 0 0 3px var(--color-text-primary);
  }
}
```

---

## Responsive Behavior

| Component | < 640px (sm) | 640-1024px (md-lg) | > 1024px (xl) |
|-----------|--------------|-------------------|---------------|
| Button | Full width (stacked) | Auto width | Auto width |
| Modal | Fullscreen (mobile) | 560px max | 560px max |
| Card Grid | 1 column | 2-3 columns | 3-4 columns |
| Navigation | Bottom tabs | Sidebar + top bar | Sidebar + top bar |
| Popover | Full width bottom sheet | Anchored | Anchored |

---

## Implementation Notes

### Web (Vanilla JS + CSS)
- Components implemented as CSS classes in `frontend/css/components.css`
- JS behaviors in `frontend/js/components/` (delegated event handlers)
- No framework — use `classList`, `dataset`, `aria-*` attributes

### Mobile (React Native + Expo)
- Components in `mobile-apps/components/`
- Use `react-native-web` compatible primitives where possible
- Platform-specific: `Pressable` (touch), `Modal`, `Picker`
- Theming via `react-native` `StyleSheet` + `useColorScheme`

### Accessibility Checklist (Per Component)
- [ ] Semantic HTML / ARIA roles
- [ ] Keyboard navigation (Tab, Enter, Escape, Arrows)
- [ ] Focus management (trap in modals, return on close)
- [ ] Screen reader labels (`aria-label`, `aria-labelledby`)
- [ ] Color contrast (WCAG AA: 4.5:1 text, 3:1 UI)
- [ ] Reduced motion respected
- [ ] Touch targets ≥ 44×44pt (mobile)
- [ ] Text scaling support (mobile)

---

## Contributing New Components

1. **Design**: Add to Figma/design tokens, get review
2. **Spec**: Document in this file (variants, states, tokens, a11y)
3. **Implement Web**: CSS + minimal JS in `frontend/`
4. **Implement Mobile**: React Native component in `mobile-apps/components/`
5. **Test**: Visual regression (Percy), a11y (axe), cross-browser/device
6. **Document**: Storybook (future) or this file + usage examples