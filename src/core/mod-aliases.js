'use strict';

/**
 * QUTC Launcher - MOD 中英文别名
 *
 * 这是一张本地别名表，只用于把常见中文名扩展成英文搜索词。
 * 没有抓取 MC百科 / MINEBBS：它们没有公开稳定的下载 API，直接抓取还涉及授权和恶意文件风险。
 */

const ALIASES = {
  钠: 'sodium',
  sodium: '钠',
  锂: 'lithium',
  lithium: '锂',
  磷: 'phosphor',
  phosphor: '磷',
  铷: 'rubidium',
  rubidium: '铷',
  物品管理器: 'jei',
  jei: '物品管理器',
  合成表: 'jei',
  'just enough items': '物品管理器',
  模组菜单: 'mod menu',
  'mod menu': '模组菜单',
  modmenu: 'mod menu',
  光影: 'iris shaders',
  iris: '光影',
  'iris shaders': '光影',
  小地图: 'xaero minimap',
  xaero: '小地图',
  机械动力: 'create',
  create: '机械动力',
  农夫乐事: 'farmers delight',
  'farmers delight': '农夫乐事',
  苹果皮: 'appleskin',
  appleskin: '苹果皮',
  玉: 'jade',
  jade: '玉',
  钠额外: 'sodium extra',
  'sodium extra': '钠额外',
  旅行地图: 'journeymap',
  journeymap: '旅行地图',
  传送石碑: 'waystones',
  waystones: '传送石碑',
  精妙背包: 'sophisticated backpacks',
  'sophisticated backpacks': '精妙背包',
  储物抽屉: 'storage drawers',
  'storage drawers': '储物抽屉',
  应用能源: 'applied energistics 2',
  ae2: 'applied energistics 2',
  'applied energistics': '应用能源',
  精致存储: 'refined storage',
  'refined storage': '精致存储',
  通用机械: 'mekanism',
  mekanism: '通用机械',
  沉浸工程: 'immersive engineering',
  'immersive engineering': '沉浸工程',
  植物魔法: 'botania',
  botania: '植物魔法',
  暮色森林: 'twilight forest',
  'twilight forest': '暮色森林',
  匠魂: 'tinkers construct',
  'tinkers construct': '匠魂',
  等价交换: 'projecte',
  projecte: '等价交换',
  创世神: 'worldedit',
  worldedit: '创世神',
  星辉魔法: 'astral sorcery',
  'astral sorcery': '星辉魔法',
  血魔法: 'blood magic',
  'blood magic': '血魔法',
  工业时代: 'industrial craft',
  'industrial craft': '工业时代',
  星系: 'galacticraft',
  galacticraft: '星系',
};

function expandModQuery(query) {
  const base = String(query || '').trim().slice(0, 120);
  if (!base) return [];
  const lower = base.toLowerCase();
  const out = [base];
  for (const [key, value] of Object.entries(ALIASES)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      if (!out.includes(value)) out.push(value);
    }
    if (out.length >= 4) break;
  }
  return out.slice(0, 4);
}

module.exports = { ALIASES, expandModQuery };
