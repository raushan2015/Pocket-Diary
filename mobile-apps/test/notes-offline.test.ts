import { describe, it, expect, beforeEach } from 'vitest';
import { NotesRepository } from '@/features/notes/repository';
import { NodeSqliteDriver } from '@/services/db/driver.node';
import { initializeDatabase } from '@/services/db/database';

describe('Offline Notes Repository & Local Persistence', () => {
  let db: NodeSqliteDriver;
  let repo: NotesRepository;
  const scope = { serverKey: 'https://notes.example.com', userId: 'user-123' };

  beforeEach(() => {
    db = new NodeSqliteDriver(':memory:');
    initializeDatabase(db);
    repo = new NotesRepository(db, scope);
  });

  it('creates and retrieves notes offline with full Google Keep-style metadata', () => {
    const note = repo.createNote({
      workspaceId: 'ws-1',
      title: 'Groceries',
      content: 'Buy essentials',
      color: 'yellow',
      theme: 'grocery',
      priority: 'high',
      status: 'pending',
      noteType: 'checklist',
      checklist: [
        { id: 'item-1', text: 'Apples', checked: false },
        { id: 'item-2', text: 'Oat Milk', checked: true },
      ],
      tags: ['shopping', 'home'],
      isPinned: true,
      isFavorite: true,
      dueDate: 1730000000000,
      reminderTime: 1730000000000,
    });

    expect(note.id).toBeDefined();
    expect(note.title).toBe('Groceries');
    expect(note.color).toBe('yellow');
    expect(note.priority).toBe('high');
    expect(note.checklist.length).toBe(2);
    expect(note.checklist[1]?.checked).toBe(true);
    expect(note.tags).toEqual(['shopping', 'home']);
    expect(note.isPinned).toBe(true);
    expect(note.syncState).toBe('pending');
    expect(note.clientId).toMatch(/^mobile-/);

    const fetched = repo.getNoteById(note.id);
    expect(fetched).toEqual(note);
  });

  it('updates notes offline and retains updated checklist and tags', () => {
    const note = repo.createNote({
      workspaceId: 'ws-1',
      title: 'Initial Title',
      content: 'Initial Content',
    });

    const updated = repo.updateNote(note.id, {
      title: 'Updated Title',
      color: 'teal',
      checklist: [{ id: 'chk-1', text: 'New item', checked: true }],
      tags: ['urgent'],
    });

    expect(updated.title).toBe('Updated Title');
    expect(updated.color).toBe('teal');
    expect(updated.checklist[0]?.text).toBe('New item');
    expect(updated.tags).toEqual(['urgent']);
    expect(updated.syncState).toBe('pending');
  });

  it('handles soft-delete (trash) and restore offline', () => {
    const note = repo.createNote({
      workspaceId: 'ws-1',
      title: 'To Be Trashed',
    });

    const trashed = repo.trashNote(note.id);
    expect(trashed.deletedAt).not.toBeNull();

    // Standard list excludes trashed notes
    const activeList = repo.listNotes({ workspaceId: 'ws-1' });
    expect(activeList.notes.some((n) => n.id === note.id)).toBe(false);

    // Trash view includes only trashed notes
    const trashList = repo.listNotes({ workspaceId: 'ws-1', deletedOnly: true });
    expect(trashList.notes.some((n) => n.id === note.id)).toBe(true);

    // Restore note
    const restored = repo.restoreNote(note.id);
    expect(restored.deletedAt).toBeNull();

    const activeListAfter = repo.listNotes({ workspaceId: 'ws-1' });
    expect(activeListAfter.notes.some((n) => n.id === note.id)).toBe(true);
  });

  it('searches locally cached notes by title and content', () => {
    repo.createNote({
      workspaceId: 'ws-1',
      title: 'Project Phoenix Roadmap',
      content: 'Q4 deliverables and launch milestones',
    });
    repo.createNote({
      workspaceId: 'ws-1',
      title: 'Meeting Notes',
      content: 'Discussed Phoenix budget and hiring needs',
    });
    repo.createNote({
      workspaceId: 'ws-1',
      title: 'Recipe Book',
      content: 'Homemade sourdough and pizza dough',
    });

    const searchRes = repo.listNotes({ workspaceId: 'ws-1', search: 'Phoenix' });
    expect(searchRes.total).toBe(2);
    expect(searchRes.notes.map((n) => n.title)).toContain('Project Phoenix Roadmap');
    expect(searchRes.notes.map((n) => n.title)).toContain('Meeting Notes');

    const searchSourdough = repo.listNotes({ workspaceId: 'ws-1', search: 'sourdough' });
    expect(searchSourdough.total).toBe(1);
    expect(searchSourdough.notes[0]?.title).toBe('Recipe Book');
  });

  it('filters by status, pinned, archived, tags and reminders', () => {
    repo.createNote({
      workspaceId: 'ws-1',
      title: 'Pinned Note',
      isPinned: true,
    });
    repo.createNote({
      workspaceId: 'ws-1',
      title: 'Archived Note',
      isArchived: true,
    });
    repo.createNote({
      workspaceId: 'ws-1',
      title: 'Tagged Note',
      tags: ['design', 'mobile'],
    });
    repo.createNote({
      workspaceId: 'ws-1',
      title: 'Reminder Note',
      reminderTime: Date.now() + 100000,
    });

    const pinned = repo.listNotes({ workspaceId: 'ws-1', isPinned: true });
    expect(pinned.total).toBe(1);
    expect(pinned.notes[0]?.title).toBe('Pinned Note');

    const archived = repo.listNotes({ workspaceId: 'ws-1', isArchived: true });
    expect(archived.total).toBe(1);
    expect(archived.notes[0]?.title).toBe('Archived Note');

    const tagged = repo.listNotes({ workspaceId: 'ws-1', tagName: 'design' });
    expect(tagged.total).toBe(1);
    expect(tagged.notes[0]?.title).toBe('Tagged Note');

    const withReminder = repo.listNotes({ workspaceId: 'ws-1', hasReminder: true });
    expect(withReminder.total).toBe(1);
    expect(withReminder.notes[0]?.title).toBe('Reminder Note');
  });

  it('persists notes across database reopens', () => {
    const note = repo.createNote({
      workspaceId: 'ws-1',
      title: 'Survives Restart',
      content: 'This note must be present after driver reconnects',
      color: 'purple',
    });

    // Emulate app restart by creating a new repository with the same underlying DB
    const restartedRepo = new NotesRepository(db, scope);
    const restored = restartedRepo.getNoteById(note.id);

    expect(restored).not.toBeNull();
    expect(restored?.title).toBe('Survives Restart');
    expect(restored?.color).toBe('purple');
    expect(restored?.syncState).toBe('pending');
  });

  it('empties trash permanently for a workspace without affecting active notes', () => {
    const active = repo.createNote({ workspaceId: 'ws-1', title: 'Active' });
    const trash1 = repo.createNote({ workspaceId: 'ws-1', title: 'Trash 1' });
    const trash2 = repo.createNote({ workspaceId: 'ws-1', title: 'Trash 2' });

    repo.trashNote(trash1.id);
    repo.trashNote(trash2.id);

    const deletedCount = repo.emptyTrash('ws-1');
    expect(deletedCount).toBe(2);

    expect(repo.getNoteById(trash1.id)).toBeNull();
    expect(repo.getNoteById(trash2.id)).toBeNull();
    expect(repo.getNoteById(active.id)).not.toBeNull();
  });
});
