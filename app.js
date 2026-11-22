import {
  FIRST_BET_MONTH, FIRST_MONTH, INITIAL_LAST_MONTH, LAST_ISSUED_SHARES_MONTH, isValidMonth, shiftMonth, listMonths,
  formatMonth, formatPrice, formatRate, rateTone, buildMarketView,
} from './market.js';
import {
  openDatabase, readSnapshot, addStock, renameStock, deleteStock, savePrice, saveIssuedShares,
  addBet, saveBetField, deleteBet, replaceSnapshot, serializeBackup, parseBackup,
} from './storage.js';
import { bindEditorColumnDrag } from './editor-column-drag.js';
import { bindDatePicker } from './date-picker.js';
import { bindBettingEditor } from './betting-editor.js';

const $ = (id) => document.getElementById(id);
const byName = new Intl.Collator('ko-KR');
const projectPath = new URL('./', location.href).pathname;
const preferencesKey = `onlyMePriceLimit:preferences:${projectPath}`;
const editorSelectionKey = `onlyMePriceLimit:editor-selection:${projectPath}`;
const preferences = readPreference(preferencesKey) ?? {};
let currentMonth = isValidMonth(preferences.month, FIRST_BET_MONTH) ? preferences.month : FIRST_MONTH;
let lastMonth = INITIAL_LAST_MONTH;
let viewType = preferences.view === 'table' ? 'table' : 'cards';
let sortMode = ['name', 'desc', 'asc'].includes(preferences.sort) ? preferences.sort : 'desc';
let activePage = 'view';
let database;
let stocks = [];
let bets = [];
let pricesByStock = new Map();
const selected = new Set(readEditorSelection());
const gridDrafts = { price: new Map(), shares: new Map() };
let editorMode = 'price';
let gridSignature;
let pendingWrite = Promise.resolve();
let tabUpdates;
let datePicker;
let bettingEditor;
let backupToastTimer;

function readPreference(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writePreference(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Price storage is independent of browser preferences.
  }
}

function savePreferences() {
  writePreference(preferencesKey, { month: currentMonth, view: viewType, sort: sortMode });
}

function readEditorSelection() {
  const saved = readPreference(editorSelectionKey);
  return Array.isArray(saved) ? saved : [];
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(className, content, label) {
  const node = element('button', className, content);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  return node;
}

function setStatus(id, message = '', isError = false) {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle('status-error', isError);
  node.classList.toggle('status-success', Boolean(message) && !isError);
}

function errorMessage(error, fallback) {
  return error instanceof Error && !(error instanceof DOMException) ? error.message : fallback;
}

function firstQueryMonth() {
  return bets.reduce((first, { month }) => month && month < first ? month : first, FIRST_MONTH);
}

function lastQueryMonth() {
  return bets.reduce((last, { month }) => month && month > last ? month : last, lastMonth);
}

function clampQueryMonth() {
  if (currentMonth < firstQueryMonth()) currentMonth = firstQueryMonth();
  if (currentMonth > lastQueryMonth()) currentMonth = lastQueryMonth();
}

function useSnapshot(snapshot) {
  stocks = snapshot.stocks;
  bets = snapshot.bets ?? [];
  pricesByStock = new Map(stocks.map(({ id }) => [id, new Map()]));
  lastMonth = INITIAL_LAST_MONTH;
  for (const { stockId, month, price } of snapshot.prices) {
    pricesByStock.get(stockId).set(month, price);
    if (month > lastMonth) lastMonth = month;
  }
  clampQueryMonth();

  for (const id of selected) {
    if (!pricesByStock.has(id)) {
      selected.delete(id);
    }
  }
  for (const drafts of Object.values(gridDrafts)) {
    for (const id of drafts.keys()) {
      if (!pricesByStock.has(id)) drafts.delete(id);
    }
  }
  const savedSelection = readEditorSelection();
  const availableSelection = savedSelection.filter((id) => pricesByStock.has(id));
  if (availableSelection.length !== savedSelection.length) {
    writePreference(editorSelectionKey, availableSelection);
  }
}

function viewSnapshot() {
  const nextMonth = shiftMonth(currentMonth, 1, FIRST_BET_MONTH);
  const prices = [];
  for (const { id } of stocks) {
    const monthlyPrices = pricesByStock.get(id);
    for (const month of [currentMonth, nextMonth]) {
      if (monthlyPrices.has(month)) prices.push({ stockId: id, month, price: monthlyPrices.get(month) });
    }
  }
  return { stocks, prices };
}

function rateElement(tag, className, rate) {
  return element(tag, `${className} tone-${rateTone(rate)}`, formatRate(rate));
}

function formatPriceChange(currentPrice, nextPrice) {
  return `${formatPrice(currentPrice)} → ${formatPrice(nextPrice)}`;
}

function renderLeader({ name, currentPrice, nextPrice, rate }) {
  const card = element('article', 'leader-card');
  card.append(
    element('h3', 'leader-name', name),
    element('p', 'leader-prices', formatPriceChange(currentPrice, nextPrice)),
    rateElement('strong', 'leader-rate', rate),
  );
  return card;
}

function renderCard({ name, currentPrice, nextPrice, rate }) {
  const card = element('article', 'stock-card');
  const summary = element('p', 'stock-card-summary');
  const rateText = rateElement('strong', 'stock-card-rate', rate);
  rateText.textContent = `(${rateText.textContent})`;
  summary.append(element('span', 'stock-card-prices', formatPriceChange(currentPrice, nextPrice)), ' ', rateText);
  card.append(element('h3', 'stock-card-name', name), summary);
  return card;
}

function renderTableRow({ name, currentPrice, nextPrice, rate }) {
  const row = element('tr');
  const nameCell = element('th', '', name);
  nameCell.scope = 'row';
  row.append(nameCell, element('td', '', formatPrice(currentPrice)),
    element('td', '', formatPrice(nextPrice)), rateElement('td', '', rate));
  return row;
}

function renderMonthlyBets() {
  const region = $('monthly-bets');
  const entries = bets.filter(({ month }) => month === currentMonth).map(({ title, answer }) => {
    const entry = element('article');
    entry.append(element('h2', '', title), element('p', '', answer));
    return entry;
  });
  region.replaceChildren(...entries);
  region.hidden = entries.length === 0;
}

function renderMarket() {
  $('current-month').textContent = formatMonth(currentMonth);
  $('previous-month').disabled = currentMonth === firstQueryMonth();
  $('next-month').disabled = currentMonth === lastQueryMonth();
  renderMonthlyBets();
  $('view-cards').setAttribute('aria-pressed', String(viewType === 'cards'));
  $('view-table').setAttribute('aria-pressed', String(viewType === 'table'));
  $('sort-name').setAttribute('aria-pressed', String(sortMode === 'name'));
  const rateSort = $('sort-rate');
  rateSort.setAttribute('aria-pressed', String(sortMode !== 'name'));
  rateSort.textContent = { name: '상승률 순', desc: '상승률 순 ↓', asc: '상승률 순 ↑' }[sortMode];
  rateSort.setAttribute('aria-label', {
    name: '상승률 순', desc: '상승률 순, 내림차순', asc: '상승률 순, 오름차순',
  }[sortMode]);

  const { rows, leaders } = buildMarketView(viewSnapshot(), currentMonth, sortMode);
  $('leaders').replaceChildren(...leaders.map(renderLeader));
  $('leaders').hidden = leaders.length === 0;
  $('leader-empty').hidden = leaders.length !== 0;
  $('market-empty').hidden = rows.length !== 0;
  $('stock-count').textContent = `${rows.length}개 종목`;
  $('market-cards').hidden = !rows.length || viewType !== 'cards';
  $('market-table').hidden = !rows.length || viewType !== 'table';
  if (viewType === 'cards') {
    $('market-cards').replaceChildren(...rows.map(renderCard));
  } else {
    $('market-rows').replaceChildren(...rows.map(renderTableRow));
  }
}

function selectMonth(month) {
  if (!isValidMonth(month, firstQueryMonth()) || month > lastQueryMonth()) return;
  datePicker.close();
  currentMonth = month;
  savePreferences();
  renderMarket();
}

function moveMonth(amount) {
  const month = shiftMonth(currentMonth, amount, firstQueryMonth());
  if (month) selectMonth(month);
}

function setView(view) {
  viewType = view;
  savePreferences();
  renderMarket();
}

function openPage(page) {
  datePicker.close();
  bettingEditor.cancel();
  activePage = page;
  for (const name of ['view', 'editor', 'bets']) {
    $(name).hidden = page !== name;
    const tab = $(`open-${name}`);
    tab.setAttribute('aria-selected', String(page === name));
    tab.tabIndex = page === name ? 0 : -1;
  }
  if (page === 'view') {
    renderMarket();
  } else if (page === 'editor') {
    renderStockList();
    renderGrid();
    scrollToEditorMonth(currentMonth);
  } else {
    bettingEditor.render(bets);
  }
  $(`open-${page}`).focus();
}

function runWrite(operation) {
  const result = pendingWrite.then(operation);
  pendingWrite = result.catch(() => {});
  return result;
}

function notifyOtherTabs() {
  tabUpdates?.postMessage('changed');
}

function refreshPage() {
  if (activePage === 'view') renderMarket();
  else if (activePage === 'editor') {
    renderStockList();
    renderGrid();
  } else {
    bettingEditor.render(bets);
  }
}

async function registerBet() {
  const add = $('add-bet');
  add.disabled = true;
  setStatus('bet-status');
  try {
    await runWrite(async () => {
      const bet = await addBet(database, { title: '제목', answer: '정답!!' });
      bets.push(bet);
      notifyOtherTabs();
    });
    refreshPage();
  } catch (error) {
    setStatus('bet-status', errorMessage(error, '베팅 기록을 추가하지 못했어요.'), true);
  } finally {
    add.disabled = false;
  }
}

function beginBetDeletion(bet) {
  askConfirmation('베팅 기록을 삭제할까요?', `‘${bet.title || '제목 없음'}’의 제목, 연월, 정답이 함께 삭제돼요.`, '삭제', async () => {
    await runWrite(async () => {
      await deleteBet(database, bet.id);
      useSnapshot(await readSnapshot(database));
      notifyOtherTabs();
    });
    refreshPage();
    setStatus('bet-status', '베팅 기록을 삭제했어요.');
    return $('add-bet');
  });
}

function renderStockList() {
  const query = $('stock-search').value.trim().normalize().toLocaleLowerCase('ko-KR');
  const matching = stocks
    .filter(({ name }) => name.normalize().toLocaleLowerCase('ko-KR').includes(query))
    .sort((a, b) => byName.compare(a.name, b.name));
  const items = matching.map((stock) => {
    const item = element('li', 'stock-list-item');
    const picker = button('stock-picker', stock.name);
    picker.title = stock.name;
    picker.setAttribute('aria-pressed', String(selected.has(stock.id)));
    item.addEventListener('click', ({ target }) => {
      if (target.closest('.stock-list-actions button')) return;
      toggleColumn(stock.id);
      picker.setAttribute('aria-pressed', String(selected.has(stock.id)));
    });
    const rename = button('stock-rename', '이름 변경', `${stock.name} 이름 변경`);
    rename.addEventListener('click', () => beginRename(stock));
    const remove = button('stock-delete', '삭제', `${stock.name} 삭제`);
    remove.addEventListener('click', () => beginStockDeletion(stock));
    const actions = element('div', 'stock-list-actions');
    actions.append(rename, remove);
    item.append(picker, actions);
    return item;
  });
  $('stock-list').replaceChildren(...items);
  $('stock-list-empty').hidden = items.length > 0;
  $('stock-list-empty').textContent = stocks.length ? '검색 결과가 없어요.' : '등록된 종목이 없어요.';
}

function toggleColumn(stockId) {
  const startingColumn = selected.size === 0;
  if (selected.has(stockId)) selected.delete(stockId);
  else selected.add(stockId);
  writePreference(editorSelectionKey, [...selected]);
  renderGrid();
  if (startingColumn) scrollToEditorMonth(currentMonth);
}

function moveEditorColumn(stockId, targetId, after, restoreFocus = false) {
  if (stockId === targetId || !selected.has(stockId) || !selected.has(targetId)) return;

  const order = [...selected];
  const from = order.indexOf(stockId);
  order.splice(from, 1);
  const to = order.indexOf(targetId) + Number(after);
  if (from === to) return;
  order.splice(to, 0, stockId);

  const activeInput = document.activeElement;
  if (activeInput?.matches('#editor-scroller .grid-input')) activeInput.blur();

  selected.clear();
  for (const id of order) selected.add(id);
  writePreference(editorSelectionKey, order);
  renderGrid();

  if (restoreFocus) {
    const header = $('editor-scroller').querySelector(`th[data-stock-id="${CSS.escape(stockId)}"] .editor-column-name`);
    header.focus();
    setStatus('editor-status', `${header.textContent} 열을 ${to + 1}번째로 옮겼어요.`);
  }
}

function formatGridValue(mode, value) {
  if (value == null) return '';
  return mode === 'shares' ? `${value.toLocaleString('ko-KR')}주` : formatPrice(value);
}

function displayGridInput(input, stock, editing = document.activeElement === input) {
  const { mode, month } = input.dataset;
  const shares = mode === 'shares';
  const history = stock.issuedSharesHistory;
  const record = shares ? history.findLast((entry) => entry.month <= month) : undefined;
  const value = shares ? record?.value : pricesByStock.get(stock.id).get(month);
  input.disabled = shares && month !== FIRST_MONTH && history[0]?.month !== FIRST_MONTH;
  input.classList.toggle('is-inherited', Boolean(record && record.month !== month));

  const draft = input.disabled ? undefined : gridDrafts[mode].get(stock.id)?.get(month);
  const focused = editing && !input.disabled;
  const text = draft?.value ?? (focused ? String(value ?? '') : formatGridValue(mode, value));
  if (input.value !== text) {
    input.value = text;
    if (focused) input.select();
  }
  if (draft?.invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function gridCell(stock, month) {
  const cell = element('td');
  const input = element('input', 'grid-input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.dataset.stock = stock.id;
  input.dataset.month = month;
  input.dataset.mode = editorMode;
  const label = editorMode === 'shares' ? '발행 주식 수' : '가격';
  input.setAttribute('aria-label', `${stock.name} ${formatMonth(month)} ${label}`);
  displayGridInput(input, stock);
  cell.append(input);
  return cell;
}

function editorLastMonth() {
  return editorMode === 'shares' ? LAST_ISSUED_SHARES_MONTH : lastMonth;
}

function selectEditorMode(mode) {
  if (mode === editorMode) return;
  const input = $('editor-scroller').querySelector('.grid-input:focus');
  input?.blur();
  editorMode = mode;
  for (const type of ['price', 'shares']) {
    const tab = $(`editor-${type}-tab`);
    tab.setAttribute('aria-selected', String(type === mode));
    tab.tabIndex = type === mode ? 0 : -1;
  }
  $('editor-grid-panel').setAttribute('aria-labelledby', `editor-${mode}-tab`);
  $('editor-shares-hint').hidden = mode !== 'shares';
  setStatus('editor-status');
  renderGrid();
}

function renderGrid() {
  const stocksById = new Map(stocks.map((stock) => [stock.id, stock]));
  const columns = [...selected].map((id) => stocksById.get(id));
  const scroller = $('editor-scroller');
  $('reset-editor-selection').disabled = columns.length === 0;
  scroller.hidden = columns.length === 0;
  $('editor-empty').hidden = columns.length !== 0;
  const signature = JSON.stringify([editorMode, editorLastMonth(), columns.map(({ id, name }) => [id, name])]);
  if (signature === gridSignature) return;
  gridSignature = signature;
  if (!columns.length) {
    scroller.replaceChildren();
    return;
  }

  const oldTop = scroller.scrollTop;
  const oldLeft = scroller.scrollLeft;
  const table = element('table', 'price-grid');
  table.style.setProperty('--stock-column-count', String(columns.length));
  const label = editorMode === 'shares' ? '종목별 월간 발행 주식 수 편집' : '종목별 월간 주가 편집';
  table.setAttribute('aria-label', label);
  scroller.setAttribute('aria-label', label);
  const heading = table.createTHead().insertRow();
  const monthHeading = element('th', 'month-cell', '연월');
  monthHeading.scope = 'col';
  heading.append(monthHeading);
  for (const { id, name } of columns) {
    const th = element('th');
    th.scope = 'col';
    th.dataset.stockId = id;
    const columnHeader = element('div', 'editor-column');
    const close = button('remove-column', '×', `${name} 편집 열 닫기`);
    close.addEventListener('click', () => {
      toggleColumn(id);
      renderStockList();
      $('stock-search').focus();
    });
    const columnName = button('editor-column-name', undefined, `${name} 편집 열 이동`);
    columnName.append(element('span', 'editor-column-label', name));
    columnName.title = name;
    columnName.draggable = true;
    columnName.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight');
    columnName.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const after = event.key === 'ArrowRight';
      const neighbor = after ? th.nextElementSibling : th.previousElementSibling;
      if (!neighbor?.dataset.stockId) return;
      event.preventDefault();
      moveEditorColumn(id, neighbor.dataset.stockId, after, true);
    });
    columnHeader.append(columnName, close);
    th.append(columnHeader);
    heading.append(th);
  }
  bindEditorColumnDrag(heading, scroller, moveEditorColumn);
  const body = table.createTBody();
  for (const month of listMonths(editorLastMonth())) {
    const row = body.insertRow();
    row.dataset.month = month;
    const monthCell = element('th', 'month-cell', month);
    monthCell.scope = 'row';
    row.append(monthCell);
    for (const stock of columns) row.append(gridCell(stock, month));
  }
  scroller.replaceChildren(table);
  scroller.scrollTop = oldTop;
  scroller.scrollLeft = oldLeft;
}

function scrollToEditorMonth(month) {
  const scroller = $('editor-scroller');
  const end = editorLastMonth();
  const targetMonth = month < FIRST_MONTH ? FIRST_MONTH : month > end ? end : month;
  const row = scroller.querySelector(`tr[data-month="${targetMonth}"]`);
  if (!row) return;
  const headerHeight = scroller.querySelector('thead').getBoundingClientRect().height;
  scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - headerHeight;
}

function parseGridValue(mode, value) {
  const text = value.trim();
  if (!text) return null;
  const shares = mode === 'shares';
  const amount = text.replace(shares ? /\s*주$/ : /\s*원$/, '');
  const number = Number(amount.replaceAll(',', ''));
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/.test(amount) || !Number.isSafeInteger(number)) {
    throw new Error(`${shares ? '발행 주식 수는' : '가격은'} 0 이상의 정수로 입력해 주세요.`);
  }
  return number;
}

function advanceGridInput(input) {
  if (document.activeElement !== input) return;
  const cell = input.closest('td');
  const nextInput = cell.parentElement.nextElementSibling?.cells[cell.cellIndex]?.firstElementChild;
  nextInput?.focus();
}

async function commitGridInput(input, advance = false) {
  if (input.readOnly || input.disabled) return;
  const { mode, stock: stockId, month } = input.dataset;
  const drafts = gridDrafts[mode];
  const shares = mode === 'shares';
  const draft = drafts.get(stockId)?.get(month);
  if (!draft) {
    if (advance) advanceGridInput(input);
    return;
  }
  input.readOnly = true;
  try {
    const value = parseGridValue(mode, draft.value);
    let removedShareRecord = false;
    await runWrite(async () => {
      if (shares) {
        const stock = stocks.find(({ id }) => id === stockId);
        removedShareRecord = value === null && stock?.issuedSharesHistory.some((record) => record.month === month);
        const saved = await saveIssuedShares(database, stockId, month, value);
        stocks = stocks.map((stock) => stock.id === stockId ? saved : stock);
      } else {
        await savePrice(database, stockId, month, value);
        const prices = pricesByStock.get(stockId);
        if (value === null) prices.delete(month);
        else prices.set(month, value);
      }
      if (drafts.get(stockId)?.get(month) === draft) drafts.get(stockId)?.delete(month);
      notifyOtherTabs();
    });
    const stock = stocks.find(({ id }) => id === stockId);
    if (editorMode === mode && stock) {
      const column = `.grid-input[data-stock="${CSS.escape(stockId)}"]`;
      const selector = shares ? column : `${column}[data-month="${month}"]`;
      for (const field of $('editor-scroller').querySelectorAll(selector)) displayGridInput(field, stock);
      let message = `${formatGridValue(mode, value)} 저장했어요.`;
      if (value === null) {
        if (!shares) message = '가격 기록을 지웠어요.';
        else message = removedShareRecord ? '발행 주식 수 변경 기록을 지웠어요.' : '지울 변경 기록이 없어요.';
      }
      setStatus('editor-status', `${stock.name} · ${formatMonth(month)} · ${message}`);
    }
    if (activePage === 'view' && !shares) renderMarket();
    if (advance) advanceGridInput(input);
  } catch (error) {
    draft.invalid = true;
    const stock = stocks.find(({ id }) => id === stockId);
    if (input.isConnected && stock) displayGridInput(input, stock);
    if (editorMode === mode) {
      setStatus('editor-status', errorMessage(error, '값을 저장하지 못했어요. 다시 시도해 주세요.'), true);
    }
  } finally {
    input.readOnly = false;
  }
}

async function registerStock(event) {
  event.preventDefault();
  const input = $('stock-name');
  const name = input.value;
  const submit = $('stock-form').querySelector('button[type="submit"]');
  submit.disabled = true;
  setStatus('stock-form-status');
  try {
    await runWrite(async () => {
      const stock = await addStock(database, name);
      stocks.push(stock);
      pricesByStock.set(stock.id, new Map());
      notifyOtherTabs();
    });
    if (input.value === name) input.value = '';
    $('stock-search').value = '';
    refreshPage();
  } catch (error) {
    setStatus('stock-form-status', errorMessage(error, '종목을 추가하지 못했어요.'), true);
  } finally {
    submit.disabled = false;
  }
}

function beginRename(stock) {
  const dialog = $('rename-dialog');
  dialog.dataset.stock = stock.id;
  setStatus('rename-status');
  $('rename-name').value = stock.name;
  dialog.showModal();
  $('rename-name').select();
}

async function submitRename(event) {
  event.preventDefault();
  const dialog = $('rename-dialog');
  const id = dialog.dataset.stock;
  const name = $('rename-name').value;
  const submit = $('rename-form').querySelector('button[type="submit"]');
  submit.disabled = $('rename-cancel').disabled = true;
  setStatus('rename-status');
  try {
    await runWrite(async () => {
      const renamed = await renameStock(database, id, name);
      stocks = stocks.map((stock) => stock.id === id ? renamed : stock);
      notifyOtherTabs();
    });
    dialog.close();
    refreshPage();
    $('stock-search').focus();
    setStatus('stock-form-status', '종목 이름을 변경했어요.');
  } catch (error) {
    setStatus('rename-status', errorMessage(error, '종목 이름을 변경하지 못했어요.'), true);
  } finally {
    submit.disabled = $('rename-cancel').disabled = false;
  }
}

let confirmOperation;
function askConfirmation(title, description, action, operation) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  $('confirm-action').textContent = action;
  confirmOperation = operation;
  dialog.showModal();
  $('confirm-cancel').focus();
}

function beginStockDeletion({ id, name }) {
  askConfirmation('종목을 삭제할까요?', `‘${name}’ 종목과 등록된 월별 가격이 모두 삭제돼요.`, '삭제', async () => {
    await runWrite(async () => {
      await deleteStock(database, id);
      for (const drafts of Object.values(gridDrafts)) drafts.delete(id);
      useSnapshot(await readSnapshot(database));
      notifyOtherTabs();
    });
    refreshPage();
    setStatus('editor-status', `‘${name}’ 종목을 삭제했어요.`);
    return $('stock-search');
  });
}

async function confirmAction() {
  const dialog = $('confirm-dialog');
  const action = $('confirm-action');
  const cancel = $('confirm-cancel');
  action.disabled = cancel.disabled = true;
  let nextFocus;
  try {
    nextFocus = await confirmOperation();
  } catch (error) {
    setStatus(activePage === 'bets' ? 'bet-status' : 'editor-status', errorMessage(error, '변경 사항을 저장하지 못했어요.'), true);
  } finally {
    action.disabled = cancel.disabled = false;
    dialog.close();
    nextFocus?.focus();
  }
}

async function exportBackup() {
  setStatus('app-status');
  try {
    await pendingWrite;
    const text = serializeBackup(await readSnapshot(database));
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = element('a');
    const timestamp = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      fractionalSecondDigits: 2, hourCycle: 'h23',
    });
    const { year, month, day, hour, minute, second, fractionalSecond } = Object.fromEntries(
      timestamp.formatToParts(new Date()).map(({ type, value }) => [type, value]),
    );
    link.href = url;
    link.download = `backup_${year}-${month}-${day}-${hour}${minute}${second}${fractionalSecond}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('app-status', '백업 파일을 내려받았어요.');
  } catch (error) {
    setStatus('app-status', errorMessage(error, '백업을 내보내지 못했어요.'), true);
  }
}

async function selectBackup(event) {
  const file = event.currentTarget.files[0];
  event.currentTarget.value = '';
  if (!file) return;
  setStatus('app-status');
  clearTimeout(backupToastTimer);
  $('backup-toast').hidden = true;
  $('import-backup').disabled = true;
  try {
    const backup = parseBackup(await file.text());
    await runWrite(async () => {
      await replaceSnapshot(database, backup);
      for (const drafts of Object.values(gridDrafts)) drafts.clear();
      useSnapshot(backup);
      gridSignature = undefined;
      notifyOtherTabs();
    });
    savePreferences();
    refreshPage();
    $('backup-toast-file').textContent = file.name;
    $('backup-toast-details').textContent = `종목 ${backup.stocks.length.toLocaleString('ko-KR')}개 · 월별 가격 ${backup.prices.length.toLocaleString('ko-KR')}건 · 베팅 기록 ${backup.bets.length.toLocaleString('ko-KR')}건`;
    $('backup-toast').hidden = false;
    backupToastTimer = setTimeout(() => { $('backup-toast').hidden = true; }, 5000);
  } catch (error) {
    setStatus('app-status', errorMessage(error, '백업을 복원하지 못했어요.'), true);
  } finally {
    $('import-backup').disabled = false;
  }
}

function wireEvents() {
  const pages = ['view', 'editor', 'bets'];
  for (const page of pages) {
    $(`open-${page}`).addEventListener('click', () => openPage(page));
  }
  document.querySelector('.site-tabs').addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = pages.indexOf(activePage);
    let next;
    if (event.key === 'ArrowRight') next = pages[(index + 1) % pages.length];
    else if (event.key === 'ArrowLeft') next = pages[(index + pages.length - 1) % pages.length];
    else if (event.key === 'Home') next = pages[0];
    else if (event.key === 'End') next = pages.at(-1);
    if (!next) return;
    event.preventDefault();
    openPage(next);
  });
  $('add-bet').addEventListener('click', registerBet);
  $('previous-month').addEventListener('click', () => moveMonth(-1));
  $('next-month').addEventListener('click', () => moveMonth(1));
  $('view-cards').addEventListener('click', () => setView('cards'));
  $('view-table').addEventListener('click', () => setView('table'));
  $('sort-name').addEventListener('click', () => {
    sortMode = 'name';
    savePreferences();
    renderMarket();
  });
  $('sort-rate').addEventListener('click', () => {
    sortMode = { name: 'desc', desc: 'asc', asc: 'name' }[sortMode];
    savePreferences();
    renderMarket();
  });
  $('stock-form').addEventListener('submit', registerStock);
  $('stock-search').addEventListener('input', renderStockList);
  for (const mode of ['price', 'shares']) {
    $(`editor-${mode}-tab`).addEventListener('click', () => selectEditorMode(mode));
  }
  $('editor-mode-tabs').addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let mode;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') mode = editorMode === 'price' ? 'shares' : 'price';
    else if (event.key === 'Home') mode = 'price';
    else if (event.key === 'End') mode = 'shares';
    if (!mode) return;
    event.preventDefault();
    selectEditorMode(mode);
    $(`editor-${mode}-tab`).focus();
  });
  $('reset-editor-selection').addEventListener('click', () => {
    selected.clear();
    writePreference(editorSelectionKey, []);
    refreshPage();
    $('stock-search').focus();
  });
  const grid = $('editor-scroller');
  grid.addEventListener('mousedown', (event) => {
    const input = event.target;
    if (event.button !== 0 || !input.matches('.grid-input:enabled') || input === document.activeElement) return;
    // Let focus select the full value without the first mouse click placing the caret.
    event.preventDefault();
    input.focus();
  });
  grid.addEventListener('focusin', ({ target }) => {
    if (!target.matches('.grid-input')) return;
    const stock = stocks.find(({ id }) => id === target.dataset.stock);
    if (stock) displayGridInput(target, stock);
    target.select();
  });
  grid.addEventListener('focusout', ({ target }) => {
    if (!target.matches('.grid-input')) return;
    const { mode, stock: stockId, month } = target.dataset;
    if (gridDrafts[mode].get(stockId)?.has(month)) {
      commitGridInput(target);
    } else {
      const stock = stocks.find(({ id }) => id === stockId);
      if (stock) displayGridInput(target, stock, false);
    }
  });
  grid.addEventListener('input', ({ target }) => {
    if (!target.matches('.grid-input')) return;
    const { mode, stock, month } = target.dataset;
    const drafts = gridDrafts[mode];
    if (!drafts.has(stock)) drafts.set(stock, new Map());
    drafts.get(stock).set(month, { value: target.value });
    target.removeAttribute('aria-invalid');
  });
  grid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('.grid-input')) return;
    event.preventDefault();
    commitGridInput(event.target, true);
  });
  $('rename-form').addEventListener('submit', submitRename);
  $('rename-cancel').addEventListener('click', () => $('rename-dialog').close());
  $('rename-dialog').addEventListener('cancel', (event) => {
    if ($('rename-cancel').disabled) event.preventDefault();
  });
  $('confirm-cancel').addEventListener('click', () => $('confirm-dialog').close());
  $('confirm-action').addEventListener('click', confirmAction);
  $('confirm-dialog').addEventListener('cancel', (event) => {
    if ($('confirm-action').disabled) event.preventDefault();
  });
  $('export-backup').addEventListener('click', exportBackup);
  $('import-backup').addEventListener('click', () => $('backup-file').click());
  $('backup-file').addEventListener('change', selectBackup);
}

try {
  database = await openDatabase();
  useSnapshot(await readSnapshot(database));
  if (typeof BroadcastChannel === 'function') {
    tabUpdates = new BroadcastChannel(preferencesKey);
    tabUpdates.addEventListener('message', () => {
      runWrite(async () => {
        useSnapshot(await readSnapshot(database));
        gridSignature = undefined;
        refreshPage();
      }).catch(() => setStatus('app-status', '다른 탭의 변경 내용을 불러오지 못했어요.', true));
    });
  }
  wireEvents();
  datePicker = bindDatePicker({
    trigger: $('current-month'),
    panel: $('date-picker'),
    years: $('date-years'),
    months: $('date-months'),
    getMonth: () => currentMonth,
    getFirstMonth: firstQueryMonth,
    getLastMonth: lastQueryMonth,
    onSelect: selectMonth,
  });
  bettingEditor = bindBettingEditor({
    list: $('bet-list'),
    onSave: (id, field, value) => runWrite(async () => {
      const saved = await saveBetField(database, id, field, value);
      bets = bets.map((bet) => bet.id === id ? saved : bet);
      clampQueryMonth();
      if (activePage === 'view') renderMarket();
      notifyOtherTabs();
      return saved;
    }),
    onDelete: beginBetDeletion,
  });
  renderMarket();
} catch (error) {
  setStatus('app-status', errorMessage(error, '브라우저의 저장소를 열지 못했어요. 페이지를 다시 열어 주세요.'), true);
  $('open-editor').disabled = true;
  $('open-bets').disabled = true;
  $('export-backup').disabled = true;
  $('import-backup').disabled = true;
}
