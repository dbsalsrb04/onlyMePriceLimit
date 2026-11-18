import { isValidMonth } from "./market.js";

const BACKUP_VERSION = 1;
const STOCKS = "stocks";
const PRICES = "prices";
const STOCK_BY_NAME = "byName";
const PRICE_BY_STOCK = "byStock";
const DUPLICATE_NAME = "같은 이름의 종목이 이미 있어요.";

export async function openDatabase() {
  const pagePath = globalThis.location?.pathname ?? "/";
  const sitePath = pagePath.replace(/\/index\.html$|\/$/, "");

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`onlyMePriceLimit${sitePath}`, 1);
    let blocked = false;

    request.onupgradeneeded = () => {
      const db = request.result;
      const stocks = db.createObjectStore(STOCKS, { keyPath: "id" });
      stocks.createIndex(STOCK_BY_NAME, "nameKey", { unique: true });

      const prices = db.createObjectStore(PRICES, { keyPath: ["stockId", "month"] });
      prices.createIndex(PRICE_BY_STOCK, "stockId");
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
  return runTransaction(db, [STOCKS, PRICES], "readonly", (transaction, setResult) => {
    const snapshot = { stocks: [], prices: [] };
    const stocks = transaction.objectStore(STOCKS).getAll();
    const prices = transaction.objectStore(PRICES).getAll();

    stocks.onsuccess = () => {
      snapshot.stocks = stocks.result.map(publicStock);
    };
    prices.onsuccess = () => { snapshot.prices = prices.result; };
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

  return { stocks, prices };
}

export async function replaceSnapshot(db, snapshot) {
  const replacement = validateSnapshot(snapshot);

  return runTransaction(db, [STOCKS, PRICES], "readwrite", (transaction) => {
    const stocks = transaction.objectStore(STOCKS);
    const prices = transaction.objectStore(PRICES);
    stocks.clear();
    prices.clear();

    for (const stock of replacement.stocks) {
      stocks.add({ ...stock, nameKey: nameKey(stock.name) });
    }
    for (const price of replacement.prices) {
      prices.add(price);
    }
  });
}

export function serializeBackup({ stocks, prices }) {
  return JSON.stringify({ version: BACKUP_VERSION, stocks, prices }, null, 2);
}

export function parseBackup(text) {
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("백업 파일을 읽을 수 없어요. JSON 백업 파일을 선택해 주세요.");
  }
  if (value?.version !== BACKUP_VERSION) {
    throw new Error("지원하는 백업 파일 형식이 아니에요.");
  }
  return validateSnapshot(value);
}
