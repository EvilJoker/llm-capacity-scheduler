#!/usr/bin/env node
import { main } from "../dist/cli.js";

main().catch((error) => {
  console.error("[lcs] FATAL", error);
  process.exit(1);
});
