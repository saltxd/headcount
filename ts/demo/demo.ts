/**
 * npm run demo: one reward round, start to finish, on a local NEAR sandbox, told step by step.
 *
 * Its predemo script builds the contracts and puts the sandbox in place, the same steps npm test
 * runs first. Every step is checked as it runs (ts/demo/story.ts); the demo exits with an error if
 * one does not do what it says.
 */

import { runDemo } from "./story.ts";

console.log("Headcount: one reward round, start to finish, on a local NEAR sandbox");
console.log("Every account below is a throwaway on a sandbox chain running on this machine:");
console.log("no real network, keys or funds.");

try {
  const result = await runDemo((line = "") => console.log(line));
  console.log();
  console.log(`Done in ${result.seconds} s. Every step above was checked as it ran: a mismatch would have`);
  console.log("stopped the demo with an error.");
} catch (error) {
  console.error();
  console.error(`The demo stopped: ${(error as Error).stack ?? String(error)}`);
  process.exitCode = 1;
}
