#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).catch((err) => {
  console.error(`computer-mcp: ${err.message}`);
  process.exit(1);
});
