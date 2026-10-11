/**
 * Google Keep Image Lightbox Modal Controller
 * High-resolution fullscreen image viewer with download, delete, and keyboard navigation
 */

import { api } from './api.js';
import { openModal, closeModal, showToast } from './utils.js';

let activeAttachment = null;
let activeMemo = null;
let onAttachmentDeletedCallback = null;

export function setupKeepLightbox(callbacks = {}) {
  onAttachmentDeletedCallback = callbacks.onDeleted;

  const modal = document.getElementById('modal-keep-lightbox');
  const closeBtn = document.getElementById('keep-lightbox-close-btn');
  const downloadBtn = document.getElementById('keep-lightbox-download-btn');
  const deleteBtn = document.getElementById('keep-lightbox-delete-btn');

  if (!modal) return;

  const closeLightbox = () => {
    closeModal('modal-keep-lightbox');
    activeAttachment = null;
    activeMemo = null;
  };

  closeBtn?.addEventListener('click', closeLightbox);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeLightbox();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) {
      closeLightbox();
    }
  });

  downloadBtn?.addEventListener('click', () => {
    if (!activeAttachment) return;
    const a = document.createElement('a');
    a.href = activeAttachment.url || activeAttachment.filePath;
    a.download = activeAttachment.fileName || activeAttachment.name || 'image.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  deleteBtn?.addEventListener('click', async () => {
    if (!activeAttachment) return;
    const attId = activeAttachment.id;
    if (attId && !attId.startsWith('temp_')) {
      try {
        await api.deleteAttachment(attId);
        showToast('Attachment deleted', 'info', 1800);
      } catch (err) {
        showToast(err.message || 'Failed to delete attachment', 'error');
        return;
      }
    }

    if (activeMemo && Array.isArray(activeMemo.attachments)) {
      activeMemo.attachments = activeMemo.attachments.filter((a) => a.id !== attId);
    }

    if (typeof onAttachmentDeletedCallback === 'function') {
      onAttachmentDeletedCallback(activeAttachment, activeMemo);
    }

    closeLightbox();
  });
}

export function openLightbox(attachment, memo = null) {
  activeAttachment = attachment;
  activeMemo = memo;

  const modal = document.getElementById('modal-keep-lightbox');
  const imgEl = document.getElementById('keep-lightbox-image');
  const titleEl = document.getElementById('keep-lightbox-title');

  if (!modal || !imgEl) return;

  const url = attachment.url || attachment.filePath;
  imgEl.src = url;
  if (titleEl) {
    titleEl.textContent = attachment.fileName || attachment.name || 'Image';
  }

  openModal('modal-keep-lightbox');
}
