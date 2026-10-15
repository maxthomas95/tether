// Deterministic local CLI for the packaged-app smoke. No credentials or services.
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();

let line = '';
process.stdout.write('TETHER_SMOKE_READY\r\n');
process.stdin.on('data', data => {
  for (const char of data) {
    if (char === '\r' || char === '\n') {
      process.stdout.write(`\r\nTETHER_SMOKE_ECHO:${line}\r\n`);
      line = '';
    } else {
      line += char;
      process.stdout.write(char);
    }
  }
});
process.stdout.on('resize', () => {
  process.stdout.write(`\r\nTETHER_SMOKE_SIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`);
});
