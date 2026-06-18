import fs from 'fs';

function viewLines() {
  const filePath = './signalEngine.js';
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  const slice = lines.slice(499, 550);
  slice.forEach((line, index) => {
    console.log(`${500 + index}: ${line}`);
  });
}

viewLines();
