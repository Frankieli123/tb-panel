#!/usr/bin/env node
/**
 * Convert PNG icons to ICO format
 */

import pngToIco from 'png-to-ico';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resourceDir = path.join(__dirname, '..', 'tray', 'TaobaoAgentTray', 'Resources');

async function convert() {
  // 主应用图标 - 包含多尺寸
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngFiles = sizes.map(s => path.join(resourceDir, `icon-${s}.png`));
  
  // 检查文件存在
  for (const f of pngFiles) {
    if (!fs.existsSync(f)) {
      console.error('Missing:', f);
      process.exit(1);
    }
  }
  
  // 生成主 ICO
  const mainIco = await pngToIco(pngFiles);
  fs.writeFileSync(path.join(resourceDir, 'app.ico'), mainIco);
  console.log('Generated: app.ico');
  
  // 生成托盘图标 ICO (16x16 + 32x32)
  for (const status of ['red', 'yellow', 'green']) {
    const trayPngs = [16, 32].map(s => path.join(resourceDir, `tray-${status}-${s}.png`));
    const trayIco = await pngToIco(trayPngs);
    fs.writeFileSync(path.join(resourceDir, `tray-${status}.ico`), trayIco);
    console.log(`Generated: tray-${status}.ico`);
  }
  
  console.log('\n✅ All ICO files generated!');
}

convert().catch(console.error);
