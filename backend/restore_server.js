import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverJsPath = path.join(__dirname, 'server.js');

let code = fs.readFileSync(serverJsPath, 'utf8');

const lines = code.split('\n');
for (let i = 4230; i <= 4500; i++) {
  if (i - 1 < lines.length) {
    console.log(`${i}: ${lines[i - 1]}`);
  }
}
