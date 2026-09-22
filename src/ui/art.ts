// 程序化 SVG 牌面生成：每张卡按 id 稳定生成独特的纹章式牌面，无需外部图片资源。
import type { CharDef, ItemDef } from "../engine/types";

function hueOf(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return (h * 47) % 360;
}

function svgOpen(id: string): string {
  return `<svg viewBox="0 0 120 150" xmlns="http://www.w3.org/2000/svg" class="card-art" role="img" data-art="${id}">`;
}

/** 角色牌面：领域色渐变 + 纹章环 + 名字首字 */
export function charArt(def: CharDef): string {
  const hue = hueOf(def.id);
  const h2 = (hue + 40) % 360;
  const gid = `g-${def.id}`;
  const glyph = def.name.charAt(0);
  const ringColor = `hsl(${hue} 70% 72% / 0.75)`;
  return `${svgOpen(def.id)}
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 45% 24%)"/>
      <stop offset="1" stop-color="hsl(${h2} 55% 12%)"/>
    </linearGradient>
  </defs>
  <rect width="120" height="150" rx="10" fill="url(#${gid})"/>
  <circle cx="60" cy="66" r="40" fill="none" stroke="${ringColor}" stroke-width="1.5"/>
  <circle cx="60" cy="66" r="31" fill="none" stroke="${ringColor}" stroke-width="0.8" stroke-dasharray="4 5"/>
  <circle cx="60" cy="66" r="22" fill="hsl(${hue} 70% 60% / 0.18)"/>
  <path d="M60 20 L74 44 L46 44 Z" fill="hsl(${hue} 80% 70% / 0.5)"/>
  <path d="M60 112 L74 88 L46 88 Z" fill="hsl(${hue} 80% 70% / 0.3)"/>
  <text x="60" y="82" text-anchor="middle" font-size="46" font-weight="800"
    font-family="'Noto Serif SC','Microsoft YaHei',serif" fill="hsl(${hue} 90% 88%)">${glyph}</text>
  <rect x="6" y="6" width="108" height="138" rx="7" fill="none" stroke="hsl(${hue} 60% 70% / 0.5)" stroke-width="1.5"/>
</svg>`;
}

/** 道具牌面：菱形纹章 + 名字首字 */
export function itemArt(def: ItemDef): string {
  const hue = hueOf(def.id);
  const gid = `gi-${def.id}`;
  const glyph = def.name.charAt(0);
  return `${svgOpen(def.id)}
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 30% 20%)"/>
      <stop offset="1" stop-color="hsl(${hue} 40% 10%)"/>
    </linearGradient>
  </defs>
  <rect width="120" height="150" rx="10" fill="url(#${gid})"/>
  <rect x="60" y="30" width="60" height="60" transform="rotate(45 60 60)" fill="hsl(${hue} 60% 55% / 0.22)"/>
  <rect x="60" y="40" width="40" height="40" transform="rotate(45 60 60)" fill="none" stroke="hsl(${hue} 70% 70% / 0.65)" stroke-width="1.5"/>
  <text x="60" y="76" text-anchor="middle" font-size="34" font-weight="800"
    font-family="'Noto Serif SC','Microsoft YaHei',serif" fill="hsl(${hue} 85% 85%)">${glyph}</text>
  <rect x="6" y="6" width="108" height="138" rx="7" fill="none" stroke="hsl(${hue} 50% 60% / 0.45)" stroke-width="1.5"/>
</svg>`;
}

/** 场上角色小头像：只取牌面中心纹章 */
export function charThumb(id: string, name: string): string {
  const hue = hueOf(id);
  const gid = `gt-${id}`;
  return `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" class="char-thumb" data-art="${id}">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 45% 26%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360} 55% 13%)"/>
    </linearGradient>
  </defs>
  <rect width="80" height="80" rx="8" fill="url(#${gid})"/>
  <circle cx="40" cy="40" r="27" fill="none" stroke="hsl(${hue} 70% 72% / 0.7)" stroke-width="1.5"/>
  <circle cx="40" cy="40" r="19" fill="hsl(${hue} 70% 60% / 0.2)"/>
  <text x="40" y="52" text-anchor="middle" font-size="30" font-weight="800"
    font-family="'Noto Serif SC','Microsoft YaHei',serif" fill="hsl(${hue} 90% 88%)">${name.charAt(0)}</text>
</svg>`;
}
