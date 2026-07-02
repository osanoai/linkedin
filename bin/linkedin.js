#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`Error: ${err && err.message ? err.message : err}`);
    process.exit(typeof err?.exitCode === 'number' ? err.exitCode : 1);
  }
);
