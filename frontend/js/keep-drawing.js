/**
 * Google Keep Drawing Pad Modal Controller
 * Freehand drawing on HTML5 Canvas with Pen Size, Color, Undo, Clear, and Image Export
 */

import { openModal, closeModal, canvasToBlob } from './utils.js';

let drawingTarget = 'modal'; // 'modal' | 'quick-capture'
let drawingCanvas = null;
let drawingCtx = null;
let drawingHistory = [];
let isDrawingOnCanvas = false;
let lastDrawX = 0;
let lastDrawY = 0;
let onInsertDrawingCallback = null;

export function setupKeepDrawingModal(callbacks = {}) {
  drawingCanvas = document.getElementById('keep-drawing-canvas');
  if (!drawingCanvas) return;
  drawingCtx = drawingCanvas.getContext('2d');
  onInsertDrawingCallback = callbacks.onInsert;

  function getCanvasCoords(e) {
    const rect = drawingCanvas.getBoundingClientRect();
    const scaleX = drawingCanvas.width / rect.width;
    const scaleY = drawingCanvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  function startDraw(e) {
    e.preventDefault();
    isDrawingOnCanvas = true;
    const coords = getCanvasCoords(e);
    lastDrawX = coords.x;
    lastDrawY = coords.y;
    saveDrawingState();
  }

  function moveDraw(e) {
    if (!isDrawingOnCanvas || !drawingCtx) return;
    e.preventDefault();
    const coords = getCanvasCoords(e);
    const color = document.getElementById('keep-draw-color')?.value || '#000000';
    const width = document.getElementById('keep-draw-width')?.value || 4;

    drawingCtx.strokeStyle = color;
    drawingCtx.lineWidth = Number(width);
    drawingCtx.lineCap = 'round';
    drawingCtx.lineJoin = 'round';

    drawingCtx.beginPath();
    drawingCtx.moveTo(lastDrawX, lastDrawY);
    drawingCtx.lineTo(coords.x, coords.y);
    drawingCtx.stroke();

    lastDrawX = coords.x;
    lastDrawY = coords.y;
  }

  function endDraw() {
    isDrawingOnCanvas = false;
  }

  function saveDrawingState() {
    if (!drawingCtx || !drawingCanvas) return;
    drawingHistory.push(drawingCtx.getImageData(0, 0, drawingCanvas.width, drawingCanvas.height));
    if (drawingHistory.length > 20) drawingHistory.shift();
  }

  drawingCanvas.addEventListener('mousedown', startDraw);
  drawingCanvas.addEventListener('mousemove', moveDraw);
  drawingCanvas.addEventListener('mouseup', endDraw);
  drawingCanvas.addEventListener('mouseleave', endDraw);

  drawingCanvas.addEventListener('touchstart', startDraw, { passive: false });
  drawingCanvas.addEventListener('touchmove', moveDraw, { passive: false });
  drawingCanvas.addEventListener('touchend', endDraw);

  document.getElementById('keep-draw-undo')?.addEventListener('click', () => {
    if (drawingHistory.length > 0 && drawingCtx) {
      const prev = drawingHistory.pop();
      drawingCtx.putImageData(prev, 0, 0);
    }
  });

  document.getElementById('keep-draw-clear')?.addEventListener('click', () => {
    if (drawingCtx && drawingCanvas) {
      saveDrawingState();
      drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    }
  });

  const closeDrawing = () => closeModal('modal-keep-drawing');
  document.getElementById('keep-draw-close-btn')?.addEventListener('click', closeDrawing);
  document.getElementById('keep-draw-cancel-btn')?.addEventListener('click', closeDrawing);

  document.getElementById('keep-draw-save-btn')?.addEventListener('click', async () => {
    if (!drawingCanvas) return;
    try {
      const blob = await canvasToBlob(drawingCanvas, 'image/png');
      const file = new File([blob], `drawing_${Date.now()}.png`, { type: 'image/png' });

      if (typeof onInsertDrawingCallback === 'function') {
        await onInsertDrawingCallback(file, drawingTarget);
      }
    } catch (err) {
      console.error('Failed to export drawing:', err);
    }

    closeDrawing();
  });
}

export function openKeepDrawingModal(target = 'modal') {
  drawingTarget = target;
  drawingHistory = [];
  if (drawingCtx && drawingCanvas) {
    drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  }
  openModal('modal-keep-drawing');
}
