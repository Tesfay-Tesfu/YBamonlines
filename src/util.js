// CSV writer (Excel-friendly, with BOM) and small helpers.
function csv(rows) {
  const cell = v => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+@\t\r]|^-(?![\d.])/.test(s)) s = "'" + s;           // stop spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
}
module.exports = { csv };
