export function bindDatePicker({ trigger, panel, years, months, getMonth, getLastMonth, onSelect, firstMonth }) {
  let selectedYear;

  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-controls', panel.id);
  trigger.setAttribute('aria-expanded', 'false');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '조회 연월 선택');
  years.setAttribute('role', 'group');
  years.setAttribute('aria-label', '연도');
  months.setAttribute('role', 'group');
  months.setAttribute('aria-label', '월');

  function option(text, label, selected) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-option';
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(selected));
    return button;
  }

  function yearButton(year) {
    return years.querySelector(`[data-year="${year}"]`);
  }

  function focusYear(button) {
    button.focus({ preventScroll: true });
    const bounds = button.getBoundingClientRect();
    const list = years.getBoundingClientRect();
    if (bounds.top < list.top) years.scrollTop -= list.top - bounds.top;
    else if (bounds.bottom > list.bottom) years.scrollTop += bounds.bottom - list.bottom;
  }

  function close(restoreFocus = false) {
    panel.hidden = true;
    months.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function fitPanel() {
    const space = Math.max(0, window.innerHeight - trigger.getBoundingClientRect().bottom - 16);
    panel.style.setProperty('--date-picker-space', `${space}px`);
    panel.classList.toggle('is-compact-months', space < 340);
  }

  function open() {
    const currentYear = Number(getMonth().slice(0, 4));
    const lastYear = Math.max(2026, Number(getLastMonth().slice(0, 4)));
    const buttons = [];
    selectedYear = currentYear;
    for (let year = Number(firstMonth.slice(0, 4)); year <= lastYear; year += 1) {
      const button = option(`${year}년`, `${year}년`, year === currentYear);
      button.classList.add('date-year');
      button.dataset.year = year;
      button.setAttribute('aria-controls', months.id);
      button.setAttribute('aria-expanded', 'false');
      buttons.push(button);
    }
    years.replaceChildren(...buttons);
    months.replaceChildren();
    months.hidden = true;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    fitPanel();
    const current = yearButton(currentYear);
    current.focus({ preventScroll: true });
    const bounds = current.getBoundingClientRect();
    const list = years.getBoundingClientRect();
    years.scrollTop += bounds.top - list.top - years.clientHeight / 2 + bounds.height / 2;
  }

  function showMonths(year) {
    selectedYear = Number(year);
    for (const button of years.querySelectorAll('[data-year]')) {
      const selected = Number(button.dataset.year) === selectedYear;
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-expanded', String(selected));
    }
    const currentMonth = getMonth();
    const lastMonth = getLastMonth();
    const buttons = [];
    for (let month = 1; month <= 12; month += 1) {
      const value = `${selectedYear}-${String(month).padStart(2, '0')}`;
      if (value < firstMonth || value > lastMonth) continue;
      const button = option(`${month}월`, `${month}월`, value === currentMonth);
      button.classList.add('date-month');
      button.dataset.month = value;
      buttons.push(button);
    }
    months.replaceChildren(...buttons);
    months.hidden = false;
  }

  function focusMonth() {
    const button = months.querySelector('[aria-pressed="true"]') ?? months.querySelector('button');
    button?.focus({ preventScroll: true });
  }

  function navigateList(event, list) {
    const buttons = [...list.querySelectorAll('button')];
    const index = buttons.indexOf(event.target);
    if (index === -1) return;
    let next;
    if (event.key === 'ArrowUp') next = buttons[Math.max(0, index - 1)];
    else if (event.key === 'ArrowDown') next = buttons[Math.min(buttons.length - 1, index + 1)];
    else if (event.key === 'Home') next = buttons[0];
    else if (event.key === 'End') next = buttons.at(-1);
    if (!next) return;
    event.preventDefault();
    if (list === years) focusYear(next);
    else next.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', () => {
    if (panel.hidden) open();
    else close(true);
  });
  years.addEventListener('click', (event) => {
    const button = event.target.closest('[data-year]');
    if (!button) return;
    showMonths(button.dataset.year);
    focusMonth();
  });
  months.addEventListener('click', (event) => {
    const button = event.target.closest('[data-month]');
    if (!button) return;
    const month = button.dataset.month;
    if (month < firstMonth || month > getLastMonth()) return;
    onSelect(month);
    close(true);
  });
  years.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' && event.target.dataset.year) {
      event.preventDefault();
      showMonths(event.target.dataset.year);
      focusMonth();
    } else navigateList(event, years);
  });
  months.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusYear(yearButton(selectedYear));
    } else navigateList(event, months);
  });
  document.addEventListener('keydown', (event) => {
    if (panel.hidden || event.key !== 'Escape') return;
    event.preventDefault();
    close(true);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener('focusin', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  });
  window.addEventListener('resize', () => {
    if (!panel.hidden) fitPanel();
  });

  return { close: () => close() };
}
