import { formatMonth } from './market.js';

const fieldLabels = { title: '제목', month: '연월', answer: '정답' };
const iconPaths = {
  edit: 'm16 3 5 5-12 12-6 1 1-6Z m-1.5 1.5 5 5',
  save: 'M3 3h14l4 4v14H3Z M7 3v6h10V3 M7 21v-8h10v8',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(kind, label) {
  const button = element('button', `bet-${kind}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', iconPaths[kind]);
  svg.append(path);
  button.append(svg);
  return button;
}

export function bindBettingEditor({ list, onSave, onDelete, onError }) {
  let records = [];
  let active;

  function getRecord(id) {
    return records.find((record) => record.id === id);
  }

  function fieldName(record, field, action) {
    return `${record.title || '제목 없음'} ${fieldLabels[field]} ${action}`;
  }

  function displayField(row, record, field) {
    const text = {
      title: record.title,
      month: record.month ? formatMonth(record.month) : '연월 미지정',
      answer: `정답: ${record.answer}`,
    }[field];
    const content = element(field === 'title' ? 'h2' : 'p', 'bet-text', text);
    const edit = iconButton('edit', fieldName(record, field, '수정'));
    edit.addEventListener('click', () => startEdit(row, record.id, field));
    row.classList.remove('bet-editing');
    row.removeAttribute('aria-busy');
    row.replaceChildren(content, edit);
    return edit;
  }

  function cancel(restoreFocus = false) {
    if (!active || active.saving) return;
    const session = active;
    active = undefined;
    const record = getRecord(session.id);
    if (!record || !session.row.isConnected) return;
    const edit = displayField(session.row, record, session.field);
    if (restoreFocus) edit.focus({ preventScroll: true });
  }

  async function save(session) {
    if (active !== session || session.saving) return;
    session.saving = true;
    session.input.readOnly = true;
    session.button.disabled = true;
    session.row.setAttribute('aria-busy', 'true');
    session.input.removeAttribute('aria-invalid');

    try {
      const saved = await onSave(session.id, session.field, session.input.value.trim());
      records = records.map((record) => record.id === saved.id ? saved : record);
      const restoreFocus = active === session && session.row.contains(document.activeElement);
      if (active === session) active = undefined;
      const entry = list.querySelector(`[data-bet-id="${CSS.escape(saved.id)}"]`);
      if (!entry) return;

      for (const row of entry.querySelectorAll('.bet-field')) {
        const field = row.dataset.field;
        if (row === active?.row) {
          active.input.setAttribute('aria-label', fieldName(saved, field, '입력'));
          const label = fieldName(saved, field, '저장');
          active.button.setAttribute('aria-label', label);
          active.button.title = label;
        } else displayField(row, saved, field);
      }
      entry.querySelector('.bet-delete').setAttribute('aria-label', `${saved.title || '제목 없음'} 삭제`);
      if (restoreFocus) {
        entry.querySelector(`[data-field="${session.field}"] .bet-edit`)
          ?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (active === session) session.input.setAttribute('aria-invalid', 'true');
      onError(error);
    } finally {
      session.saving = false;
      session.input.readOnly = false;
      session.button.disabled = false;
      session.row.removeAttribute('aria-busy');
    }
  }

  function startEdit(row, id, field) {
    if (active?.saving) return;
    cancel();
    const record = getRecord(id);
    if (!record) return;

    const input = element('input', 'bet-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = field === 'month' ? 'YYYY-MM' : fieldLabels[field];
    input.setAttribute('aria-label', fieldName(record, field, '입력'));
    const button = iconButton('save', fieldName(record, field, '저장'));
    const session = { id, field, row, input, button, saving: false };

    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', () => save(session));
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        save(session);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel(true);
      }
    });
    row.classList.add('bet-editing');
    row.replaceChildren(input, button);
    active = session;
    input.focus();
  }

  function createEntry(record) {
    const entry = element('article', 'bet-entry');
    entry.dataset.betId = record.id;
    const content = element('div', 'bet-content');
    const heading = element('div', 'bet-heading');
    content.append(heading);
    for (const field of ['title', 'month', 'answer']) {
      const row = element('div', `bet-field bet-${field}`);
      row.dataset.field = field;
      displayField(row, record, field);
      (field === 'answer' ? content : heading).append(row);
    }
    const remove = element('button', 'bet-delete', '삭제');
    remove.type = 'button';
    remove.setAttribute('aria-label', `${record.title || '제목 없음'} 삭제`);
    remove.addEventListener('click', () => {
      const current = getRecord(record.id);
      if (current) onDelete(current);
    });
    entry.append(content, remove);
    return entry;
  }

  function draw() {
    const fragment = document.createDocumentFragment();
    for (const record of records) {
      fragment.append(createEntry(record), element('hr', 'bet-separator'));
    }
    list.replaceChildren(fragment);
  }

  document.addEventListener('pointerdown', (event) => {
    if (active && event.target !== active.input && !active.button.contains(event.target)) cancel();
  });
  document.addEventListener('focusin', (event) => {
    if (active && !active.row.contains(event.target)) cancel();
  });

  return {
    render(bets) {
      active = undefined;
      records = bets.map((record) => ({ ...record }));
      draw();
    },
    cancel: () => cancel(),
  };
}
