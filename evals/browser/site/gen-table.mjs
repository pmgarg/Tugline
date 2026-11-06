// Generates table.html: a deterministic 300-row inventory table with a client-side filter.
// Run: node evals/browser/site/gen-table.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const kinds = ['Widget', 'Gadget', 'Sprocket', 'Gizmo', 'Doohickey'];
const sites = ['Dubai', 'Pune', 'Austin', 'Leeds', 'Osaka'];
let rows = '';
for (let i = 1; i <= 300; i++) {
  const kind = kinds[i % kinds.length];
  const qty = (i * 37) % 101;
  const price = ((i * 53) % 9000) / 100 + 1;
  rows += `<tr><td>${String(i).padStart(3, '0')}</td><td>${kind} ${i}</td><td>${sites[(i * 7) % sites.length]}</td><td>${qty}</td><td>${price.toFixed(2)}</td></tr>\n`;
}
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Inventory</title><link rel="stylesheet" href="style.css"></head>
<body>
<main>
<h1>Inventory</h1>
<p><label for="filter">Filter by item</label> <input id="filter" type="search" placeholder="e.g. Gizmo"> <span id="count" role="status">300 rows</span></p>
<table id="inv" aria-label="Inventory">
<thead><tr><th>SKU</th><th>Item</th><th>Warehouse</th><th>Qty</th><th>Price</th></tr></thead>
<tbody>
${rows}</tbody>
</table>
</main>
<script>
const f = document.getElementById('filter');
f.addEventListener('input', () => {
  const q = f.value.trim().toLowerCase(); let n = 0;
  for (const tr of document.querySelectorAll('#inv tbody tr')) { const show = !q || tr.children[1].textContent.toLowerCase().includes(q); tr.hidden = !show; if (show) n++; }
  document.getElementById('count').textContent = n + ' rows';
});
</script>
</body></html>
`;
fs.writeFileSync(path.join(here, 'table.html'), html);
