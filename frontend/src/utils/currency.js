// Maps ISO-4217-ish currency codes (as configured in Settings) to display symbols.
// Falls back to showing the raw code (e.g. "XYZ 12.00") for anything not listed.
const CURRENCY_SYMBOLS = {
  PHP: '₱',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  CNY: '¥',
  KRW: '₩',
  INR: '₹',
};

/**
 * Returns the display symbol for a currency code, defaulting to the code itself
 * (with a trailing space) if no symbol mapping is known.
 * @param {string} code - Currency code, e.g. "PHP", "USD".
 */
export function getCurrencySymbol(code) {
  const normalized = (code || 'PHP').toUpperCase();
  return CURRENCY_SYMBOLS[normalized] || `${normalized} `;
}

/**
 * Formats a value for on-screen display using the configured currency's symbol.
 * @param {number|string} val - Value to format.
 * @param {string} currency - Currency code from Settings (e.g. "PHP").
 */
export function formatCurrency(val, currency) {
  const symbol = getCurrencySymbol(currency);
  return `${symbol}${Number(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formats a value for use inside PDF documents. jsPDF's default fonts
 * (Helvetica/Times/Courier) only support a limited character set, so currency
 * symbols like ₱, €, ₹, ₩ render as garbled characters. The currency code
 * (e.g. "PHP", "USD") is used instead to stay safely within that character set.
 * @param {number|string} val - Value to format.
 * @param {string} currency - Currency code from Settings (e.g. "PHP").
 */
export function formatCurrencyForPDF(val, currency) {
  const code = (currency || 'PHP').toUpperCase();
  return `${code} ${Number(val || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
