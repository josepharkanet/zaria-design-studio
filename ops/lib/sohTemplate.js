import ExcelJS from 'exceljs';

// The template mirrors the warehouse ERP's own Stock-On-Hand export, column for column, so a
// sheet straight out of the ERP can be uploaded untouched and nobody has to reshape anything.
//
// Only two columns are read on import: the item code in "Row Labels" (a barcode or a SKU) and
// the figure in "Sum of Inventoried Quantity". Product and Product Category are carried because
// the ERP emits them and they make the sheet readable; both are ignored, since that information
// already lives on the product in Shopify.
//
// The example rows use codes that cannot exist in the catalogue, so uploading the template
// untouched matches nothing and changes nothing: it just shows up as skipped in the report.
const HEADERS = ['Row Labels', 'Product', 'Product Category', 'Sum of Inventoried Quantity'];
const WIDTHS = [16.6, 50, 34, 23.2];
const EXAMPLES = [
  ['0000000000001', 'EXAMPLE ROW: replace these with the ERP export', 'Fragrances', 12],
  ['0000000000002', 'EXAMPLE ROW: a 0 here marks the item sold out', 'Fragrances', 0],
];

export async function buildSohTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zaria Operations';
  const ws = wb.addWorksheet('Sheet1');

  ws.addRow(HEADERS);
  EXAMPLES.forEach((r) => ws.addRow(r));

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle' };
  head.height = 20;
  ws.columns = WIDTHS.map((width) => ({ width }));
  // Codes are text, not numbers — keep Excel from rewriting long barcodes as 3.76E+12.
  ws.getColumn(1).numFmt = '@';
  ws.getColumn(4).alignment = { horizontal: 'right' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'D1' };

  for (const r of EXAMPLES.map((_, i) => ws.getRow(i + 2))) {
    r.font = { italic: true, color: { argb: 'FF999999' } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
