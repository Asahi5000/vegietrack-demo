import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// Re-exported here so existing `import { formatCurrencyForPDF } from '../utils/pdfExport'`
// call sites keep working; the canonical implementation lives in utils/currency.js
// alongside the on-screen formatCurrency, since both need the configured currency code.
export { formatCurrencyForPDF } from './currency';

/**
 * Generates a PDF document with a standard header (store name, store address,
 * report title, timestamp) and a table of data, then triggers a browser download.
 *
 * @param {string} title - Report title shown in the PDF header.
 * @param {string[]} columns - Table column headers.
 * @param {Array<Array<string|number>>} rows - Table row data.
 * @param {string} filename - Filename for the downloaded PDF (without extension).
 * @param {string} [subtitle] - Optional subtitle/description shown under the title.
 * @param {object} [storeSettings] - Optional store settings for the PDF header.
 * @param {string} [storeSettings.store_name] - Store name to display in the header.
 * @param {string} [storeSettings.store_address] - Store address to display in the header.
 */
export function exportTableToPDF(title, columns, rows, filename, subtitle, storeSettings) {
  const doc = new jsPDF();

  const storeName = storeSettings?.store_name || 'VegieTrack';
  const storeAddress = storeSettings?.store_address;

  let yPos = 18;

  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  doc.text(storeName, 14, yPos);

  if (storeAddress) {
    yPos += 6;
    doc.setFontSize(8);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(120);
    doc.text(storeAddress, 14, yPos);
    doc.setTextColor(0);
  }

  yPos += 8;
  doc.setFontSize(12);
  doc.setFont(undefined, 'normal');
  doc.text(title, 14, yPos);

  let startY = yPos + 6;

  if (subtitle) {
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.text(subtitle, 14, startY);
    doc.setTextColor(0);
    startY += 6;
  }

  doc.setFontSize(8);
  doc.setTextColor(120);
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, startY);
  doc.setTextColor(0);
  startY += 6;

  autoTable(doc, {
    head: [columns],
    body: rows,
    startY,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [37, 99, 235] },
    alternateRowStyles: { fillColor: [245, 247, 250] },
  });

  doc.save(`${filename}.pdf`);
}
