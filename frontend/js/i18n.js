/**
 * Pocket Diary — Internationalization (i18n)
 *
 * Design goals (see docs/product-blueprint 05-UX §14 "Accessibility and localization"):
 *  - English (`en`) is the BASE language: its dictionary is complete and every
 *    other locale may be partial. A missing key falls back to English, then to
 *    the key itself — so a new language can never blank out the UI.
 *  - The chosen language is stored LOCALLY (`localStorage["memo_language"]`),
 *    following the same pattern as the theme (`memo_theme`). No server round-trip.
 *  - Static HTML is translated declaratively with data attributes:
 *      data-i18n="auth.title"                 → textContent
 *      data-i18n-placeholder="auth.emailPh"   → placeholder
 *      data-i18n-title="common.close"         → title
 *      data-i18n-aria-label="common.close"    → aria-label
 *      data-i18n-html="landing.headline"      → innerHTML (trusted strings only)
 *  - Dynamic strings in JS call `t('key', { params })` with `{name}`-style
 *    placeholders, HTML-escaped by default via `tEsc`.
 *  - `document.documentElement.lang` is kept in sync for screen readers.
 *  - Locale-aware date/time helpers use `Intl` so Japanese gets 年月日 ordering
 *    automatically.
 *
 * ADDING A NEW LANGUAGE (e.g. Korean):
 *   1. Copy `LOCALES.en` to a new `LOCALES.ko` object (partial is fine).
 *   2. Translate the strings you want; omit the rest (English fallback).
 *   3. Register it in `LANGUAGES` below: `ko: { name: '한국어', flag: '🇰🇷' }`.
 *   Done — the switcher picks it up automatically.
 */

// ==========================================================================
// Language registry (switcher UI) — add new languages here
// ==========================================================================
export const LANGUAGES = {
  en: { name: 'English', flag: '🇬🇧' },
  ja: { name: '日本語', flag: '🇯🇵' },
};

export const BASE_LANGUAGE = 'en';
const STORAGE_KEY = 'memo_language';

// ==========================================================================
// Base locale: English (complete)
// ==========================================================================
const en = {
  // --- Common / shared ---
  common: {
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    delete: 'Delete',
    edit: 'Edit',
    retry: 'Retry',
    loading: 'Loading…',
    confirm: 'Confirm',
    search: 'Search',
    language: 'Language',
    selectLanguage: 'Select language',
    noResults: 'No results found',
  },

  // --- Top navigation bar ---
  nav: {
    login: 'Login',
    getStarted: 'Get Started',
    searchPlaceholder: 'Search memos, tags, or content...',
    searchAria: 'Search memos',
    filters: 'Filters',
    showFilters: 'Show filters',
    toggleTheme: 'Toggle dark/light theme',
    notifications: 'Notifications',
    ai: 'Pocket Diary AI',
    markAllRead: 'Mark all read',
    notificationsEmpty: 'No notifications yet. Reminders you set on notes will appear here.',
    enablePush: '🔔 Enable push notifications',
    dashboard: 'Dashboard',
    accountSettings: 'Account Settings',
    teamMembers: 'Team & Members',
    toggleDarkMode: 'Toggle Dark Mode',
    dark: 'Dark',
    light: 'Light',
    signOut: 'Sign Out',
    active: 'Active',
    switcherAria: 'Change language',
  },

  navAiButton: 'Pocket Diary AI',

  // --- Pocket Diary AI assistant ---
  ai: {
    title: 'Pocket Diary AI',
    newChat: 'New chat',
    history: 'Chat history',
    settings: 'AI settings',
    close: 'Close AI chat',
    providerSelect: 'AI provider and model',
    send: 'Send message',
    cancel: 'Cancel generation',
    composerPlaceholder: 'Ask, brainstorm, plan… (Enter to send, Shift+Enter for a new line)',
    scopeGeneral: 'General chat — no notes shared',
    scopeNote: 'Current note',
    scopeNoteBlocked: 'Current note: AI sharing blocked',
    scopeSearch: 'AI Search — results stay local until you approve sharing',
    noProvider: 'No provider configured',
    noProviderToast: 'No AI provider is configured. Open AI settings to add an API key.',
    secretWarning: '⚠ This looks like a credential. Chat messages are sent to the selected AI provider — remove it unless you intend to share it.',
    findNote: '🔍 Find a note / AI Search',
    summarizeNote: 'Summarize this note',
    improveNote: 'Improve writing',
    saveTranscript: 'Save conversation as note',
    summarizePrompt: 'Summarize this note.',
    improvePrompt: 'Improve the writing of this note.',
    searchResultsLocal: 'Local search results (visible only to you)',
    searchNoResults: 'No local matches. Try different words.',
    searchPrivacyNote: 'Search results stay private. Only redacted excerpts you preview and approve are shared with your AI provider.',
    reviewSelected: 'Review selected notes',
    selectForAnalysis: 'Select for AI analysis',
    selectMaxTen: 'You can approve up to 10 notes at a time.',
    loadMoreSearch: 'Load more matches',
    previewBeforeSharing: 'Review exactly what will be shared with AI',
    someNotesExcluded: 'Some selected notes were excluded by their privacy settings.',
    approveAiReading: 'Approve and analyze these excerpts',
    searchReadPrompt: 'Summarize and compare only the excerpts I just approved. Cite the relevant note titles.',
    eligibleShort: 'AI-searchable',
    blockedShort: 'Blocked',
    currentOnlyShort: 'Ask-first',
    eligibleHint: 'Can be offered for AI search reading after you preview and approve.',
    blockedHint: 'Never shared with AI — content and identity stay hidden from the model.',
    currentOnlyHint: 'Shared only for explicit tasks on the open note.',
    proposalCreateTitle: '📝 Draft note — review before saving',
    proposalUpdateTitle: '✏️ Proposed note update — review the diff',
    proposalTarget: 'Target note version',
    proposalCreate: 'Create note',
    proposalApply: 'Apply update',
    proposalCancel: 'Cancel',
    proposalRejected: 'Rejected — nothing was written.',
    proposalConflict: 'The note changed since drafting. Reload it and ask again.',
    proposalFailed: 'Could not process the proposal.',
    noteSaved: 'Note saved.',
    noteAutoSaved: 'Note saved automatically (your preference).',
    noteSavedAs: 'Saved as note',
    openNote: 'Open note',
    untitled: 'Untitled',
    tryAgain: 'Send your message again.',
    interruptedNotice: 'Generation was interrupted (server restart or cancellation). Nothing fake is shown — send again to retry.',
    errorSend: 'The message could not be sent.',
    errorSave: 'Saving failed.',
    errorLoad: 'Loading failed.',
    errorLoadHistory: 'Could not load chat history.',
    errorLoadProviders: 'Could not load AI settings.',
    errorCreateConversation: 'Could not start a chat.',
    noteAccessDenied: 'The AI may not read this note.',
    noteBlockedToast: 'This note is set to "Never share with AI". Open its AI privacy settings to change that.',
    historyEmpty: 'No conversations yet.',
    loading: 'Loading…',
    done: 'Done',
    settingsTitle: 'AI Settings',
    settingsIntro: 'Bring your own key. Keys are encrypted with AES-256-GCM on the server and are never displayed again. All provider requests run from the Pocket Diary backend — never from your browser.',
    vaultWarning: 'AI credentials are disabled on this server (missing AI_CREDENTIAL_ENCRYPTION_KEY). Ask the operator to configure it.',
    noProvidersYet: 'No AI providers configured yet. Add one below — brainstorming works as soon as a key is saved.',
    defaultBadge: 'Default',
    model: 'Model',
    modelRequired: 'Enter a model ID.',
    keyMasked: 'API key',
    keyPlaceholder: 'sk-… (typed once, stored encrypted)',
    keyReplaceOptional: 'Leave empty to keep the current key',
    keyRequired: 'Enter an API key (min 8 characters).',
    addProvider: 'Add or update a provider',
    provider: 'Provider',
    label: 'Label',
    labelPlaceholder: 'Work key',
    apiKey: 'API key',
    addConfig: 'Add configuration',
    updateConfig: 'Update configuration',
    fetchModels: 'Fetch model list',
    modelsNeedConfig: 'Save a configuration for this provider first.',
    modelsFetched: 'Model list updated.',
    modelWarning: 'Model IDs are accepted as entered; verify the model supports tool calling for full functionality.',
    testConnection: 'Test connection',
    testing: 'Testing…',
    testFailed: 'Test failed.',
    setDefault: 'Set as default',
    edit: 'Edit',
    delete: 'Delete',
    deleteConfirmTitle: 'Delete provider configuration?',
    deleteConfirmBody: 'The encrypted key will be removed. Chats stay; they will use another configured provider.',
    deleted: 'Configuration deleted.',
    added: 'Configuration saved.',
    configSaved: 'Configuration saved.',
    enterModelManually: 'Enter model manually',
    chooseFromList: 'Choose from list',
    enterKeyFirst: 'Type your API key to load the model list automatically.',
    editingBanner: 'Editing a saved configuration — pressing save updates it (key optional)',
    noModelsFound: 'This provider returned no models for the key. You can enter a model ID manually.',
    modelsLoading: 'Loading available models securely from the provider…',
    modelsWaiting: 'Checking models after you finish entering the key…',
    modelsLoaded: '{count} available models loaded from your provider.',
    modelsAutoFailed: 'Could not load models automatically. You can enter a model ID manually.',
    currentModelNotListed: 'saved model — not in current catalog',
    modelManualActive: 'Manual model entry selected. Verify this model supports chat and tools.',
    modelIdPlaceholder: 'Enter model ID or use the automatically loaded list',
    autoModelsHint: 'Models load automatically using your API key, including saved keys. Manual model entry is available when listing fails.',
    updated: 'Configuration updated.',
    cancelEdit: 'Cancel edit',
    privacyTitle: 'AI Privacy for this note',
    privacyIntro: 'These controls govern third-party AI disclosure only — ordinary authorized search and workspace access are unchanged.',
    privacyBlocked: 'Never share with AI (blocked)',
    privacyBlockedDesc: "The note's content and even its identity are never sent to any external AI, even when the note is open.",
    privacyCurrentOnly: 'Only when I ask (default)',
    privacyCurrentOnlyDesc: 'Content is shared only when you explicitly ask the assistant to work on this open note, for a limited time.',
    privacySearchAllowed: 'May be used in AI Search',
    privacySearchAllowedDesc: 'The note can be offered for AI search analysis — but only after you preview and approve exactly what is shared, every time.',
    protectedHeading: 'Protected passages — never share with AI',
    protectedIntro: 'Paste a passage to protect. It is replaced with [REDACTED] before anything is sent to an AI provider. The passage itself is never stored — only a salted fingerprint.',
    protectedPlaceholder: 'Paste the exact text to protect…',
    protectedAdd: 'Protect passage',
    protectedPassage: 'Protected passage',
    protectedNone: 'No protected passages yet.',
    protectedAdded: 'Passage protected.',
    protectedRemoved: 'Protection removed.',
    protectedTooShort: 'A protected passage needs at least 3 characters.',
    characters: 'chars',
    remove: 'Remove',
    policySaved: 'AI privacy updated.',
    viewerDenied: 'Viewers cannot change AI privacy settings.',
  },

  // --- Authentication screen ---
  auth: {
    welcomeBack: 'Welcome Back',
    signInSubtitle: 'Sign in to your Pocket Diary account',
    createAccount: 'Create Account',
    registerSubtitle: 'Get started with your free Pocket Diary workspace',
    resetTitle: 'Reset Password',
    resetSubtitle: 'Enter your email address to receive password recovery instructions',
    newPasswordTitle: 'Choose a New Password',
    newPasswordSubtitle: 'Enter and confirm your new password to finish the recovery',
    fullName: 'Full Name',
    fullNamePh: 'Alex Morgan',
    fullNameError: 'Please enter your full name',
    email: 'Email Address',
    emailPh: 'alex@example.com',
    emailError: 'Please enter a valid email address',
    password: 'Password',
    passwordError: 'Password must be at least 8 characters and contain a letter and a number',
    confirmPassword: 'Confirm Password',
    confirmError: 'Passwords do not match',
    rememberMe: 'Remember me',
    forgotPassword: 'Forgot password?',
    signIn: 'Sign In',
    signUp: 'Sign up',
    signInPrompt: "Don't have an account?",
    signUpPrompt: 'Already have an account?',
    rememberedPrompt: 'Remembered your password?',
    sendRecoveryLink: 'Send Recovery Link',
    updatePassword: 'Update Password',
    signingIn: 'Signing in…',
    creatingAccount: 'Creating account…',
    sending: 'Sending…',
    updating: 'Updating…',
    capsLock: '⚠️ Caps Lock is on',
    togglePasswordVisibility: 'Toggle password visibility',
    reqLength: '8+ characters',
    reqLetter: 'Letter',
    reqNumber: 'Number',
    strengthWeak: 'Weak',
    strengthFair: 'Fair',
    strengthGood: 'Good',
    strengthStrong: 'Strong',
    // Right-hand brand column
    brandTagline: 'Your personal space for better ideas and a more organized life.',
    brandFeature1: 'Secure and private',
    brandFeature2: 'Access on all devices',
    brandFeature3: 'Free and paid plans',
    brandFeature4: 'Easy to use',
    // Toasts / alerts
    welcomeNew: 'Welcome to Pocket Diary, {name}!',
    welcomeBack: 'Welcome back, {name}!',
    signedOut: 'Signed out successfully',
    recoverySent: 'Password recovery sent!',
    passwordUpdated: 'Password updated successfully',
    sessionExpired: 'Your session has expired. Please sign in again.',
    joinedWorkspace: 'You joined “{workspace}” as {role}',
    joinedWorkspaceToast: 'Welcome! You joined “{workspace}”',
    inviteFailed: 'Invitation could not be accepted',
    inviteInvalidTitle: 'This invitation is no longer valid',
  },

  // --- Sidebar ---
  sidebar: {
    dashboard: 'Dashboard',
    notes: 'Notes',
    reminders: 'Reminders',
    archive: 'Archive',
    favorites: 'Favorites',
    pinned: 'Pinned',
    dueSoon: 'Due Soon',
    calendar: 'Calendar',
    trash: 'Trash',
    categories: 'Categories',
    labels: 'Labels',
    folders: 'Folders',
    workspace: 'Workspace',
    noFolders: 'No folders yet',
    addCategory: 'Add Category',
    createLabel: 'Create Label',
    editLabels: 'Edit labels',
    addFolder: 'Add Folder',
    personal: 'Personal',
    allStatuses: 'All Statuses',
    allPriorities: 'All Priorities',
    allTypes: 'All Types',
    allColors: 'All Colors',
    customOrder: 'Custom order',
    recentlyUpdated: 'Recently updated',
    recentlyCreated: 'Recently created',
    leastRecentlyUpdated: 'Least recently updated',
    dueDateSoonest: 'Due date (soonest)',
    dueDateLatest: 'Due date (latest)',
    priorityHighest: 'Priority (highest first)',
    titleAZ: 'Title (A–Z)',
    titleZA: 'Title (Z–A)',
    // Sidebar status
    loading: 'Loading…',
    emptyTrash: 'Trash is empty',
    emptyTrashDesc: 'Deleted notes stay here — restore them individually or empty the Trash to permanently delete everything.',
    emptyTrashBtn: 'Empty Trash',
    filteredBy: 'Filtered by: ', 
    clearFilter: 'Clear Filter ✕',
    trashCount: '0 notes',
    viewAll: 'View all',
    takeNote: 'Take a note…',
    loadMore: 'Load more notes',
    upcomingReminders: 'Upcoming Reminders',
    seeAll: 'See All',
    noReminders: 'Sign in to see reminders from your memos.',
    nextWeek: 'Next week',
    mon8am: 'Mon, 8:00 AM',
    pickDateTime: 'Pick date & time:',
    save: 'Save',
    allThemes: 'All Themes',
    grocery: '🛒 Groceries',
    food: '🍔 Food',
    music: '🎵 Music',
    recipes: '🍲 Recipes',
    places: '✈️ Places',
    celebration: '🎉 Celebration',
    // Color names
    colorDefault: 'Default',
    colorRed: 'Coral',
    colorOrange: 'Peach',
    colorYellow: 'Sand',
    colorGreen: 'Mint',
    colorTeal: 'Sage',
    colorBlue: 'Fog',
    colorDarkblue: 'Storm',
    colorPurple: 'Dusk',
    colorPink: 'Blossom',
    colorBrown: 'Clay',
    colorGray: 'Chalk',
    // Theme names
    themeNone: 'None',
    themeGrocery: '🛒 Groceries',
    themeFood: '🍔 Food',
    themeMusic: '🎵 Music',
    themeRecipes: '🍲 Recipes',
    themePlaces: '✈️ Places',
    themeCelebration: '🎉 Celebration',
    // Voice typing
    voiceEnglish: 'English',
    voiceJapanese: '日本語',
    voiceListening: '🇺🇸 Listening in English… speak now — tap the mic again to stop',
    voiceListeningJa: '🇯🇵 日本語で聴取中… 話してください — 再度タップで停止',
    voiceNoMic: 'No microphone was found on this device.',
    voiceNoMicJa: 'このデバイスにマイクが見つかりません。',
    voiceNoNetwork: 'The speech service could not be reached — voice typing needs an internet connection.',
    voiceNoNetworkJa: '音声認識サービスに接続できません — ボイス入力にはインターネット接続が必要です。',
    voiceNeedHttps: 'Voice typing needs a secure connection. Open Notes over HTTPS, or from localhost — browsers block the microphone on plain http:// addresses.',
    voiceNeedHttpsJa: 'ボイス入力には安全な接続が必要です。HTTPSまたはlocalhostでNotesを開いてください。ブラウザは平文http://ではマイクをブロックします。',
    voiceNotSupported: 'Voice typing is not available in this browser. Chrome and Edge support speech-to-text — you can keep typing normally.',
    voiceNotSupportedJa: 'このブラウザではボイス入力を利用できません。ChromeとEdgeは音声入力に対応しています。通常通りタイプしてください。',
    voiceMicBlocked: 'Microphone access was blocked. Allow the microphone for this site in your browser settings and try again.',
    voiceMicBlockedJa: 'マイクへのアクセスがブロックされました。ブラウザの設定でこのサイトへのマイクアクセスを許可してから再試行してください。',
    voiceLanguageNotAvailable: 'That language is not available.',
    voiceLanguageNotAvailableJa: 'その言語は利用できません。',
    languageUnavailable: 'That language is not available.',
  },

  // --- Dashboard ---
  dashboard: {
    greetingMorning: 'Good Morning',
    greetingAfternoon: 'Good Afternoon',
    greetingEvening: 'Good Evening',
    greetingNight: 'Good Night',
    greetingSuffix: ', {name}!',
    subGreeting: "Let's make today productive.",
    kpiTotal: 'Total Memos',
    kpiFavorites: 'Favorites',
    kpiPending: 'Pending',
    kpiCompleted: 'Completed',
    newMemo: '+ New Memo',
    searchPlaceholder: 'Search memos...',
    recentMemos: 'Recent Memos',
    viewAll: 'View all',
    refresh: 'Refresh',
    newNote: '+ New note',
    filteredBy: 'Filtered by: ', 
    clearFilter: 'Clear Filter ✕',
    trashTitle: 'Trash',
    trashCount: '0 notes',
    trashDesc: 'Deleted notes stay here — restore them individually or empty the Trash to permanently delete everything.',
    emptyTrashBtn: 'Empty Trash',
    takeNote: 'Take a note…',
    tomorrowAt: 'Tomorrow, 8:00 AM',
    close: 'Close',
    allStatuses: 'All Statuses',
    inProgress: 'In Progress',
    draft: 'Draft',
    archived: 'Archived',
    allPriorities: 'All Priorities',
    urgent: 'Urgent',
    medium: 'Medium',
    low: 'Low',
    allTypes: 'All Types',
    notesType: 'Notes',
    listsType: 'Lists',
    imagesType: 'Images',
    drawingsType: 'Drawings',
    allColors: 'All Colors',
    colorDefault: 'Default',
    colorCoral: 'Coral',
    colorPeach: 'Peach',
    colorSand: 'Sand',
    colorMint: 'Mint',
    colorSage: 'Sage',
    colorFog: 'Fog',
    colorStorm: 'Storm',
    colorDusk: 'Dusk',
    colorBlossom: 'Blossom',
    colorClay: 'Clay',
    colorChalk: 'Chalk',
    customOrder: 'Custom order',
    recentlyUpdated: 'Recently updated',
    recentlyCreated: 'Recently created',
    leastRecentlyUpdated: 'Least recently updated',
    dueDateSoonest: 'Due date (soonest)',
    dueDateLatest: 'Due date (latest)',
    priorityHighest: 'Priority (highest first)',
    titleAZ: 'Title (A–Z)',
    titleZA: 'Title (Z–A)',
    emptyIcon: '📝',
    emptyTitle: 'No memos found',
    emptyDesc: 'Get started by creating your first memo or clearing current filters.',
    emptyAction: '+ Create Memo',
    loadMore: 'Load more notes',
    loading: 'Loading…',
    upcomingReminders: 'Upcoming Reminders',
    seeAll: 'See All',
    noReminders: 'Sign in to see reminders from your memos.',
    readyToSave: 'Ready to save automatically',
    history: 'History',
    pin: 'Pin',
    favorite: 'Favorite',
    delete: 'Delete',
    draw: 'Draw',
    image: 'Image',
    share: 'Share',
    saveNow: 'Save now',
    conflictTitle: 'Version Conflict:',
    conflictMsg: 'This memo was updated by another session.',
    reloadLatest: 'Reload Latest',
    bold: 'Bold (⌘B)',
    italic: 'Italic (⌘I)',
    underline: 'Underline (⌘U)',
    strike: 'Strikethrough',
    h1: 'Heading 1',
    h2: 'Heading 2',
    code: 'Code Block',
    bullet: 'Bulleted List',
    numbered: 'Numbered List',
    checklist: 'Checklist',
    blockquote: 'Blockquote',
    imageBtn: 'Attach / Insert Image',
    writeTab: 'Write',
    previewTab: 'Preview',
    splitTab: 'Split',
    pen: 'Pen',
    width: 'Width',
    undo: 'Undo',
    clear: 'Clear',
    insertDrawing: 'Insert into note',
    drawingInstruction: 'Draw with your finger or mouse. Insert saves the drawing inside this memo.',
    folder: 'Folder',
    noFolder: 'No Folder',
    category: 'Category',
    noCategory: 'No Category',
    status: 'Status',
    priority: 'Priority',
    dueDate: 'Due date',
    add: 'Add',
    details: 'Details',
    dueDateLabel: 'Due Date',
    clearDueDate: 'Clear',
    labels: 'Labels',
    create: 'Create',
    collaborators: 'Collaborators',
    home: 'Home',
    profile: 'Profile',
    saveStateSaved: 'Saved to server',
    saveStateSaving: 'Saving changes…',
    saveStateConflict: 'Conflict. Review latest version.',
    saveStateError: 'Save failed. Retry required.',
    saveStateConflictReview: 'Conflict. Review latest version.',
    saveStateSavedTime: 'Saved · {time}',
    saveStateNew: 'New note, saving automatically',
    saveStateNewSaved: 'Saved (v{version})',
    saveStateTooLarge: 'Note too large to save',
    saveStateConflictReview2: 'Conflict. Review latest version.',
  },

  // --- Landing page ---
  landing: {
    headline1: 'Your Ideas,',
    headline2: 'Notes and Tasks',
    headline3: 'All in <span class="hero-gradient-text">One Place</span>',
    headline3a: 'All in',
    headline3b: 'One Place',
    subhead: 'A modern, secure and easy-to-use memo application to capture ideas, organize your work, and stay productive anywhere. Available on web, mobile and desktop.',
    getStartedFree: 'Get Started Free',
    liveDemo: 'Live Demo',
    trustFree: 'Free Plan Available',
    trustDevices: 'Works on All Devices',
    trustPrivate: 'Your Data is Private',
    // Platforms
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    ios: 'iOS',
    android: 'Android',
    // Features section
    featuresBadge: 'Features',
    featuresHeading: 'Everything you need to stay organized',
    featuresSubhead: 'Simple but powerful features to make your life more productive.',
    featureRichText: 'Rich Text Editor',
    featureRichTextDesc: 'Write beautiful notes with formatting, lists, links and more.',
    featureCategoriesTags: 'Categories & Tags',
    featureCategoriesTagsDesc: 'Organize your memos with custom categories and tags.',
    featureReminders: 'Reminders',
    featureRemindersDesc: 'Never forget important tasks with smart reminders.',
    featureAttachments: 'Attachments',
    featureAttachmentsDesc: 'Add images, files and documents to your memos.',
    featureCalendar: 'Calendar View',
    featureCalendarDesc: 'See your memos and tasks in a beautiful calendar.',
    featureSearch: 'Search & Filters',
    featureSearchDesc: 'Find any memo instantly with powerful search and filters.',
    featureDarkMode: 'Dark Mode',
    featureDarkModeDesc: 'Beautiful light and dark themes to match your preference.',
    featureMultiDevice: 'Multi-Device',
    featureMultiDeviceDesc: 'Access your memos on web, mobile and desktop anywhere.',
    // Solutions section
    solutionsBadge: 'TAILORED WORKSPACES',
    solutionsHeading: 'Built for Every Kind of Thinker',
    solutionsSubhead: 'Whether you are writing system specs, planning sprints, or organizing personal goals.',
    solutionsEngineersTag: 'FOR ENGINEERS',
    solutionsEngineersTitle: 'Technical Specs & Architecture',
    solutionsEngineersDesc: 'Markdown code fences with syntax highlighting, FTS5 instant search across thousands of memos, and zero-latency local caching.',
    solutionsEngineersPoint1: 'Full Markdown and code block support',
    solutionsEngineersPoint2: 'Instant FTS5 full-text keyword indexing',
    solutionsEngineersPoint3: 'Keyboard shortcuts (⌘K search, ⌘S save, ⌘B/I format)',
    solutionsWritersTag: 'FOR RESEARCHERS & WRITERS',
    solutionsWritersTitle: 'Distraction-Free Thought Capture',
    solutionsWritersDesc: 'Keep your focus with dark/light themes, touch whiteboard sketches, revision history snapshots, and structured tagging.',
    solutionsWritersPoint1: 'Touch whiteboard & diagram sketch pad',
    solutionsWritersPoint2: 'Revision history tracking for every memo',
    solutionsWritersPoint3: 'Multi-tag labeling and hierarchical folders',
    solutionsTeamsTag: 'FOR TEAMS & PROJECT MANAGERS',
    solutionsTeamsTitle: 'Sprint Planning & Milestones',
    solutionsTeamsDesc: 'Stay on schedule with due dates, upcoming reminder alerts, interactive calendar matrices, and task checklist progress bars.',
    solutionsTeamsPoint1: 'Interactive task checklists with completion progress',
    solutionsTeamsPoint2: 'Monthly calendar with due date badges',
    solutionsTeamsPoint3: 'Multi-workspace tenant isolation and JSON backups',
    // Pricing section
    pricingBadge: 'SIMPLE PRICING',
    pricingHeading: 'Transparent Plans for Individuals and Teams',
    pricingSubhead: 'Start free today with no credit card required. Upgrade whenever you need advanced team capabilities.',
    pricingFreeStarter: 'Free Starter',
    pricingFreeDesc: 'Essential tools for personal note-taking and daily organization.',
    pricingFreePrice: '$0',
    pricingFreePeriod: '/ forever',
    pricingFreeFeatures: [
      'Unlimited memos and notes',
      'Up to 3 custom workspaces',
      'FTS5 full-text search',
      'Markdown editor & checklist engine',
      'Local JSON backup & migration'
    ],
    pricingProBadge: 'MOST POPULAR',
    pricingProTitle: 'Pro Productivity',
    pricingProDesc: 'For power users who need advanced history, whiteboards, and storage.',
    pricingProPrice: '$1',
    pricingProPeriod: '/ month',
    pricingProPrefix: 'Everything in Free, plus:',
    pricingProFeatures: [
      'Unlimited workspaces & folders',
      'Full revision history & version rollback',
      '10 GB cloud attachment quota',
      'Priority deadline reminders & calendar view',
      'Whiteboard sketching & image uploads'
    ],
    pricingProCTA: 'Start 14-Day Free Trial',
    pricingSelfHostedTitle: 'Self-Hosted / Team',
    pricingSelfHostedDesc: 'Complete data ownership with Docker deployment.',
    pricingSelfHostedPrice: 'Open',
    pricingSelfHostedPeriod: '/ MIT License',
    pricingSelfHostedFeatures: [
      'Self-hosted single-container deployment',
      'SQLite zero-maintenance persistence',
      'Air-gapped / offline operation',
      'Multi-tenant workspace data isolation',
      'Full API access and export tools',
      'Deploy with Docker'
    ],
    // Help & FAQ
    helpBadge: 'HELP & RESOURCES',
    helpHeading: 'Frequently Asked Questions & Guides',
    helpSubhead: 'Everything you need to know about getting started, migrating your notes, and data security.',
    faq1Q: 'Where is my note data stored?',
    faq1A: 'Pocket Diary uses an embedded SQLite database with WAL mode and dedicated file storage for attachments. In Docker deployments, your data lives in a persistent Docker volume on your server.',
    faq2Q: 'Can I migrate notes from other tools?',
    faq2A: 'Yes! The Migration & Backup Wizard automatically detects legacy notes in browser localStorage and allows importing/exporting standard JSON backup files in one click. Google Keep exports and Markdown (.md) files can be imported from Account Settings → Import & Export Notes.',
    faq3Q: 'Does Pocket Diary support Markdown and shortcuts?',
    faq3A: 'Yes, full Markdown is supported including tables, checklists, code blocks, headings, blockquotes, and keyboard shortcuts like ⌘S (save), ⌘K (search), and ⌘B / ⌘I formatting.',
    faq4Q: 'Is multi-tenant workspace isolation guaranteed?',
    faq4A: 'Every workspace is strictly isolated at the database query level with session authentication and role-based access checks, ensuring zero cross-tenant leakage.',
    ctaHeading: 'Start organizing your ideas today',
    ctaSubhead: 'Join thousands of users who trust Pocket Diary to stay productive.',
    ctaButton: 'Create Free Account',
    // Navigation
    navFeatures: 'Features',
    navPricing: 'Pricing',
    navSolutions: 'Solutions',
    navResources: 'Resources',
    navResourcesDesc: 'Guides, migration and data security',
    navApiDocs: 'API Documentation',
    navApiDocsDesc: 'OpenAPI / Swagger reference',
    navGithub: 'GitHub Repository',
    navGithubDesc: 'Source code & self-hosting',
    // Trusted platforms
    trustedTitle: 'Trusted by individuals and teams worldwide',
    platformWindows: 'Windows',
    platformMacos: 'macOS',
    platformLinux: 'Linux',
    platformIos: 'iOS',
    platformAndroid: 'Android',
  },
};

// ==========================================================================
// Japanese — partial allowed; missing keys fall back to English
// ==========================================================================
const ja = {
  common: {
    close: '閉じる',
    cancel: 'キャンセル',
    save: '保存',
    saving: '保存中…',
    saved: '保存しました',
    delete: '削除',
    edit: '編集',
    retry: '再試行',
    loading: '読み込み中…',
    confirm: '確認',
    search: '検索',
    language: '言語',
    selectLanguage: '言語を選択',
    noResults: '結果が見つかりません',
  },

  navAiButton: 'Pocket Diary AI',

  // --- Pocket Diary AI アシスタント ---
  ai: {
    title: 'Pocket Diary AI',
    newChat: '新しいチャット',
    history: 'チャット履歴',
    settings: 'AI 設定',
    close: 'AIチャットを閉じる',
    providerSelect: 'AIプロバイダーとモデル',
    send: 'メッセージを送信',
    cancel: '生成をキャンセル',
    composerPlaceholder: '質問・ブレインストーミング・計画…（Enterで送信、Shift+Enterで改行）',
    scopeGeneral: '一般チャット — ノートは共有されていません',
    scopeNote: '現在のノート',
    scopeNoteBlocked: '現在のノート: AI共有はブロックされています',
    scopeSearch: 'AI検索 — 承認するまで結果はローカルにとどまります',
    noProvider: 'プロバイダー未設定',
    noProviderToast: 'AIプロバイダーが設定されていません。AI設定でAPIキーを追加してください。',
    secretWarning: '⚠ 認証情報のように見えます。チャット内容は選択したAIプロバイダーに送信されます。意図がない場合は削除してください。',
    findNote: '🔍 ノートを探す / AI検索',
    summarizeNote: 'このノートを要約',
    improveNote: '文章を改善',
    saveTranscript: '会話をノートとして保存',
    summarizePrompt: 'このノートを要約してください。',
    improvePrompt: 'このノートの文章を改善してください。',
    searchResultsLocal: 'ローカル検索結果（あなたにのみ表示）',
    searchNoResults: 'ローカルでは見つかりませんでした。別の語で試してください。',
    searchPrivacyNote: '検索結果は非公開です。確認して承認した墨消し済みの抜粋だけがAIに送信されます。',
    reviewSelected: '選択したノートを確認',
    selectForAnalysis: 'AI分析のために選択',
    selectMaxTen: '一度に承認できるノートは10件までです。',
    loadMoreSearch: 'もっと表示',
    previewBeforeSharing: 'AIに送信する内容を確認',
    someNotesExcluded: '一部のノートはプライバシー設定により除外されました。',
    approveAiReading: '承認してAIで分析',
    searchReadPrompt: '今承認した抜粋だけを要約して比較してください。関連するノートのタイトルを明示してください。',
    eligibleShort: 'AI検索可',
    blockedShort: 'ブロック',
    currentOnlyShort: '許可制',
    eligibleHint: 'プレビューして承認した場合に限りAI検索の読み取りに使えます。',
    blockedHint: 'AIには一切共有されません — 内容も存在もモデルには隠されます。',
    currentOnlyHint: '開いているノートへの明示的なタスクでのみ共有されます。',
    proposalCreateTitle: '📝 ノート案 — 保存前に確認',
    proposalUpdateTitle: '✏️ ノート更新案 — 差分を確認',
    proposalTarget: '対象ノートのバージョン',
    proposalCreate: 'ノートを作成',
    proposalApply: '更新を適用',
    proposalCancel: 'キャンセル',
    proposalRejected: '却下しました。何も書き込まれていません。',
    proposalConflict: 'ドラフト後にノートが変更されました。再読み込みしてやり直してください。',
    proposalFailed: '提案を処理できませんでした。',
    noteSaved: 'ノートを保存しました。',
    noteAutoSaved: 'ノートを自動保存しました（設定により）。',
    noteSavedAs: 'ノートとして保存',
    openNote: 'ノートを開く',
    untitled: '無題',
    tryAgain: 'もう一度メッセージを送信してください。',
    interruptedNotice: '生成が中断されました（サーバー再起動またはキャンセル）。不正確な完了は表示しません — 再送してください。',
    errorSend: 'メッセージを送信できませんでした。',
    errorSave: '保存に失敗しました。',
    errorLoad: '読み込みに失敗しました。',
    errorLoadHistory: 'チャット履歴を読み込めませんでした。',
    errorLoadProviders: 'AI設定を読み込めませんでした。',
    errorCreateConversation: 'チャットを開始できませんでした。',
    noteAccessDenied: 'AIはこのノートを読み取れません。',
    noteBlockedToast: 'このノートは「AIに共有しない」に設定されています。ノートのAIプライバシー設定から変更できます。',
    historyEmpty: 'まだ会話がありません。',
    loading: '読み込み中…',
    done: '完了',
    settingsTitle: 'AI 設定',
    settingsIntro: '自分のAPIキーを使用します。キーはサーバー側でAES-256-GCMで暗号化され、二度と表示されません。AIへのリクエストはすべてPocket Diaryのバックエンドから実行されます（ブラウザからは送信しません）。',
    vaultWarning: 'このサーバーではAI資格情報が無効です（AI_CREDENTIAL_ENCRYPTION_KEY未設定）。管理者に設定を依頼してください。',
    noProvidersYet: 'AIプロバイダーが未設定です。下で追加するとすぐに利用できます。',
    defaultBadge: 'デフォルト',
    model: 'モデル',
    modelRequired: 'モデルIDを入力してください。',
    keyMasked: 'APIキー',
    keyPlaceholder: 'sk-…（一度入力、暗号化して保存）',
    keyReplaceOptional: '空欄のままで現在のキーを維持',
    keyRequired: 'APIキーを入力してください（8文字以上）。',
    addProvider: 'プロバイダーを追加・更新',
    provider: 'プロバイダー',
    label: 'ラベル',
    labelPlaceholder: '仕事用キー',
    apiKey: 'APIキー',
    addConfig: '設定を追加',
    updateConfig: '設定を更新',
    fetchModels: 'モデル一覧を取得',
    modelsNeedConfig: 'まずこのプロバイダーの設定を保存してください。',
    modelsFetched: 'モデル一覧を更新しました。',
    modelWarning: 'モデルIDは入力値のまま使われます。完全な機能にはツール呼び出し対応モデルをご確認ください。',
    testConnection: '接続テスト',
    testing: 'テスト中…',
    testFailed: 'テストに失敗しました。',
    setDefault: 'デフォルトに設定',
    edit: '編集',
    delete: '削除',
    deleteConfirmTitle: 'プロバイダー設定を削除しますか？',
    deleteConfirmBody: '暗号化されたキーは削除されます。チャットは残り、別の設定プロバイダーが使われます。',
    deleted: '設定を削除しました。',
    added: '設定を保存しました。',
    configSaved: '設定を保存しました。',
    enterModelManually: '手動で入力',
    chooseFromList: '一覧から選択',
    enterKeyFirst: 'APIキーを入力するとモデル一覧が自動的に読み込まれます。',
    editingBanner: '保存済みの設定を編集中 — 保存で更新されます（キーは任意）',
    noModelsFound: 'このAPIキーで利用可能なモデルが返されませんでした。モデルIDを手動入力できます。',
    modelsLoading: 'プロバイダーから利用可能なモデルを安全に取得しています…',
    modelsWaiting: 'APIキーの入力が終わったら、モデルを確認します…',
    modelsLoaded: '{count}個の利用可能なモデルを取得しました。',
    modelsAutoFailed: 'モデルを自動取得できませんでした。モデルIDを手動入力できます。',
    currentModelNotListed: '保存済みモデル（現在の一覧にありません）',
    modelManualActive: 'モデルIDを手動入力します。チャットとツールに対応しているかご確認ください。',
    modelIdPlaceholder: 'モデルIDを入力、または自動取得した一覧から選択',
    autoModelsHint: 'APIキーを使用してモデル一覧を自動取得します。保存済みキーにも対応しています。取得できない場合は手動入力できます。',
    updated: '設定を更新しました。',
    cancelEdit: '編集をキャンセル',
    privacyTitle: 'このノートのAIプライバシー',
    privacyIntro: 'これらの設定は外部AIへの開示のみを規制します。通常の検索やワークスペースアクセスは変わりません。',
    privacyBlocked: 'AIに共有しない（ブロック）',
    privacyBlockedDesc: 'ノートを開いていても、内容も存在も外部AIには一切送信されません。',
    privacyCurrentOnly: '自分が頼んだ時だけ（デフォルト）',
    privacyCurrentOnlyDesc: '開いているノートへの明示的な依頼に限り、期間限定で共有されます。',
    privacySearchAllowed: 'AI検索での利用を許可',
    privacySearchAllowedDesc: 'AI検索の分析対象になりますが、毎回プレビューして承認した場合に限ります。',
    protectedHeading: '保護された一節 — AIに共有しない',
    protectedIntro: '保護する一節を貼り付けます。AIプロバイダーに送る前に[REDACTED]に置き換えられます。一節そのものは保存されず、ソルト付きの指紋のみ記録されます。',
    protectedPlaceholder: '保護するテキストをそのまま貼り付け…',
    protectedAdd: '一節を保護',
    protectedPassage: '保護された一節',
    protectedNone: '保護された一節はありません。',
    protectedAdded: '一節を保護しました。',
    protectedRemoved: '保護を解除しました。',
    protectedTooShort: '保護する一節は3文字以上必要です。',
    characters: '文字',
    remove: '削除',
    policySaved: 'AIプライバシーを更新しました。',
    viewerDenied: '閲覧者はAIプライバシー設定を変更できません。',
  },

  nav: {
    login: 'ログイン',
    getStarted: 'はじめる',
    searchPlaceholder: 'メモ・タグ・内容を検索...',
    searchAria: 'メモを検索',
    filters: 'フィルター',
    showFilters: 'フィルターを表示',
    toggleTheme: 'ダーク/ライトテーマを切り替え',
    notifications: '通知',
    ai: 'Pocket Diary AI',
    markAllRead: 'すべて既読',
    notificationsEmpty: '通知はまだありません。メモに設定したリマインダーがここに表示されます。',
    enablePush: '🔔 プッシュ通知を有効にする',
    dashboard: 'ダッシュボード',
    accountSettings: 'アカウント設定',
    teamMembers: 'チームとメンバー',
    toggleDarkMode: 'ダークモードを切り替え',
    dark: 'ダーク',
    light: 'ライト',
    signOut: 'サインアウト',
    active: '使用中',
    switcherAria: '言語を変更',
  },

  auth: {
    welcomeBack: 'おかえりなさい',
    signInSubtitle: 'Pocket Diary アカウントにサインイン',
    createAccount: 'アカウント作成',
    registerSubtitle: '無料の Pocket Diary ワークスペースを始めましょう',
    resetTitle: 'パスワードのリセット',
    resetSubtitle: 'メールアドレスを入力すると、パスワード復旧手順をお送りします',
    newPasswordTitle: '新しいパスワードの設定',
    newPasswordSubtitle: '回復を完了するには、新しいパスワードを入力して確認してください',
    fullName: '氏名',
    fullNamePh: '山田 太郎',
    fullNameError: '氏名を入力してください',
    email: 'メールアドレス',
    emailError: '有効なメールアドレスを入力してください',
    password: 'パスワード',
    passwordError: 'パスワードは8文字以上で、英字と数字を含める必要があります',
    confirmPassword: 'パスワード（確認）',
    confirmError: 'パスワードが一致しません',
    rememberMe: 'ログイン状態を保持',
    forgotPassword: 'パスワードをお忘れですか？',
    signIn: 'サインイン',
    signUp: '新規登録',
    signInPrompt: 'アカウントをお持ちでないですか？',
    signUpPrompt: 'すでにアカウントをお持ちですか？',
    rememberedPrompt: 'パスワードを思い出しましたか？',
    sendRecoveryLink: '復旧リンクを送信',
    updatePassword: 'パスワードを更新',
    signingIn: 'サインイン中…',
    creatingAccount: 'アカウント作成中…',
    sending: '送信中…',
    updating: '更新中…',
    capsLock: '⚠️ Caps Lock が有効です',
    togglePasswordVisibility: 'パスワードの表示を切り替え',
    reqLength: '8文字以上',
    reqLetter: '英字',
    reqNumber: '数字',
    strengthWeak: '弱い',
    strengthFair: '普通',
    strengthGood: '良い',
    strengthStrong: '強い',
    brandTagline: 'より良いアイデアと、より整理された生活のためのあなたの個人空間。',
    brandFeature1: '安全でプライベート',
    brandFeature2: 'すべてのデバイスで利用可能',
    brandFeature3: '無料プランと有料プラン',
    brandFeature4: '簡単に使える',
    welcomeNew: 'Pocket Diary へようこそ、{name}さん！',
    welcomeBack: 'おかえりなさい、{name}さん！',
    signedOut: 'サインアウトしました',
    recoverySent: 'パスワード復旧メールを送信しました！',
    passwordUpdated: 'パスワードを更新しました',
    sessionExpired: 'セッションの有効期限が切れました。再度サインインしてください。',
    joinedWorkspace: '「{workspace}」に {role} として参加しました',
    joinedWorkspaceToast: 'ようこそ！「{workspace}」に参加しました',
    inviteFailed: '招待を承諾できませんでした',
    inviteInvalidTitle: 'この招待は無効になりました',
  },

  sidebar: {
    dashboard: 'ダッシュボード',
    notes: 'ノート',
    reminders: 'リマインダー',
    archive: 'アーカイブ',
    favorites: 'お気に入り',
    pinned: 'ピン留め',
    dueSoon: '期限が近い',
    calendar: 'カレンダー',
    trash: 'ゴミ箱',
    categories: 'カテゴリー',
    labels: 'ラベル',
    folders: 'フォルダー',
    workspace: 'ワークスペース',
    noFolders: 'フォルダーはまだありません',
    addCategory: 'カテゴリーを追加',
    createLabel: 'ラベルを作成',
    editLabels: 'ラベルを編集',
    addFolder: 'フォルダーを追加',
    personal: '個人',
    allStatuses: 'すべてのステータス',
    allPriorities: 'すべての優先度',
    allTypes: 'すべてのタイプ',
    allColors: 'すべての色',
    customOrder: 'カスタム順',
    recentlyUpdated: '最近更新された順',
    recentlyCreated: '最近作成された順',
    leastRecentlyUpdated: '最も古い更新順',
    dueDateSoonest: '期限が近い順',
    dueDateLatest: '期限が遠い順',
    priorityHighest: '優先度（高い順）',
    titleAZ: 'タイトル（あ–ん）',
    titleZA: 'タイトル（ん–あ）',
    loading: '読み込み中…',
    emptyTrash: 'ゴミ箱は空です',
    emptyTrashDesc: '削除したメモはここに保管されます。個別に復元するか、ゴミ箱を空にして完全に削除できます。',
    emptyTrashBtn: 'ゴミ箱を空にする',
    filteredBy: '絞り込み: ', 
    clearFilter: '絞り込み解除 ✕',
    trashCount: '0 件',
    viewAll: 'すべて表示',
    takeNote: 'メモを書く…',
    loadMore: 'もっと読み込む',
    upcomingReminders: '今後のリマインダー',
    seeAll: 'すべて見る',
    noReminders: 'リマインダーはありません。メモに期限を設定するとここに表示されます。',
    nextWeek: '来週',
    mon8am: '月曜日, 8:00 AM',
    pickDateTime: '日付と時刻を選択:',
    save: '保存',
    allThemes: 'すべてのテーマ',
    grocery: '🛒 食料品',
    food: '🍔 食事',
    music: '🎵 音楽',
    recipes: '🍲 レシピ',
    places: '✈️ 場所',
    celebration: '🎉 お祝い',
    colorDefault: 'デフォルト',
    colorRed: 'コーラル',
    colorOrange: 'ピーチ',
    colorYellow: 'サンド',
    colorGreen: 'ミント',
    colorTeal: 'セージ',
    colorBlue: 'フォグ',
    colorDarkblue: 'ストーム',
    colorPurple: 'ダスク',
    colorPink: 'ブロッサム',
    colorBrown: 'クレイ',
    colorGray: 'チョーク',
    themeNone: 'なし',
    themeGrocery: '🛒 食料品',
    themeFood: '🍔 食事',
    themeMusic: '🎵 音楽',
    themeRecipes: '🍲 レシピ',
    themePlaces: '✈️ 場所',
    themeCelebration: '🎉 お祝い',
    voiceEnglish: 'English',
    voiceJapanese: '日本語',
    voiceListening: '🇺🇸 Listening in English… speak now — tap the mic again to stop',
    voiceListeningJa: '🇯🇵 日本語で聴取中… 話してください — 再度タップで停止',
    voiceNoMic: 'このデバイスにマイクが見つかりません。',
    voiceNoNetwork: '音声認識サービスに接続できません — ボイス入力にはインターネット接続が必要です。',
    voiceNeedHttps: 'ボイス入力には安全な接続が必要です。HTTPSまたはlocalhostでNotesを開いてください。ブラウザは平文http://ではマイクをブロックします。',
    voiceNotSupported: 'このブラウザではボイス入力を利用できません。ChromeとEdgeは音声入力に対応しています。通常通りタイプしてください。',
    voiceMicBlocked: 'マイクへのアクセスがブロックされました。ブラウザの設定でこのサイトへのマイクアクセスを許可してから再試行してください。',
    voiceLanguageNotAvailable: 'その言語は利用できません。',
  },

  dashboard: {
    greetingMorning: 'おはようございます',
    greetingAfternoon: 'こんにちは',
    greetingEvening: 'こんばんは',
    greetingNight: 'おやすみなさい',
    greetingSuffix: '、{name}さん！',
    subGreeting: '今日も生産的にしましょう。',
    kpiTotal: '総メモ数',
    kpiFavorites: 'お気に入り',
    kpiPending: '保留中',
    kpiCompleted: '完了',
    newMemo: '+ 新規メモ',
    searchPlaceholder: 'メモを検索...',
    recentMemos: '最近のメモ',
    viewAll: 'すべて表示',
    refresh: '更新',
    newNote: '+ 新規メモ',
    filteredBy: '絞り込み: ', 
    clearFilter: '絞り込み解除 ✕',
    trashTitle: 'ゴミ箱',
    trashCount: '0 件',
    trashDesc: '削除したメモはここに保管されます。個別に復元するか、ゴミ箱を空にして完全に削除できます。',
    emptyTrashBtn: 'ゴミ箱を空にする',
    takeNote: 'メモを書く…',
    tomorrowAt: '明日, 8:00 AM',
    close: '閉じる',
    allStatuses: 'すべてのステータス',
    inProgress: '進行中',
    draft: '下書き',
    archived: 'アーカイブ済み',
    allPriorities: 'すべての優先度',
    urgent: '緊急',
    medium: '中',
    low: '低',
    allTypes: 'すべてのタイプ',
    notesType: 'ノート',
    listsType: 'リスト',
    imagesType: '画像',
    drawingsType: '手書き',
    allColors: 'すべての色',
    colorDefault: 'デフォルト',
    colorCoral: 'コーラル',
    colorPeach: 'ピーチ',
    colorSand: 'サンド',
    colorMint: 'ミント',
    colorSage: 'セージ',
    colorFog: 'フォグ',
    colorStorm: 'ストーム',
    colorDusk: 'ダスク',
    colorBlossom: 'ブロッサム',
    colorClay: 'クレイ',
    colorChalk: 'チョーク',
    customOrder: 'カスタム順',
    recentlyUpdated: '最近更新された順',
    recentlyCreated: '最近作成された順',
    leastRecentlyUpdated: '最も古い更新順',
    dueDateSoonest: '期限が近い順',
    dueDateLatest: '期限が遠い順',
    priorityHighest: '優先度（高い順）',
    titleAZ: 'タイトル（あ–ん）',
    titleZA: 'タイトル（ん–あ）',
    emptyIcon: '📝',
    emptyTitle: 'メモが見つかりません',
    emptyDesc: '最初のメモを作成するか、フィルターをクリアして始めましょう。',
    emptyAction: '+ メモを作成',
    loadMore: 'もっと読み込む',
    loading: '読み込み中…',
    upcomingReminders: '今後のリマインダー',
    seeAll: 'すべて見る',
    noReminders: 'リマインダーはありません。メモに期限を設定するとここに表示されます。',
    readyToSave: '自動保存の準備完了',
    history: '履歴',
    pin: 'ピン留め',
    favorite: 'お気に入り',
    delete: '削除',
    draw: '手書き',
    image: '画像',
    share: '共有',
    saveNow: '今すぐ保存',
    conflictTitle: 'バージョン競合:',
    conflictMsg: 'このメモは別のセッションで更新されました。',
    reloadLatest: '最新版を読み込む',
    bold: '太字 (⌘B)',
    italic: '斜体 (⌘I)',
    underline: '下線 (⌘U)',
    strike: '取り消し線',
    h1: '見出し 1',
    h2: '見出し 2',
    code: 'コードブロック',
    bullet: '箇条書きリスト',
    numbered: '番号付きリスト',
    checklist: 'チェックリスト',
    blockquote: '引用',
    imageBtn: '画像を添付/挿入',
    writeTab: '書く',
    previewTab: 'プレビュー',
    splitTab: '分割',
    pen: 'ペン',
    width: '太さ',
    undo: '元に戻す',
    clear: 'クリア',
    insertDrawing: 'メモに挿入',
    drawingInstruction: '指やマウスで描画してください。挿入するとこのメモに保存されます。',
    folder: 'フォルダー',
    noFolder: 'フォルダーなし',
    category: 'カテゴリー',
    noCategory: 'カテゴリーなし',
    status: 'ステータス',
    priority: '優先度',
    dueDate: '期日',
    add: '追加',
    details: '詳細',
    dueDateLabel: '期日',
    clearDueDate: 'クリア',
    labels: 'ラベル',
    create: '作成',
    collaborators: '共同編集者',
    home: 'ホーム',
    profile: 'プロフィール',
    saveStateSaved: 'サーバーに保存済み',
    saveStateSaving: '変更を保存中…',
    saveStateConflict: '競合。最新版を確認してください。',
    saveStateError: '保存に失敗しました。再試行してください。',
    saveStateConflictReview: '競合。最新版を確認してください。',
    saveStateSavedTime: '保存済み · {time}',
    saveStateNew: '新規メモ、自動保存中',
    saveStateNewSaved: '保存済み (v{version})',
    saveStateTooLarge: 'メモが大きすぎて保存できません',
    saveStateConflictReview2: '競合。最新版を確認してください。',
  },

  landing: {
    headline1: 'アイデア、',
    headline2: 'ノート、タスクを',
    headline3: 'すべて<span class="hero-gradient-text">ひとつの場所に</span>',
    headline3a: 'すべて',
    headline3b: 'ひとつの場所に',
    subhead: 'アイデアを記録し、仕事を整理し、どこでも生産的でいられる、モダンで安全かつ使いやすいメモアプリケーション。Web・モバイル・デスクトップで利用できます。',
    getStartedFree: '無料で始める',
    liveDemo: 'ライブデモ',
    trustFree: '無料プランあり',
    trustDevices: 'すべてのデバイスで動作',
    trustPrivate: 'データは非公開',
    // Platforms
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    ios: 'iOS',
    android: 'Android',
    // Features section
    featuresBadge: '機能',
    featuresHeading: '整理整頓に必要なすべての機能',
    featuresSubhead: 'シンプルでありながら強力な機能で、より生産的な毎日を。',
    featureRichText: 'リッチテキストエディター',
    featureRichTextDesc: '書式設定、リスト、リンクなどで美しいノートを作成。',
    featureCategoriesTags: 'カテゴリーとタグ',
    featureCategoriesTagsDesc: 'カスタムカテゴリーとタグでメモを整理。',
    featureReminders: 'リマインダー',
    featureRemindersDesc: 'スマートなリマインダーで重要なタスクを忘れない。',
    featureAttachments: '添付ファイル',
    featureAttachmentsDesc: '画像、ファイル、ドキュメントをメモに追加。',
    featureCalendar: 'カレンダービュー',
    featureCalendarDesc: 'メモとタスクを美しいカレンダーで確認。',
    featureSearch: '検索とフィルター',
    featureSearchDesc: '強力な検索とフィルターでどんなメモも瞬時に発見。',
    featureDarkMode: 'ダークモード',
    featureDarkModeDesc: '好みに合わせて選べる美しいライト/ダークテーマ。',
    featureMultiDevice: 'マルチデバイス',
    featureMultiDeviceDesc: 'Web、モバイル、デスクトップ、どこでもメモにアクセス。',
    // Solutions section
    solutionsBadge: 'ニーズに合わせたワークスペース',
    solutionsHeading: 'あらゆる思考者のために',
    solutionsSubhead: 'システム仕様の作成、スプリント計画、個人の目標管理など、あらゆるニーズに対応。',
    solutionsEngineersTag: 'エンジニア向け',
    solutionsEngineersTitle: '技術仕様とアーキテクチャ',
    solutionsEngineersDesc: 'シンタックスハイライト付きMarkdownコードフェンス、数千メモを瞬時に検索するFTS5、ゼロレイテンシのローカルキャッシュ。',
    solutionsEngineersPoint1: '完全なMarkdownとコードブロック対応',
    solutionsEngineersPoint2: '瞬時のFTS5全文キーワード索引',
    solutionsEngineersPoint3: 'キーボードショートカット（⌘K検索、⌘S保存、⌘B/I書式）',
    solutionsWritersTag: '研究者・ライター向け',
    solutionsWritersTitle: '集中できる思考の記録',
    solutionsWritersDesc: 'ダーク/ライトテーマ、タッチホワイトボード、リビジョン履歴、構造化タグで集中力をキープ。',
    solutionsWritersPoint1: 'タッチ対応ホワイトボードと図式スケッチパッド',
    solutionsWritersPoint2: 'すべてのメモのリビジョン履歴追跡',
    solutionsWritersPoint3: 'マルチタグ・ラベリングと階層フォルダー',
    solutionsTeamsTag: 'チーム・プロジェクトマネージャー向け',
    solutionsTeamsTitle: 'スプリント計画とマイルストーン',
    solutionsTeamsDesc: '期日、リマインダー、インタラクティブなカレンダー、タスクチェックリスト進捗でスケジュール管理。',
    solutionsTeamsPoint1: '進捗付きインタラクティブなタスクチェックリスト',
    solutionsTeamsPoint2: '期日バッジ付き月間カレンダー',
    solutionsTeamsPoint3: 'マルチワークスペースのテナント分離とJSONバックアップ',
    // Pricing section
    pricingBadge: 'シンプルな料金',
    pricingHeading: '個人とチームのための透明なプラン',
    pricingSubhead: 'クレジットカード不要で今すぐ無料開始。高度なチーム機能が必要になったらアップグレード。',
    pricingFreeStarter: 'フリースターター',
    pricingFreeDesc: '個人のメモ取りと日々の整理に必須のツール。',
    pricingFreePrice: '$0',
    pricingFreePeriod: '/ 無期限',
    pricingFreeFeatures: [
      '無制限のメモとノート',
      '最大3つのカスタムワークスペース',
      'FTS5全文検索',
      'Markdownエディターとチェックリストエンジン',
      'ローカルJSONバックアップと移行'
    ],
    pricingProBadge: '人気No.1',
    pricingProTitle: 'プロ生産性',
    pricingProDesc: '履歴、ホワイトボード、ストレージが必要なパワーユーザー向け。',
    pricingProPrice: '$1',
    pricingProPeriod: '/ 月',
    pricingProPrefix: 'Freeプランのすべてに加えて：',
    pricingProFeatures: [
      '無制限のワークスペースとフォルダー',
      '完全なリビジョン履歴とバージョンロールバック',
      '10 GBのクラウド添付ファイル容量',
      '優先期限リマインダーとカレンダービュー',
      'ホワイトボードスケッチと画像アップロード'
    ],
    pricingProCTA: '14日間無料トライアルを開始',
    pricingSelfHostedTitle: 'セルフホステッド / チーム',
    pricingSelfHostedDesc: 'Dockerデプロイで完全なデータ所有権。',
    pricingSelfHostedPrice: 'オープン',
    pricingSelfHostedPeriod: '/ MITライセンス',
    pricingSelfHostedFeatures: [
      'シングルコンテナのセルフホステッドデプロイ',
      'ゼロメンテナンスのSQLite永続化',
      'エアギャップ / オフライン運用',
      'マルチテナントのワークスペースデータ分離',
      'フルAPIアクセスとエクスポートツール',
      'Dockerでデプロイ'
    ],
    // Help & FAQ
    helpBadge: 'ヘルプとリソース',
    helpHeading: 'よくある質問とガイド',
    helpSubhead: '使い始め、ノート移行、データセキュリティについて知っておくべきすべて。',
    faq1Q: 'ノートデータはどこに保存されますか？',
    faq1A: 'Pocket DiaryはWALモードの組み込みSQLiteデータベースと、添付ファイル専用のファイルストレージを使用します。Dockerデプロイでは、データはサーバー上の永続Dockerボリュームに保存されます。',
    faq2Q: '他のツールからノートを移行できますか？',
    faq2A: 'はい！移行＆バックアップウィザードがブラウザのlocalStorage内のレガシーノートを自動検出し、標準JSONバックアップファイルのインポート/エクスポートをワンクリックで可能にします。Google KeepのエクスポートとMarkdown(.md)ファイルは、アカウント設定→インポート＆エクスポートからインポート可能です。',
    faq3Q: 'Pocket DiaryはMarkdownとショートカットをサポートしていますか？',
    faq3A: 'はい、テーブル、チェックリスト、コードブロック、見出し、引用、キーボードショートカット（⌘S保存、⌘K検索、⌘B/⌘I書式）を含む完全なMarkdownをサポートしています。',
    faq4Q: 'マルチテナントのワークスペース分離は保証されますか？',
    faq4A: 'すべてのワークスペースは、セッション認証とロールベースのアクセスチェックにより、データベースクエリレベルで厳密に分離され、クロステナント漏洩を防止します。',
    ctaHeading: '今すぐアイデアを整理し始めましょう',
    ctaSubhead: 'Pocket Diaryを信頼して生産性を高めている数千人のユーザーに加わりませんか。',
    ctaButton: '無料アカウントを作成',
    // Navigation
    navFeatures: '機能',
    navPricing: '料金',
    navSolutions: 'ソリューション',
    navResources: 'リソース',
    navResourcesDesc: 'ガイド、移行、データセキュリティ',
    navApiDocs: 'APIドキュメント',
    navApiDocsDesc: 'OpenAPI / Swaggerリファレンス',
    navGithub: 'GitHubリポジトリ',
    navGithubDesc: 'ソースコードとセルフホスティング',
    // Trusted platforms
    trustedTitle: '世界中の個人とチームに信頼されています',
    platformWindows: 'Windows',
    platformMacos: 'macOS',
    platformLinux: 'Linux',
    platformIos: 'iOS',
    platformAndroid: 'Android',
  },
};

// ==========================================================================
// Locale store — register locales here (English MUST stay complete)
// ==========================================================================
const LOCALES = { en, ja };

// ==========================================================================
// State
// ==========================================================================
let currentLanguage = BASE_LANGUAGE;

/** Escape a value for safe interpolation into innerHTML contexts. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#39;');
}

/** Resolve a dotted key ("auth.welcomeBack") inside a dictionary object. */
function lookup(dict, key) {
  if (!dict || !key) return undefined;
  let node = dict;
  for (const part of key.split('.')) {
    if (node === undefined || node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Fill `{param}` placeholders. Values are NOT escaped here (callers choose). */
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

// ==========================================================================
// Public API
// ==========================================================================

/**
 * Translate a key in the current language.
 * Falls back: current language → English → the key itself (never blank).
 *
 * @param {string} key Dotted key, e.g. 'auth.welcomeBack'
 * @param {object} [params] Interpolation values, e.g. { name: 'Alex' }
 * @returns {string}
 */
export function t(key, params) {
  const translated = lookup(LOCALES[currentLanguage], key) ?? lookup(LOCALES[BASE_LANGUAGE], key) ?? key;
  return interpolate(translated, params);
}

/**
 * Translate a key and HTML-escape both the result's interpolated values.
 * Use when the string is inserted via innerHTML.
 */
export function tEsc(key, params) {
  const escapedParams = {};
  if (params) {
    for (const [k, v] of Object.entries(params)) escapedParams[k] = escapeHtml(v);
  }
  return t(key, escapedParams);
}

/** Currently active language code (BCP-47, e.g. 'en' | 'ja'). */
export function getLanguage() {
  return currentLanguage;
}

/** Metadata for the switcher UI: [{ code, name, flag, active }]. */
export function getLanguages() {
  return Object.entries(LANGUAGES).map(([code, meta]) => ({
    code,
    name: meta.name,
    flag: meta.flag,
    active: code === currentLanguage,
  }));
}

/** Persisted preference → saved value | navigator languages | base. */
function detectInitialLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES[saved]) return saved;
  } catch {
    /* storage unavailable (private mode) — fall through */
  }
  const candidates = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
  for (const candidate of candidates) {
    const code = String(candidate || '').toLowerCase();
    if (LANGUAGES[code]) return code; // exact match ('ja')
    const primary = code.split('-')[0]; // regional match ('ja-JP' → 'ja')
    if (primary && LANGUAGES[primary]) return primary;
  }
  return BASE_LANGUAGE;
}

/**
 * Walk the DOM and apply every data-i18n* attribute.
 * @param {ParentNode} [root] Defaults to the whole document.
 */
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    // innerHTML is only fed from trusted dictionary strings, never user input.
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
}

/** Apply the language to <html lang> and every annotated element. */
function render() {
  document.documentElement.setAttribute('lang', currentLanguage);
  applyTranslations();
}

/**
 * Change the active language, persist it locally, re-translate the DOM and
 * notify listeners (`window` event `language:changed`).
 * @param {string} code Language code registered in LANGUAGES
 */
export function setLanguage(code) {
  if (!LANGUAGES[code] || code === currentLanguage) return;
  currentLanguage = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* storage unavailable — keep in-memory choice for this page load */
  }
  render();
  window.dispatchEvent(new CustomEvent('language:changed', { detail: { language: code } }));
}

/** Detect and apply the initial language. Call once during app bootstrap. */
export function initI18n() {
  currentLanguage = detectInitialLanguage();
  render();
  return currentLanguage;
}

// ==========================================================================
// Locale-aware formatting helpers (Intl-based)
// ==========================================================================

/** Format a date in the active locale, e.g. 2024/05/12 or 2024年5月12日. */
export function formatDate(date, options) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const opts = options ?? { year: 'numeric', month: 'short', day: 'numeric' };
  try {
    return new Intl.DateTimeFormat(currentLanguage === BASE_LANGUAGE ? 'en-US' : currentLanguage, opts).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

/** Format a time in the active locale, e.g. 9:41 AM or 9:41. */
export function formatTime(date, options) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const opts = options ?? { hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(currentLanguage === BASE_LANGUAGE ? 'en-US' : currentLanguage, opts).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

/** Date + time combined. */
export function formatDateTime(date, options) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${formatDate(d, options?.date)} ${formatTime(d, options?.time)}`;
}

// ==========================================================================
// Language switcher UI (globe button + dropdown in the top navbar)
// ==========================================================================

/**
 * Build and wire the language switcher dropdown. Idempotent — safe to call
 * once from setupEventListeners().
 */
export function setupLanguageSwitcher() {
  const btn = document.getElementById('language-switcher-btn');
  const panel = document.getElementById('language-switcher-panel');
  if (!btn || !panel) return;

  const renderPanel = () => {
    panel.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'language-panel-header';
    header.textContent = t('common.selectLanguage');
    panel.appendChild(header);

    for (const lang of getLanguages()) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `language-option${lang.active ? ' active' : ''}`;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(lang.active));
      item.dataset.lang = lang.code;

      const flag = document.createElement('span');
      flag.className = 'language-option-flag';
      flag.textContent = lang.flag;
      flag.setAttribute('aria-hidden', 'true');

      const name = document.createElement('span');
      name.className = 'language-option-name';
      name.textContent = lang.name;

      const check = document.createElement('span');
      check.className = 'language-option-check';
      check.textContent = lang.active ? '✓' : '';
      check.setAttribute('aria-hidden', 'true');

      item.append(flag, name, check);
      item.addEventListener('click', () => {
        setLanguage(lang.code);
        closePanel();
      });
      panel.appendChild(item);
    }
  };

  const openPanel = () => {
    renderPanel();
    panel.style.display = 'block';
    btn.setAttribute('aria-expanded', 'true');
  };

  const closePanel = () => {
    panel.style.display = 'none';
    btn.setAttribute('aria-expanded', 'false');
  };

  const isOpen = () => panel.style.display === 'block';

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (isOpen()) closePanel();
    else openPanel();
  });

  // Close on outside click / Escape — mirrors the notifications panel behavior.
  document.addEventListener('click', (event) => {
    if (!isOpen()) return;
    if (panel.contains(event.target) || btn.contains(event.target)) return;
    closePanel();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) closePanel();
  });

  // Keep the panel in sync if the language changes elsewhere.
  window.addEventListener('language:changed', () => {
    if (isOpen()) renderPanel();
  });
}
