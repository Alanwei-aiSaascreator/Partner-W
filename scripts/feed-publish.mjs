#!/usr/bin/env node

import { createFeedTransport, runCli } from './lib/feed-publish-cli.mjs';

await runCli(process.argv.slice(2), { createTransport: createFeedTransport }).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
