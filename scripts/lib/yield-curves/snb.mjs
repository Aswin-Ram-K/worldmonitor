// Swiss National Bank daily spot rates on Confederation bonds
// (Nelson–Siegel–Svensson fitted). Cube rendeiduebd, ~14 MB CSV with a
// two-row metadata preamble. Columns: Date;D0;D1;Value. D0="CHF" selects the
// CHF Confederation-bond spot curve; every other D0 value (EUR, KTA, KTB,
// PFI, GBA…) is a different instrument and must be excluded. D1 is the tenor
// in years with a J suffix (1J … 10J, 20J, 30J).

import { normalizeDateLabel, parseYieldNumber, collapseCurves } from './model.mjs';

export const SNB_CONFEDERATION_D0 = 'CHF';

export const SNB_TENORS = {
  '1J': '1y', '2J': '2y', '3J': '3y', '4J': '4y', '5J': '5y', '6J': '6y',
  '7J': '7y', '8J': '8y', '9J': '9y', '10J': '10y', '20J': '20y', '30J': '30y',
};

export function parseSnbRendeiduebdCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.replace(/"/g, '').startsWith('Date;D0;D1;Value'));
  if (headerIndex === -1) return [];
  const byDate = new Map();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const cells = line.split(';').map((cell) => cell.replace(/"/g, '').trim());
    if (cells.length < 4) continue;
    if (cells[1] !== SNB_CONFEDERATION_D0) continue;
    const tenor = Object.prototype.hasOwnProperty.call(SNB_TENORS, cells[2]) ? SNB_TENORS[cells[2]] : null;
    if (!tenor) continue;
    const date = normalizeDateLabel(cells[0] ?? '');
    const value = parseYieldNumber(cells[3]);
    if (!date || value == null) continue;
    const point = byDate.get(date) ?? { date, tenors: {} };
    point.tenors[tenor] = value;
    byDate.set(date, point);
  }
  return collapseCurves([...byDate.values()]);
}
