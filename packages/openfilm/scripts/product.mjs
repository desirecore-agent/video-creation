#!/usr/bin/env node
// Retained entry point for source compatibility. This fork never selects upstream product metadata.
if (process.argv[2] !== 'restore') {
  console.error('视频创作 uses its own product.json and is managed by DesireCore; official OpenFilm packaging is disabled.');
  process.exitCode = 2;
}
