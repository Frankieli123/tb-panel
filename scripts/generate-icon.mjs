#!/usr/bin/env node
/**
 * 淘宝 Agent 图标生成器
 * 设计理念: 购物袋 + 价格标签 + 监控眼睛的组合
 * 主色: 橙色(淘宝品牌色) + 深灰
 */

import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(__dirname, '..', 'tray', 'TaobaoAgentTray', 'Resources');

// 确保输出目录存在
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

function drawIcon(ctx, size) {
  const scale = size / 256;
  ctx.save();
  ctx.scale(scale, scale);
  
  // 背景 - 圆角矩形
  ctx.beginPath();
  const radius = 40;
  ctx.moveTo(radius, 0);
  ctx.lineTo(256 - radius, 0);
  ctx.quadraticCurveTo(256, 0, 256, radius);
  ctx.lineTo(256, 256 - radius);
  ctx.quadraticCurveTo(256, 256, 256 - radius, 256);
  ctx.lineTo(radius, 256);
  ctx.quadraticCurveTo(0, 256, 0, 256 - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
  
  // 渐变背景 - 淘宝橙色
  const gradient = ctx.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, '#FF6B35');
  gradient.addColorStop(1, '#F7931E');
  ctx.fillStyle = gradient;
  ctx.fill();
  
  // 购物袋主体
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.moveTo(55, 95);
  ctx.lineTo(70, 220);
  ctx.quadraticCurveTo(72, 235, 87, 235);
  ctx.lineTo(169, 235);
  ctx.quadraticCurveTo(184, 235, 186, 220);
  ctx.lineTo(201, 95);
  ctx.closePath();
  ctx.fill();
  
  // 购物袋手柄
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(95, 95);
  ctx.quadraticCurveTo(95, 45, 128, 45);
  ctx.quadraticCurveTo(161, 45, 161, 95);
  ctx.stroke();
  
  // 价格标签 ¥ 符号
  ctx.fillStyle = '#FF6B35';
  ctx.font = 'bold 85px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('¥', 128, 168);
  
  // 右下角状态指示器底座
  ctx.beginPath();
  ctx.arc(210, 210, 35, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  
  // 状态指示器 - 默认绿色表示监控中
  ctx.beginPath();
  ctx.arc(210, 210, 25, 0, Math.PI * 2);
  ctx.fillStyle = '#22C55E';
  ctx.fill();
  
  ctx.restore();
}

function drawTrayIcon(ctx, size, statusColor) {
  const scale = size / 16;
  ctx.save();
  ctx.scale(scale, scale);
  
  // 简化版托盘图标 - 购物袋轮廓
  ctx.fillStyle = statusColor;
  
  // 圆形背景
  ctx.beginPath();
  ctx.arc(8, 8, 7, 0, Math.PI * 2);
  ctx.fill();
  
  // 白色 ¥ 符号
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 9px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('¥', 8, 9);
  
  ctx.restore();
}

// 生成主图标 (多尺寸)
const sizes = [16, 32, 48, 64, 128, 256];
const icons = [];

for (const size of sizes) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  drawIcon(ctx, size);
  
  const pngPath = path.join(outputDir, `icon-${size}.png`);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(pngPath, buffer);
  icons.push({ size, buffer });
  console.log(`Generated: icon-${size}.png`);
}

// 生成主 256x256 图标
const mainCanvas = createCanvas(256, 256);
const mainCtx = mainCanvas.getContext('2d');
drawIcon(mainCtx, 256);
fs.writeFileSync(path.join(outputDir, 'app-icon.png'), mainCanvas.toBuffer('image/png'));
console.log('Generated: app-icon.png');

// 生成状态托盘图标
const statusColors = {
  'red': '#EF4444',
  'yellow': '#F59E0B', 
  'green': '#22C55E'
};

for (const [name, color] of Object.entries(statusColors)) {
  for (const size of [16, 32]) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    drawTrayIcon(ctx, size, color);
    
    const pngPath = path.join(outputDir, `tray-${name}-${size}.png`);
    fs.writeFileSync(pngPath, canvas.toBuffer('image/png'));
    console.log(`Generated: tray-${name}-${size}.png`);
  }
}

console.log('\n✅ All icons generated in:', outputDir);
console.log('\nNext steps:');
console.log('1. Use an online converter (like convertio.co) to convert app-icon.png to .ico');
console.log('2. Or install png-to-ico: npm install -g png-to-ico');
