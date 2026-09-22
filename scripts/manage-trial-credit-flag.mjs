#!/usr/bin/env node
import { publicAction, publicErrorCode, runFlagOperation } from "./trial-credit-flag-lib.mjs";

const action = publicAction(process.argv[2]);

try {
  const result = await runFlagOperation({
    args: process.argv.slice(2),
    env: process.env,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    action,
    status: "failed",
    error: publicErrorCode(error),
  })}\n`);
  process.exitCode = 1;
}
