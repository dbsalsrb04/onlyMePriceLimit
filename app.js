import {
  FIRST_MONTH, INITIAL_LAST_MONTH, isValidMonth, shiftMonth, listMonths,
  formatMonth, formatPrice, formatRate, rateTone, buildMarketView,
} from './market.js';
import {
  openDatabase, readSnapshot, addStock, renameStock, deleteStock, savePrice,
  replaceSnapshot, serializeBackup, parseBackup,
} from './storage.js';
import { bindEditorColumnDrag } from './editor-column-drag.js';

const $ = (id) => document.getElementById(id);
const byName = new Intl.Collator('ko-KR');
const projectPath = new URL('./', location.href).pathname;
const preferencesKey = `onlyMePriceLimit:preferences:${projectPath}`;
const editorSelectionKey = `onlyMePriceLimit:editor-selection:${projectPath}`;
const preferences = readPreference(preferencesKey) ?? {};
let currentMonth = isValidMonth(preferences.month) ? preferences.month : FIRST_MONTH;
let lastMonth = INITIAL_LAST_MONTH;
let viewType = preferences.view === 'table' ? 'table' : 'cards';
let sortMode = 'name';
let activePage = 'view';
let database;
let stocks = [];
let pricesByStock = new Map();
const selected = new Set(readEditorSelection());
const drafts = new Map();
let gridSignature;
let pendingWrite = Promise.resolve();
let tabUpdates;

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
  writePreference(preferencesKey, { month: currentMonth, view: viewType });
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

function useSnapshot(snapshot) {
  stocks = snapshot.stocks;
  pricesByStock = new Map(stocks.map(({ id }) => [id, new Map()]));
  lastMonth = INITIAL_LAST_MONTH;
  for (const { stockId, month, price } of snapshot.prices) {
    pricesByStock.get(stockId).set(month, price);
    if (month > lastMonth) lastMonth = month;
  }
  if (currentMonth > lastMonth) currentMonth = lastMonth;

  for (const id of selected) {
    if (!pricesByStock.has(id)) {
      selected.delete(id);
      drafts.delete(id);
    }
  }
  const savedSelection = readEditorSelection();
  const availableSelection = savedSelection.filter((id) => pricesByStock.has(id));
  if (availableSelection.length !== savedSelection.length) {
    writePreference(editorSelectionKey, availableSelection);
  }
}

function viewSnapshot() {
  const nextMonth = shiftMonth(currentMonth, 1);
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

function renderMarket() {
  $('current-month').textContent = formatMonth(currentMonth);
  $('previous-month').disabled = currentMonth === FIRST_MONTH;
  $('next-month').disabled = currentMonth === lastMonth;
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

function moveMonth(amount) {
  const month = shiftMonth(currentMonth, amount);
  if (month && month <= lastMonth) {
    currentMonth = month;
    savePreferences();
    renderMarket();
  }
}

function setView(view) {
  viewType = view;
  savePreferences();
  renderMarket();
}

function openPage(page) {
  activePage = page;
  $('view').hidden = page !== 'view';
  $('editor').hidden = page !== 'editor';
  $('open-editor').hidden = page === 'editor';
  $('open-view').hidden = page === 'view';
  if (page === 'view') {
    renderMarket();
    $('open-editor').focus();
  } else {
    renderStockList();
    renderGrid();
    scrollToEditorMonth(currentMonth);
    $('open-view').focus();
  }
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
  else {
    renderStockList();
    renderGrid();
  }
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
  if (activeInput?.matches('#editor-scroller .price-input')) activeInput.blur();

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

function formatPriceInput(price) {
  return price == null ? '' : formatPrice(price);
}

function priceCell({ id, name }, month) {
  const cell = element('td');
  const input = element('input', 'price-input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.dataset.stock = id;
  input.dataset.month = month;
  input.setAttribute('aria-label', `${name} ${formatMonth(month)} 가격`);
  input.value = drafts.get(id)?.get(month) ?? formatPriceInput(pricesByStock.get(id).get(month));
  cell.append(input);
  return cell;
}

function renderGrid() {
  const stocksById = new Map(stocks.map((stock) => [stock.id, stock]));
  const columns = [...selected].map((id) => stocksById.get(id));
  const scroller = $('editor-scroller');
  $('reset-editor-selection').disabled = columns.length === 0;
  scroller.hidden = columns.length === 0;
  $('editor-empty').hidden = columns.length !== 0;
  const signature = JSON.stringify([lastMonth, columns]);
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
  table.setAttribute('aria-label', '종목별 월간 주가 편집');
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
  for (const month of listMonths(lastMonth)) {
    const row = body.insertRow();
    row.dataset.month = month;
    const monthCell = element('th', 'month-cell', month);
    monthCell.scope = 'row';
    row.append(monthCell);
    for (const stock of columns) row.append(priceCell(stock, month));
  }
  scroller.replaceChildren(table);
  scroller.scrollTop = oldTop;
  scroller.scrollLeft = oldLeft;
}

function scrollToEditorMonth(month) {
  const scroller = $('editor-scroller');
  const row = scroller.querySelector(`tr[data-month="${month}"]`);
  if (!row) return;
  const headerHeight = scroller.querySelector('thead').getBoundingClientRect().height;
  scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - headerHeight;
}

function parsePrice(value) {
  const text = value.trim();
  if (!text) return null;
  const amount = text.replace(/\s*원$/, '');
  const number = Number(amount.replaceAll(',', ''));
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/.test(amount) || !Number.isSafeInteger(number)) {
    throw new Error('가격은 0 이상의 정수로 입력해 주세요.');
  }
  return number;
}

async function commitPrice(input, advance = false) {
  if (input.readOnly) return;
  const { stock: stockId, month } = input.dataset;
  const draft = drafts.get(stockId)?.get(month);
  input.readOnly = true;
  try {
    const price = parsePrice(input.value);
    await runWrite(async () => {
      await savePrice(database, stockId, month, price);
      const prices = pricesByStock.get(stockId);
      if (price === null) prices.delete(month);
      else prices.set(month, price);
      if (drafts.get(stockId)?.get(month) === draft) drafts.get(stockId)?.delete(month);
      notifyOtherTabs();
    });
    const field = input.isConnected ? input : $('editor-scroller').querySelector(
      `.price-input[data-stock="${CSS.escape(stockId)}"][data-month="${month}"]`,
    );
    if (field && !drafts.get(stockId)?.has(month)) {
      field.value = formatPriceInput(price);
      field.removeAttribute('aria-invalid');
      field.classList.remove('has-error');
    }
    const stock = stocks.find(({ id }) => id === stockId);
    const message = price === null ? '가격 기록을 지웠어요.' : `${formatPrice(price)} 저장했어요.`;
    setStatus('editor-status', `${stock.name} · ${formatMonth(month)} · ${message}`);
    if (activePage === 'view') renderMarket();
    if (advance && document.activeElement === input) {
      const cell = input.closest('td');
      const nextRow = cell.parentElement.nextElementSibling;
      const nextInput = nextRow?.cells[cell.cellIndex]?.firstElementChild;
      nextInput?.focus();
      nextInput?.select();
    }
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    input.classList.add('has-error');
    setStatus('editor-status', errorMessage(error, '가격을 저장하지 못했어요. 다시 시도해 주세요.'), true);
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
      drafts.delete(id);
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
    setStatus('editor-status', errorMessage(error, '변경 사항을 저장하지 못했어요.'), true);
  } finally {
    action.disabled = cancel.disabled = false;
    dialog.close();
    nextFocus?.focus();
  }
}

async function exportBackup() {
  setStatus('editor-status');
  try {
    await pendingWrite;
    const text = serializeBackup(await readSnapshot(database));
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = element('a');
    const date = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short' }).format(new Date());
    link.href = url;
    link.download = `only-me-price-limit-${date}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('editor-status', '백업 파일을 내려받았어요.');
  } catch (error) {
    setStatus('editor-status', errorMessage(error, '백업을 내보내지 못했어요.'), true);
  }
}

async function selectBackup(event) {
  const file = event.currentTarget.files[0];
  event.currentTarget.value = '';
  if (!file) return;
  setStatus('editor-status');
  try {
    const backup = parseBackup(await file.text());
    const primary = `현재 종목과 월별 가격 전체가 백업으로 교체돼요.`;
    const details = `백업에 종목 ${backup.stocks.length}개와 월별 가격 ${backup.prices.length}건이 있어요.`;
    askConfirmation('백업을 복원할까요?', `${primary} ${details}`, '복원', async () => {
      await runWrite(async () => {
        await replaceSnapshot(database, backup);
        drafts.clear();
        useSnapshot(backup);
        gridSignature = undefined;
        notifyOtherTabs();
      });
      savePreferences();
      refreshPage();
      setStatus('editor-status', '백업을 복원했어요.');
      return $('import-backup');
    });
  } catch (error) {
    setStatus('editor-status', errorMessage(error, '백업 파일을 읽지 못했어요.'), true);
  }
}

function wireEvents() {
  $('open-editor').addEventListener('click', () => openPage('editor'));
  $('open-view').addEventListener('click', () => openPage('view'));
  $('previous-month').addEventListener('click', () => moveMonth(-1));
  $('next-month').addEventListener('click', () => moveMonth(1));
  $('view-cards').addEventListener('click', () => setView('cards'));
  $('view-table').addEventListener('click', () => setView('table'));
  $('sort-name').addEventListener('click', () => { sortMode = 'name'; renderMarket(); });
  $('sort-rate').addEventListener('click', () => {
    sortMode = { name: 'desc', desc: 'asc', asc: 'name' }[sortMode];
    renderMarket();
  });
  $('stock-form').addEventListener('submit', registerStock);
  $('stock-search').addEventListener('input', renderStockList);
  $('reset-editor-selection').addEventListener('click', () => {
    selected.clear();
    writePreference(editorSelectionKey, []);
    refreshPage();
    $('stock-search').focus();
  });
  const priceEditor = $('editor-scroller');
  priceEditor.addEventListener('focusout', ({ target }) => {
    if (!target.matches('.price-input') || target.readOnly) return;
    const { stock, month } = target.dataset;
    if (drafts.get(stock)?.has(month)) commitPrice(target);
  });
  priceEditor.addEventListener('input', ({ target }) => {
    if (!target.matches('.price-input')) return;
    const { stock, month } = target.dataset;
    if (!drafts.has(stock)) drafts.set(stock, new Map());
    drafts.get(stock).set(month, target.value);
    target.classList.remove('has-error');
    target.removeAttribute('aria-invalid');
  });
  priceEditor.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('.price-input')) return;
    event.preventDefault();
    commitPrice(event.target, true);
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
  renderMarket();
} catch (error) {
  setStatus('app-status', errorMessage(error, '브라우저의 저장소를 열지 못했어요. 페이지를 다시 열어 주세요.'), true);
  $('open-editor').disabled = true;
}
