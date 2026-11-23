import {
  FIRST_BET_MONTH, FIRST_MONTH, INITIAL_LAST_MONTH, LAST_ISSUED_SHARES_MONTH, isValidMonth, shiftMonth, listMonths,
  formatMonth, formatPrice, formatIssuedShares, formatCompactIssuedShares, formatMarketCap, formatMarketCapChange,
  issuedSharesRecordAt, formatRate, rateTone, buildMarketView,
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
let marketCapSort = ['desc', 'asc'].includes(preferences.marketCapSort) ? preferences.marketCapSort : null;
let leaderBasis = preferences.leaderBasis === 'market-cap' ? 'market-cap' : 'rate';
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
let notificationTimer;

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
  writePreference(preferencesKey, { month: currentMonth, view: viewType, sort: sortMode, marketCapSort, leaderBasis });
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

function showNotification(message, { error = false, details = [], region = $('notifications') } = {}) {
  const card = element('div', 'notification');
  card.classList.toggle('notification-error', error);
  card.append(element('strong', '', message), ...details.map((line) => element('p', '', line)));
  clearTimeout(notificationTimer);
  $('notifications').replaceChildren();
  $('rename-notifications').replaceChildren();
  region.replaceChildren(card);
  notificationTimer = setTimeout(() => region.replaceChildren(), 5000);
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

function renderLeader({ name, currentPrice, nextPrice, rate, marketCapChange }, byMarketCap) {
  const card = element('article', 'leader-card');
  const capText = `시총 ${formatMarketCapChange(marketCapChange)}`;
  const secondary = byMarketCap ? formatRate(rate) : capText;
  const capTone = marketCapChange > 0n ? 'up' : marketCapChange < 0n ? 'down' : 'flat';
  const primary = byMarketCap
    ? element('strong', `leader-primary tone-${capTone}`, capText)
    : rateElement('strong', 'leader-primary', rate);
  card.append(
    element('h3', 'leader-name', name),
    element('p', 'leader-prices', formatPriceChange(currentPrice, nextPrice)),
    element('p', 'leader-secondary', secondary),
    primary,
  );
  return card;
}

function renderCard({ name, currentPrice, nextPrice, rate, marketCapChange }) {
  const card = element('article', 'stock-card');
  const summary = element('p', 'stock-card-summary');
  const rateText = rateElement('strong', 'stock-card-rate', rate);
  rateText.textContent = `(${rateText.textContent})`;
  summary.append(element('span', 'stock-card-prices', formatPriceChange(currentPrice, nextPrice)), ' ', rateText);
  card.append(
    element('h3', 'stock-card-name', name),
    summary,
    element('p', 'stock-card-cap-change', `시총 ${formatMarketCapChange(marketCapChange)}`),
  );
  return card;
}

function marketTableCell(tag, value, className = '') {
  const cell = element(tag, className);
  const text = element('span', 'market-cell-text', value);
  text.title = value;
  cell.append(text);
  return cell;
}

function renderTableRow({ name, issuedShares, currentMarketCap, nextMarketCap, currentPrice, nextPrice, rate }) {
  const row = element('tr');
  const nameCell = marketTableCell('th', name);
  nameCell.scope = 'row';
  row.append(
    nameCell,
    marketTableCell('td', formatCompactIssuedShares(issuedShares)),
    marketTableCell('td', formatMarketCap(currentMarketCap)),
    marketTableCell('td', formatMarketCap(nextMarketCap)),
    marketTableCell('td', formatPrice(currentPrice)),
    marketTableCell('td', formatPrice(nextPrice)),
    marketTableCell('td', formatRate(rate), `tone-${rateTone(rate)}`),
  );
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

function renderSortButton(id, label, direction) {
  const control = $(id);
  const arrow = { desc: ' ↓', asc: ' ↑' }[direction] ?? '';
  const order = { desc: '내림차순', asc: '오름차순' }[direction];
  control.setAttribute('aria-pressed', String(Boolean(order)));
  control.setAttribute('aria-label', order ? `${label}, ${order}` : label);
  control.textContent = label + arrow;
}

function renderMarket() {
  $('current-month').textContent = formatMonth(currentMonth);
  $('previous-month').disabled = currentMonth === firstQueryMonth();
  $('next-month').disabled = currentMonth === lastQueryMonth();
  renderMonthlyBets();
  $('view-cards').setAttribute('aria-pressed', String(viewType === 'cards'));
  $('view-table').setAttribute('aria-pressed', String(viewType === 'table'));
  $('sort-name').setAttribute('aria-pressed', String(sortMode === 'name'));
  renderSortButton('sort-rate', '상승률 순', sortMode);
  const capBasis = marketCapSort && sortMode !== 'name' ? '시총 증가액 내림차순' : '다음 달 시총 기준';
  renderSortButton('sort-market-cap', '시가총액 순', marketCapSort);
  const capButton = $('sort-market-cap');
  capButton.title = capBasis;
  capButton.setAttribute('aria-description', capBasis);

  const { rows, leaders, marketCapLeaders } = buildMarketView(viewSnapshot(), currentMonth, sortMode, marketCapSort);
  const byMarketCap = leaderBasis === 'market-cap';
  const leaderButton = $('leader-basis');
  leaderButton.textContent = byMarketCap ? '시가총액 기준' : '상승률 기준';
  leaderButton.setAttribute('aria-label', `추천 기준 변경, 현재 ${leaderButton.textContent}`);
  const recommendations = byMarketCap ? marketCapLeaders : leaders;
  $('leaders').replaceChildren(...recommendations.map((row) => renderLeader(row, byMarketCap)));
  $('leaders').hidden = recommendations.length === 0;
  $('leader-empty').hidden = recommendations.length !== 0;
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
  try {
    await runWrite(async () => {
      const bet = await addBet(database, { title: '제목', answer: '정답!!' });
      bets.push(bet);
      notifyOtherTabs();
    });
    refreshPage();
    showNotification('베팅 기록을 추가했어요.');
  } catch (error) {
    showNotification(errorMessage(error, '베팅 기록을 추가하지 못했어요.'), { error: true });
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
    showNotification('베팅 기록을 삭제했어요.');
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
    showNotification(`${header.textContent} 열을 ${to + 1}번째로 옮겼어요.`);
  }
}

function formatGridValue(mode, value) {
  if (value == null) return '';
  return mode === 'shares' ? formatIssuedShares(value) : formatPrice(value);
}

function displayGridInput(input, stock, editing = document.activeElement === input) {
  const { mode, month } = input.dataset;
  const shares = mode === 'shares';
  const history = stock.issuedSharesHistory;
  const record = shares ? issuedSharesRecordAt(history, month) : undefined;
  const value = shares ? record?.value : pricesByStock.get(stock.id).get(month);
  input.classList.toggle('is-inherited', Boolean(record && record.month !== month));

  const draft = gridDrafts[mode].get(stock.id)?.get(month);
  const text = draft?.value ?? (editing ? String(value ?? '') : formatGridValue(mode, value));
  if (input.value !== text) {
    input.value = text;
    if (editing) input.select();
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
  if (input.readOnly) return;
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
    if (stock) {
      if (editorMode === mode) {
        const column = `.grid-input[data-stock="${CSS.escape(stockId)}"]`;
        const selector = shares ? column : `${column}[data-month="${month}"]`;
        for (const field of $('editor-scroller').querySelectorAll(selector)) displayGridInput(field, stock);
      }
      let message = `${formatGridValue(mode, value)} 저장했어요.`;
      if (value === null) {
        if (!shares) message = '가격 기록을 지웠어요.';
        else message = removedShareRecord ? '발행 주식 수 변경 기록을 지웠어요.' : '지울 변경 기록이 없어요.';
      }
      showNotification(`${stock.name} · ${formatMonth(month)} · ${message}`);
    }
    if (activePage === 'view') renderMarket();
    if (advance) advanceGridInput(input);
  } catch (error) {
    draft.invalid = true;
    const stock = stocks.find(({ id }) => id === stockId);
    if (input.isConnected && stock) displayGridInput(input, stock);
    showNotification(errorMessage(error, '값을 저장하지 못했어요. 다시 시도해 주세요.'), { error: true });
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
    showNotification('종목을 추가했어요.');
  } catch (error) {
    showNotification(errorMessage(error, '종목을 추가하지 못했어요.'), { error: true });
  } finally {
    submit.disabled = false;
  }
}

function beginRename(stock) {
  const dialog = $('rename-dialog');
  dialog.dataset.stock = stock.id;
  $('rename-notifications').replaceChildren();
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
  try {
    await runWrite(async () => {
      const renamed = await renameStock(database, id, name);
      stocks = stocks.map((stock) => stock.id === id ? renamed : stock);
      notifyOtherTabs();
    });
    dialog.close();
    refreshPage();
    $('stock-search').focus();
    showNotification('종목 이름을 변경했어요.');
  } catch (error) {
    showNotification(errorMessage(error, '종목 이름을 변경하지 못했어요.'), {
      error: true,
      region: $('rename-notifications'),
    });
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
    showNotification(`‘${name}’ 종목을 삭제했어요.`);
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
    showNotification(errorMessage(error, '변경 사항을 저장하지 못했어요.'), { error: true });
  } finally {
    action.disabled = cancel.disabled = false;
    dialog.close();
    nextFocus?.focus();
  }
}

async function exportBackup() {
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
    showNotification('백업 파일을 내려받았어요.');
  } catch (error) {
    showNotification(errorMessage(error, '백업을 내보내지 못했어요.'), { error: true });
  }
}

async function selectBackup(event) {
  const startedAt = performance.now();
  const file = event.currentTarget.files[0];
  event.currentTarget.value = '';
  if (!file) return;
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
    const milliseconds = Math.round(performance.now() - startedAt);
    showNotification('백업을 복원했어요.', {
      details: [
        file.name,
        `종목 ${backup.stocks.length.toLocaleString('ko-KR')}개 · 월별 가격 ${backup.prices.length.toLocaleString('ko-KR')}건 · 베팅 기록 ${backup.bets.length.toLocaleString('ko-KR')}건`,
        `${milliseconds}ms (${(milliseconds / 1000).toFixed(3)}초)`,
      ],
    });
  } catch (error) {
    showNotification(errorMessage(error, '백업을 복원하지 못했어요.'), { error: true });
  } finally {
    $('import-backup').disabled = false;
  }
}

function wireEvents() {
  const marketScroller = $('market-table-scroll');
  const stickyHeader = $('market-sticky-header');
  const headerTable = element('table');
  headerTable.append(marketScroller.querySelector('thead').cloneNode(true));
  stickyHeader.append(headerTable);
  marketScroller.addEventListener('scroll', () => { stickyHeader.scrollLeft = marketScroller.scrollLeft; });

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
  $('leader-basis').addEventListener('click', () => {
    leaderBasis = leaderBasis === 'rate' ? 'market-cap' : 'rate';
    savePreferences();
    renderMarket();
  });
  $('view-cards').addEventListener('click', () => setView('cards'));
  $('view-table').addEventListener('click', () => setView('table'));
  $('sort-name').addEventListener('click', () => {
    sortMode = 'name';
    savePreferences();
    renderMarket();
  });
  $('sort-rate').addEventListener('click', () => {
    sortMode = sortMode === 'desc' ? 'asc' : 'desc';
    savePreferences();
    renderMarket();
  });
  $('sort-market-cap').addEventListener('click', () => {
    marketCapSort = { off: 'desc', desc: 'asc', asc: null }[marketCapSort ?? 'off'];
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
      }).catch(() => showNotification('다른 탭의 변경 내용을 불러오지 못했어요.', { error: true }));
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
      showNotification('베팅 기록을 저장했어요.');
      return saved;
    }),
    onError: (error) => showNotification(errorMessage(error, '내용을 저장하지 못했어요. 다시 시도해 주세요.'), { error: true }),
    onDelete: beginBetDeletion,
  });
  renderMarket();
} catch (error) {
  showNotification(errorMessage(error, '브라우저의 저장소를 열지 못했어요. 페이지를 다시 열어 주세요.'), { error: true });
  $('open-editor').disabled = true;
  $('open-bets').disabled = true;
  $('export-backup').disabled = true;
  $('import-backup').disabled = true;
}
