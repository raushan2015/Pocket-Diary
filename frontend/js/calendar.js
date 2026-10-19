/**
 * Interactive Calendar Widget Controller
 * Due-date markers, month navigation, and date-based filtering
 */

import { state } from './state.js';

export let currentCalYear = new Date().getFullYear();
export let currentCalMonth = new Date().getMonth();

export function setCalYear(y) { currentCalYear = y; }
export function setCalMonth(m) { currentCalMonth = m; }

export function renderInteractiveCalendar(year = currentCalYear, month = currentCalMonth, onSelectDate = null) {
  const titleEl = document.getElementById('calendar-month-title');
  const grid = document.querySelector('.calendar-grid') || document.querySelector('.calendar-days-grid');
  if (!grid) return;

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (titleEl) {
    titleEl.textContent = `${monthNames[month]} ${year}`;
  }

  const staticHeaders = Array.from(grid.querySelectorAll('.calendar-day-name, .calendar-day-header'));
  grid.replaceChildren(...staticHeaders);

  const allMemos = state.get('allWorkspaceMemos') || [];
  const activeMemos = allMemos.filter((memo) => !memo.deletedAt);
  const dueByDay = new Map();

  for (const memo of activeMemos) {
    const time = memo.reminderTime || memo.dueDate;
    if (!time) continue;
    const due = new Date(time);
    const key = `${due.getFullYear()}-${due.getMonth()}-${due.getDate()}`;
    dueByDay.set(key, (dueByDay.get(key) || 0) + 1);
  }

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayEl = document.createElement('div');
    dayEl.className = 'calendar-day-num other-month';
    dayEl.textContent = daysInPrevMonth - i;
    dayEl.setAttribute('aria-hidden', 'true');
    grid.appendChild(dayEl);
  }

  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    const dayEl = document.createElement('button');
    dayEl.type = 'button';
    dayEl.className = 'calendar-day-num';
    dayEl.textContent = day;
    dayEl.setAttribute('aria-label', `${monthNames[month]} ${day}, ${year}`);
    if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) dayEl.classList.add('today');
    const key = `${year}-${month}-${day}`;
    const dueCount = dueByDay.get(key) || 0;
    if (dueCount) {
      dayEl.classList.add('has-due-memos');
      dayEl.title = `${dueCount} memo${dueCount === 1 ? '' : 's'} due`;
      dayEl.dataset.dueCount = String(dueCount);
    }
    dayEl.addEventListener('click', () => {
      grid.querySelectorAll('.calendar-day-num').forEach((el) => el.classList.remove('active'));
      dayEl.classList.add('active');
      const start = new Date(year, month, day).getTime();
      const end = new Date(year, month, day + 1).getTime();
      if (typeof onSelectDate === 'function') {
        onSelectDate({ start, end, label: `${monthNames[month]} ${day}, ${year}` });
      }
    });
    grid.appendChild(dayEl);
  }
  const trailing = (7 - ((firstDay + daysInMonth) % 7)) % 7;
  for (let day = 1; day <= trailing; day++) {
    const dayEl = document.createElement('div');
    dayEl.className = 'calendar-day-num other-month';
    dayEl.textContent = day;
    dayEl.setAttribute('aria-hidden', 'true');
    grid.appendChild(dayEl);
  }
}
