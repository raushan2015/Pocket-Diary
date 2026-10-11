/**
 * Google Keep Card Drag-and-Drop Manual Ordering
 * Reorders cards in memory and persists sort_order to backend atomically
 */

import { api } from './api.js';
import { state } from './state.js';

export function setupCardDragAndDrop(container, memos, onReorderSuccess = null) {
  const cards = container.querySelectorAll('.memo-card[draggable="true"]');
  let draggedCard = null;
  let draggedId = null;

  cards.forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      draggedCard = card;
      draggedId = card.getAttribute('data-memo-id');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedId);
      card.classList.add('is-dragging');
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      cards.forEach((c) => c.classList.remove('drag-over'));
      draggedCard = null;
      draggedId = null;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (card !== draggedCard) {
        card.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const targetId = card.getAttribute('data-memo-id');
      if (!draggedId || !targetId || draggedId === targetId) return;

      const fromIndex = memos.findIndex((m) => m.id === draggedId);
      const toIndex = memos.findIndex((m) => m.id === targetId);
      if (fromIndex === -1 || toIndex === -1) return;

      // Reorder locally
      const [moved] = memos.splice(fromIndex, 1);
      memos.splice(toIndex, 0, moved);

      // Persist to backend atomically
      const activeWs = state.get('activeWorkspace');
      if (activeWs?.id) {
        const orderedIds = memos.map((m) => m.id);
        try {
          await api.reorderMemos(activeWs.id, orderedIds);
        } catch (err) {
          console.error('Reorder error:', err);
        }
      }

      if (typeof onReorderSuccess === 'function') {
        onReorderSuccess(memos);
      }
    });
  });
}
