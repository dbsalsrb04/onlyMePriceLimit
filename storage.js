import { FIRST_BET_MONTH, FIRST_MONTH, isValidMonth, shiftMonth } from "./market.js";

const BACKUP_VERSION = 2;
const STOCKS = "stocks";
const PRICES = "prices";
const BETS = "bets";
const STOCK_BY_NAME = "byName";
const PRICE_BY_STOCK = "byStock";
const DUPLICATE_NAME = "같은 이름의 종목이 이미 있어요.";

export async function openDatabase() {
  const pagePath = globalThis.location?.pathname ?? "/";
  const sitePath = pagePath.replace(/\/index\.html$|\/$/, "");

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`onlyMePriceLimit${sitePath}`, 3);
    let blocked = false;

    request.onupgradeneeded = () => {
      const db = request.result;
      const stocks = db.objectStoreNames.contains(STOCKS)
        ? request.transaction.objectStore(STOCKS)
        : db.createObjectStore(STOCKS, { keyPath: "id" });
      if (!stocks.indexNames.contains(STOCK_BY_NAME)) {
        stocks.createIndex(STOCK_BY_NAME, "nameKey", { unique: true });
      }

      const prices = db.objectStoreNames.contains(PRICES)
        ? request.transaction.objectStore(PRICES)
        : db.createObjectStore(PRICES, { keyPath: ["stockId", "month"] });
      if (!prices.indexNames.contains(PRICE_BY_STOCK)) {
        prices.createIndex(PRICE_BY_STOCK, "stockId");
      }

      if (!db.objectStoreNames.contains(BETS)) {
        const bets = db.createObjectStore(BETS, { keyPath: "id" });
        bets.add({ id: crypto.randomUUID(), title: "제목", month: FIRST_MONTH, answer: "정답!!", order: 0 });
      } else {
        const bets = request.transaction.objectStore(BETS);
        const existing = bets.getAll();
        existing.onsuccess = () => {
          for (const bet of validateBets(existing.result)) bets.put(bet);
        };
      }
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error("다른 탭에서 이 사이트를 닫은 뒤 다시 열어 주세요."));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function runTransaction(db, stores, mode, run, duplicateMessage) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    let result;
    let failure;

    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => {
      if (duplicateMessage && transaction.error?.name === "ConstraintError") {
        reject(new Error(duplicateMessage));
        return;
      }
      reject(failure ?? transaction.error ?? new Error("저장소 작업을 완료할 수 없어요."));
    };

    const setResult = (value) => { result = value; };
    const abort = (error) => {
      failure = error;
      transaction.abort();
    };

    try {
      run(transaction, setResult, abort);
    } catch (error) {
      abort(error);
    }
  });
}

function normalizeName(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("종목 이름을 입력해 주세요.");
  }
  return value.trim().normalize("NFC");
}

function nameKey(name) {
  return name.normalize("NFKC").toLowerCase();
}

function findStock(stocks, id, onFound, abort) {
  const request = stocks.get(id);
  request.onsuccess = () => {
    if (!request.result) {
      abort(new Error("이 종목의 기록을 찾을 수 없어요."));
      return;
    }
    onFound(request.result);
  };
}

function isValidPrice(price) {
  return Number.isSafeInteger(price) && price >= 0;
}

function publicStock({ id, name, issuedShares }) {
  const stock = { id, name };
  if (issuedShares != null) stock.issuedShares = issuedShares;
  return stock;
}

function validateIssuedShares(issuedShares) {
  if (!Number.isSafeInteger(issuedShares) || issuedShares < 0) {
    throw new Error("발행주식 수는 0 이상의 정수로 입력해 주세요.");
  }
}

export async function readSnapshot(db) {
  return runTransaction(db, [STOCKS, PRICES, BETS], "readonly", (transaction, setResult) => {
    const snapshot = { stocks: [], prices: [], bets: [] };
    const stocks = transaction.objectStore(STOCKS).getAll();
    const prices = transaction.objectStore(PRICES).getAll();
    const bets = transaction.objectStore(BETS).getAll();

    stocks.onsuccess = () => {
      snapshot.stocks = stocks.result.map(publicStock);
    };
    prices.onsuccess = () => { snapshot.prices = prices.result; };
    bets.onsuccess = () => { snapshot.bets = sortBets(bets.result); };
    setResult(snapshot);
  });
}

export async function addStock(db, inputName) {
  const name = normalizeName(inputName);
  const stock = { id: crypto.randomUUID(), name };

  return runTransaction(db, [STOCKS], "readwrite", (transaction, setResult) => {
    transaction.objectStore(STOCKS).add({ ...stock, nameKey: nameKey(name) });
    setResult(stock);
  }, DUPLICATE_NAME);
}

export async function renameStock(db, id, inputName) {
  const name = normalizeName(inputName);

  return runTransaction(db, [STOCKS], "readwrite", (transaction, setResult, abort) => {
    const stocks = transaction.objectStore(STOCKS);
    findStock(stocks, id, (existing) => {
      const stock = { ...existing, name, nameKey: nameKey(name) };
      stocks.put(stock);
      setResult(publicStock(stock));
    }, abort);
  }, DUPLICATE_NAME);
}

export async function saveIssuedShares(db, stockId, issuedShares) {
  if (issuedShares !== null) validateIssuedShares(issuedShares);

  return runTransaction(db, [STOCKS], "readwrite", (transaction, setResult, abort) => {
    const stocks = transaction.objectStore(STOCKS);
    findStock(stocks, stockId, (stock) => {
      if (issuedShares === null) delete stock.issuedShares;
      else stock.issuedShares = issuedShares;
      stocks.put(stock);
      setResult(publicStock(stock));
    }, abort);
  });
}

export async function deleteStock(db, id) {
  return runTransaction(db, [STOCKS, PRICES], "readwrite", (transaction) => {
    const stocks = transaction.objectStore(STOCKS);
    const prices = transaction.objectStore(PRICES);
    const matches = prices.index(PRICE_BY_STOCK).openKeyCursor(IDBKeyRange.only(id));

    stocks.delete(id);
    matches.onsuccess = () => {
      const cursor = matches.result;
      if (cursor) {
        prices.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  });
}

export async function savePrice(db, stockId, month, price) {
  if (!isValidMonth(month)) {
    throw new Error("유효한 연월을 선택해 주세요.");
  }
  if (price !== null && !isValidPrice(price)) {
    throw new Error("가격은 0 이상의 정수로 입력해 주세요.");
  }

  return runTransaction(db, [STOCKS, PRICES], "readwrite", (transaction, _setResult, abort) => {
    findStock(transaction.objectStore(STOCKS), stockId, () => {
      const prices = transaction.objectStore(PRICES);
      if (price === null) {
        prices.delete([stockId, month]);
      } else {
        prices.put({ stockId, month, price });
      }
    }, abort);
  });
}

function parseBetMonth(value) {
  const match = /^(\d{4})(?:-|년\s*)(\d{1,2})월?$/.exec(value);
  if (!match) return null;
  const month = `${match[1]}-${match[2].padStart(2, "0")}`;
  return isValidMonth(month, FIRST_BET_MONTH) ? month : null;
}

function normalizeBetField(field, value) {
  if (field === "month") {
    const month = typeof value === "string" ? parseBetMonth(value.trim()) : null;
    if (!month) throw new Error("연월을 YYYY-MM 형식으로 입력해 주세요. (예: 2000-09)");
    return month;
  }
  if (!["title", "answer"].includes(field) || typeof value !== "string") {
    throw new Error("베팅의 제목과 정답은 텍스트로 입력해 주세요.");
  }
  return value;
}

function sortBets(bets) {
  return bets.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export async function addBet(db, { title, answer }) {
  normalizeBetField("title", title);
  normalizeBetField("answer", answer);

  return runTransaction(db, [BETS], "readwrite", (transaction, setResult, abort) => {
    const bets = transaction.objectStore(BETS);
    const request = bets.getAll();
    request.onsuccess = () => {
      const order = request.result.reduce((last, bet) => Math.max(last, bet.order), -1) + 1;
      if (!Number.isSafeInteger(order)) {
        abort(new Error("베팅 항목 순서를 더 추가할 수 없어요."));
        return;
      }
      const latest = request.result.reduce((month, bet) => bet.month > month ? bet.month : month, "");
      const month = latest ? shiftMonth(latest, 1, FIRST_BET_MONTH) : FIRST_MONTH;
      const bet = { id: crypto.randomUUID(), title, month, answer, order };
      bets.add(bet);
      setResult(bet);
    };
  });
}

export async function saveBetField(db, id, field, value) {
  const normalized = normalizeBetField(field, value);

  return runTransaction(db, [BETS], "readwrite", (transaction, setResult, abort) => {
    const bets = transaction.objectStore(BETS);
    const request = bets.get(id);
    request.onsuccess = () => {
      if (!request.result) {
        abort(new Error("이 베팅 항목을 찾을 수 없어요."));
        return;
      }
      const bet = { ...request.result, [field]: normalized };
      bets.put(bet);
      setResult(bet);
    };
  });
}

export async function deleteBet(db, id) {
  return runTransaction(db, [BETS], "readwrite", (transaction) => {
    transaction.objectStore(BETS).delete(id);
  });
}

function fillBetMonths(bets, legacyIds) {
  const occupied = new Set(bets.map(({ month }) => month).filter(Boolean));
  // Preserve a year written in a legacy title when January is available.
  for (const bet of bets) {
    if (bet.month || !legacyIds.has(bet.id)) continue;
    const year = /^(\d{4})(?:년|\s)/.exec(bet.title)?.[1];
    const january = year && `${year}-01`;
    if (isValidMonth(january, FIRST_BET_MONTH) && !occupied.has(january)) {
      bet.month = january;
      occupied.add(january);
    }
  }

  let previous;
  let index = 0;
  while (index < bets.length) {
    if (bets[index].month) {
      previous = bets[index++].month;
      continue;
    }
    const start = index;
    while (index < bets.length && !bets[index].month) index += 1;
    const next = bets[index]?.month;
    const missing = bets.slice(start, index).filter(({ id }) => legacyIds.has(id));
    let month = previous ? shiftMonth(previous, 1, FIRST_BET_MONTH) : FIRST_BET_MONTH;
    if (!previous && next) {
      month = shiftMonth(next, -missing.length, FIRST_BET_MONTH) ?? FIRST_BET_MONTH;
    }
    for (const bet of missing) {
      while (month && occupied.has(month)) month = shiftMonth(month, 1, FIRST_BET_MONTH);
      if (!month || (next && month >= next)) break;
      bet.month = month;
      occupied.add(month);
      month = shiftMonth(month, 1, FIRST_BET_MONTH);
    }
  }
  return bets;
}

function validateBets(value = []) {
  if (!Array.isArray(value)) {
    throw new Error("백업 파일의 베팅 목록이 올바르지 않아요.");
  }
  const ids = new Set();
  const legacyIds = new Set();
  const bets = value.map((bet, index) => {
    if (typeof bet?.id !== "string" || !bet.id.trim() || ids.has(bet.id)
      || !Number.isSafeInteger(bet.order) || bet.order < 0) {
      throw new Error(`백업 파일의 ${index + 1}번째 베팅 항목이 올바르지 않아요.`);
    }
    let title = normalizeBetField("title", bet.title);
    const answer = normalizeBetField("answer", bet.answer);
    let month = bet.month ?? null;
    if (!Object.hasOwn(bet, "month")) {
      legacyIds.add(bet.id);
      const suffix = /(?:\s*\|\s*|\s+)(\d{4}년\s*\d{1,2}월)\s*$/.exec(title);
      month = suffix ? parseBetMonth(suffix[1]) : null;
      if (month) title = title.slice(0, suffix.index).trimEnd();
      title = title.replace(/\s*\|\s*$/, "");
    } else if (month !== null && !isValidMonth(month, FIRST_BET_MONTH)) {
      throw new Error(`백업 파일의 ${index + 1}번째 베팅 연월이 올바르지 않아요.`);
    }
    ids.add(bet.id);
    return { id: bet.id, title, month, answer, order: bet.order };
  });
  return fillBetMonths(sortBets(bets), legacyIds);
}

function validateSnapshot(value) {
  if (!value || !Array.isArray(value.stocks) || !Array.isArray(value.prices)) {
    throw new Error("백업 파일의 종목 또는 가격 목록이 올바르지 않아요.");
  }

  const stockIds = new Set();
  const names = new Set();
  const recordedMonths = new Map();
  const stocks = value.stocks.map((stock, index) => {
    if (typeof stock?.id !== "string" || !stock.id.trim() || stockIds.has(stock.id)) {
      throw new Error(`백업 파일의 ${index + 1}번째 종목 식별자가 올바르지 않아요.`);
    }
    const name = normalizeName(stock.name);
    if (stock.issuedShares != null) validateIssuedShares(stock.issuedShares);
    const key = nameKey(name);
    if (names.has(key)) {
      throw new Error(`백업 파일에 이름이 같은 종목이 있어요. (${name})`);
    }
    stockIds.add(stock.id);
    names.add(key);
    recordedMonths.set(stock.id, new Set());
    return publicStock({ id: stock.id, name, issuedShares: stock.issuedShares });
  });

  const prices = value.prices.map((record, index) => {
    const months = recordedMonths.get(record?.stockId);
    if (!months || !isValidMonth(record.month) || !isValidPrice(record.price)) {
      throw new Error(`백업 파일의 ${index + 1}번째 가격 기록이 올바르지 않아요.`);
    }
    if (months.has(record.month)) {
      throw new Error(`백업 파일에 같은 종목의 ${record.month} 가격이 여러 개 있어요.`);
    }
    months.add(record.month);
    return { stockId: record.stockId, month: record.month, price: record.price };
  });

  return { stocks, prices, bets: validateBets(value.bets) };
}

export async function replaceSnapshot(db, snapshot) {
  const replacement = validateSnapshot(snapshot);

  return runTransaction(db, [STOCKS, PRICES, BETS], "readwrite", (transaction) => {
    const stocks = transaction.objectStore(STOCKS);
    const prices = transaction.objectStore(PRICES);
    const bets = transaction.objectStore(BETS);
    stocks.clear();
    prices.clear();
    bets.clear();

    for (const stock of replacement.stocks) {
      stocks.add({ ...stock, nameKey: nameKey(stock.name) });
    }
    for (const price of replacement.prices) {
      prices.add(price);
    }
    for (const bet of replacement.bets) {
      bets.add(bet);
    }
  });
}

export function serializeBackup({ stocks, prices, bets = [] }) {
  return JSON.stringify({ version: BACKUP_VERSION, stocks, prices, bets }, null, 2);
}

export function parseBackup(text) {
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("백업 파일을 읽을 수 없어요. JSON 백업 파일을 선택해 주세요.");
  }
  if (value?.version !== 1 && value?.version !== BACKUP_VERSION) {
    throw new Error("지원하는 백업 파일 형식이 아니에요.");
  }
  if (value.version === 1) return validateSnapshot({ ...value, bets: [] });
  if (!Array.isArray(value.bets)) {
    throw new Error("백업 파일의 베팅 목록이 올바르지 않아요.");
  }
  return validateSnapshot(value);
}
