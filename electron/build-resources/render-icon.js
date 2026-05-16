#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_PNG = path.join(__dirname, 'icon.png');
const FAVICON_DIR = path.join(__dirname, '..', '..', '..', '..', 'constellation-engine-web');

(async () => {
  const altDir = '/home/devin/constellation-engine-web';
  const targets = [FAVICON_DIR, altDir].filter(d => fs.existsSync(d));
  for (const dir of targets) {
    const out = path.join(dir, 'favicon.png');
    await sharp(SRC_PNG).resize(256, 256).png().toFile(out);
    console.log('wrote', out);
  }
})().catch(e => { console.error(e); process.exit(1); });
