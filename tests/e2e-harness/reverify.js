/* Re-run the verifier against an already-produced file (no app cycle). */
'use strict';
const fs = require('fs');
const path = require('path');
const { verdict } = require('./lib/verify');

const [, , scenarioName, filePath] = process.argv;
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, 'work', 'scenarios', `${scenarioName}.json`), 'utf8'));
const v = verdict(filePath, meta, { tailLossMaxS: 8 });
console.log(v.pass ? 'PASS' : 'FAIL');
for (const n of v.notes) console.log('  note:', n);
for (const p of v.problems) console.log('  PROBLEM:', p);
