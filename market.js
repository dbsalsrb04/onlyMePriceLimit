export const FIRST_MONTH = "1998-03";
export const LAST_ISSUED_SHARES_MONTH = "2026-10";
export const FIRST_BET_MONTH = "1998-01";
export const INITIAL_LAST_MONTH = "2026-11";

const LAST_SUPPORTED_MONTH = "9999-12";
const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const EMPTY_VALUE = "—";
const priceFormatter = new Intl.NumberFormat("ko-KR");
const nameCollator = new Intl.Collator("ko-KR");

export function isValidMonth(month, firstMonth = FIRST_MONTH) {
  return typeof month === "string" && MONTH_PATTERN.test(month)
    && month >= firstMonth && month <= LAST_SUPPORTED_MONTH;
}

function monthIndex(month) {
  const [year, number] = month.split("-").map(Number);
  return year * 12 + number - 1;
}

function monthFromIndex(index) {
  const year = Math.floor(index / 12);
  const month = String(index % 12 + 1).padStart(2, "0");
  return `${year}-${month}`;
}

const firstMonthIndex = monthIndex(FIRST_MONTH);
const lastMonthIndex = monthIndex(LAST_SUPPORTED_MONTH);

export function shiftMonth(month, offset, firstMonth = FIRST_MONTH) {
  if (!isValidMonth(month, firstMonth) || !Number.isInteger(offset)) return null;

  const index = monthIndex(month) + offset;
  if (index < monthIndex(firstMonth) || index > lastMonthIndex) return null;

  return monthFromIndex(index);
}

export function listMonths(throughMonth = INITIAL_LAST_MONTH) {
  const months = [];
  if (!isValidMonth(throughMonth)) return months;

  const endIndex = monthIndex(throughMonth);
  for (let index = firstMonthIndex; index <= endIndex; index += 1) {
    months.push(monthFromIndex(index));
  }
  return months;
}

export function formatMonth(month) {
  const [year, number] = month.split("-");
  return `${year}년 ${Number(number)}월`;
}

export function formatPrice(price) {
  return price == null ? EMPTY_VALUE : `${priceFormatter.format(price)}원`;
}

export function formatIssuedShares(value) {
  return value == null ? EMPTY_VALUE : `${priceFormatter.format(value)}주`;
}

function formatScaledInteger(value, divisor, places, unit) {
  const scale = 10n ** BigInt(places);
  const rounded = (value * scale + divisor / 2n) / divisor;
  const fraction = (rounded % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return `${rounded / scale}${fraction ? `.${fraction}` : ""}${unit}`;
}

function formatKoreanUnits(value, places, suffix = "") {
  if (value == null) return EMPTY_VALUE;
  const amount = BigInt(value);
  if (amount >= 1_000_000_000_000n) return formatScaledInteger(amount, 1_000_000_000_000n, places, "조" + suffix);
  if (amount >= 100_000_000n) return formatScaledInteger(amount, 100_000_000n, places, "억" + suffix);
  if (amount >= 10_000n) return formatScaledInteger(amount, 10_000n, places, "만" + suffix);
  return `${amount}${suffix}`;
}

export function formatCompactIssuedShares(value) {
  return formatKoreanUnits(value, 2, " 주");
}

export function formatMarketCap(value) {
  return formatKoreanUnits(value, 1);
}

export function formatMarketCapChange(value) {
  if (value == null) return EMPTY_VALUE;
  const sign = value < 0n ? "−" : value > 0n ? "+" : "";
  const magnitude = value < 0n ? -value : value;
  return `${sign}${formatMarketCap(magnitude)}원`;
}

export function issuedSharesRecordAt(history, month) {
  if (!month || month < FIRST_MONTH || month > LAST_ISSUED_SHARES_MONTH) return undefined;
  return history?.findLast((record) => record.month <= month);
}

function calculateMarketCap(issuedShares, price) {
  if (issuedShares == null || price == null) return null;
  return BigInt(issuedShares) * BigInt(price);
}

export function calculateRate(currentPrice, nextPrice) {
  if (!Number.isSafeInteger(currentPrice) || currentPrice <= 0
    || !Number.isSafeInteger(nextPrice) || nextPrice < 0) return null;

  const base = BigInt(currentPrice);
  const change = BigInt(nextPrice) - base;
  const sign = Math.sign(nextPrice - currentPrice);
  const magnitude = (change < 0n ? -change : change) * 100n;
  const roundedHundredths = (magnitude * 200n + base) / (base * 2n);
  const thousandths = (magnitude * 1_000n) / base;

  return {
    sign,
    hundredths: roundedHundredths * BigInt(sign),
    thousandths: thousandths * BigInt(sign),
  };
}

export function formatRate(rate) {
  if (rate == null) return EMPTY_VALUE;

  const sign = rate.sign < 0 ? "−" : rate.sign > 0 ? "+" : "";
  const magnitude = rate.hundredths < 0n ? -rate.hundredths : rate.hundredths;
  const fraction = String(magnitude % 100n).padStart(2, "0");
  return `${sign}${magnitude / 100n}.${fraction}%`;
}

export function rateTone(rate) {
  if (rate == null) return "unknown";
  if (rate.sign > 0) return "up";
  if (rate.sign < 0) return "down";
  return "flat";
}

function compareName(a, b) {
  return nameCollator.compare(a.name, b.name);
}

function compareInteger(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareDisplayedRate(a, b) {
  return compareInteger(a.hundredths, b.hundredths) || a.sign - b.sign;
}

function compareRowsByRate(a, b, direction) {
  if (a.rate == null) return b.rate == null ? compareName(a, b) : 1;
  if (b.rate == null) return -1;

  const rateOrder = compareDisplayedRate(a.rate, b.rate)
    || compareInteger(a.rate.thousandths, b.rate.thousandths);
  return rateOrder * direction || compareName(a, b);
}

function compareOptionalInteger(a, b, direction) {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return compareInteger(a, b) * direction;
}

export function buildMarketView(snapshot, month, sortMode = "name", marketCapSort = null) {
  const nextMonth = shiftMonth(month, 1, FIRST_BET_MONTH);
  const currentPrices = new Map();
  const nextPrices = new Map();

  for (const record of snapshot.prices) {
    if (record.month === month) currentPrices.set(record.stockId, record.price);
    if (record.month === nextMonth) nextPrices.set(record.stockId, record.price);
  }

  const rows = snapshot.stocks.map(({ id, name, issuedSharesHistory }) => {
    const currentPrice = currentPrices.get(id) ?? null;
    const nextPrice = nextPrices.get(id) ?? null;
    const issuedShares = issuedSharesRecordAt(issuedSharesHistory, month)?.value ?? null;
    const nextIssuedShares = issuedSharesRecordAt(issuedSharesHistory, nextMonth)?.value ?? null;
    const currentMarketCap = calculateMarketCap(issuedShares, currentPrice);
    const nextMarketCap = calculateMarketCap(nextIssuedShares, nextPrice);
    const marketCapChange = currentMarketCap != null && nextMarketCap != null ? nextMarketCap - currentMarketCap : null;
    return {
      id, name, issuedShares, currentPrice, nextPrice,
      currentMarketCap, nextMarketCap, marketCapChange,
      rate: calculateRate(currentPrice, nextPrice),
    };
  });

  const ranked = rows.filter((row) => row.rate != null);
  ranked.sort((a, b) => compareRowsByRate(a, b, -1));
  const bestRate = ranked[0]?.rate;
  const leaders = ranked.filter((row) => compareDisplayedRate(row.rate, bestRate) === 0);
  const bestMarketCapChange = rows.reduce((best, { marketCapChange }) => {
    if (marketCapChange == null) return best;
    return best == null || marketCapChange > best ? marketCapChange : best;
  }, null);
  const marketCapLeaders = bestMarketCapChange == null ? []
    : rows.filter(({ marketCapChange }) => marketCapChange === bestMarketCapChange).sort(compareName);

  const compareBaseOrder = sortMode === "name"
    ? compareName
    : (a, b) => compareRowsByRate(a, b, sortMode === "asc" ? 1 : -1);
  const capChangeSort = marketCapSort && sortMode !== "name";
  const capField = capChangeSort ? "marketCapChange" : "nextMarketCap";
  const marketCapDirection = !capChangeSort && marketCapSort === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const capOrder = marketCapSort ? compareOptionalInteger(a[capField], b[capField], marketCapDirection) : 0;
    return capOrder || compareBaseOrder(a, b);
  });

  return { rows, leaders, marketCapLeaders };
}
