export const FIRST_MONTH = "1998-03";
export const INITIAL_LAST_MONTH = "2026-11";

const LAST_SUPPORTED_MONTH = "9999-12";
const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const EMPTY_VALUE = "—";
const priceFormatter = new Intl.NumberFormat("ko-KR");
const nameCollator = new Intl.Collator("ko-KR");

export function isValidMonth(month) {
  return typeof month === "string" && MONTH_PATTERN.test(month)
    && month >= FIRST_MONTH && month <= LAST_SUPPORTED_MONTH;
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

export function shiftMonth(month, offset) {
  if (!isValidMonth(month) || !Number.isInteger(offset)) return null;

  const index = monthIndex(month) + offset;
  if (index < firstMonthIndex || index > lastMonthIndex) return null;

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

export function buildMarketView(snapshot, month, sortMode = "name") {
  const nextMonth = shiftMonth(month, 1);
  const currentPrices = new Map();
  const nextPrices = new Map();

  for (const record of snapshot.prices) {
    if (record.month === month) currentPrices.set(record.stockId, record.price);
    if (record.month === nextMonth) nextPrices.set(record.stockId, record.price);
  }

  const rows = snapshot.stocks.map(({ id, name }) => {
    const currentPrice = currentPrices.get(id) ?? null;
    const nextPrice = nextPrices.get(id) ?? null;
    return { id, name, currentPrice, nextPrice, rate: calculateRate(currentPrice, nextPrice) };
  });

  const ranked = rows.filter((row) => row.rate != null);
  ranked.sort((a, b) => compareRowsByRate(a, b, -1));
  const bestRate = ranked[0]?.rate;
  const leaders = ranked.filter((row) => compareDisplayedRate(row.rate, bestRate) === 0);

  if (sortMode === "name") rows.sort(compareName);
  else rows.sort((a, b) => compareRowsByRate(a, b, sortMode === "asc" ? 1 : -1));

  return { rows, leaders };
}
