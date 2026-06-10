import fs from 'fs';
const content = fs.readFileSync('src/services/prompt-engine.ts', 'utf8');
const lines = content.split('\n');

function printLine(num) {
  const line = lines[num - 1];
  console.log(`\nLine ${num} raw:`, line);
  console.log(`Line ${num} char codes:`, line.split('').map(c => `${c}:${c.charCodeAt(0)}`).join(' '));
}

printLine(40);
printLine(45);
printLine(186);
printLine(189);
printLine(217);
printLine(226);
