/**
 * People of the eight cities, a few years from now. Names come from common family and given
 * names of each place, in its script with a romanisation. Codenames are Kuroko's own.
 */
import type { Rng } from "./rng.js";

export type City = "taipei" | "hongkong" | "osaka" | "busan" | "singapore" | "bangkok" | "hcmc" | "manila";
export const CITIES: readonly City[] = ["taipei", "hongkong", "osaka", "busan", "singapore", "bangkok", "hcmc", "manila"];

export interface Person {
  readonly native: string;
  readonly roman: string;
}

type Pair = readonly [string, string];

const CANTONESE_FAMILY: Pair[] = [["陳", "Chan"], ["李", "Lee"], ["黃", "Wong"], ["張", "Cheung"], ["梁", "Leung"], ["林", "Lam"], ["劉", "Lau"], ["吳", "Ng"], ["何", "Ho"], ["鄧", "Tang"]];
const CANTONESE_GIVEN: Pair[] = [["家明", "Ka-ming"], ["志強", "Chi-keung"], ["美玲", "Mei-ling"], ["嘉欣", "Ka-yan"], ["子聰", "Tsz-chung"], ["凱晴", "Hoi-ching"], ["浩然", "Ho-yin"], ["曉彤", "Hiu-tung"], ["俊傑", "Chun-kit"], ["詠詩", "Wing-sze"]];
const MANDARIN_FAMILY: Pair[] = [["陳", "Chen"], ["林", "Lin"], ["黃", "Huang"], ["張", "Chang"], ["李", "Li"], ["王", "Wang"], ["吳", "Wu"], ["劉", "Liu"], ["蔡", "Tsai"], ["楊", "Yang"]];
const MANDARIN_GIVEN: Pair[] = [["宥廷", "Yu-ting"], ["品妍", "Pin-yen"], ["承恩", "Cheng-en"], ["子晴", "Tzu-ching"], ["冠宇", "Kuan-yu"], ["詠晴", "Yung-ching"], ["柏翰", "Po-han"], ["思妤", "Szu-yu"], ["宇軒", "Yu-hsuan"], ["家豪", "Chia-hao"]];
const JAPANESE_FAMILY: Pair[] = [["佐藤", "Satō"], ["鈴木", "Suzuki"], ["高橋", "Takahashi"], ["田中", "Tanaka"], ["渡辺", "Watanabe"], ["伊藤", "Itō"], ["山本", "Yamamoto"], ["中村", "Nakamura"], ["小林", "Kobayashi"], ["加藤", "Katō"]];
const JAPANESE_GIVEN: Pair[] = [["蓮", "Ren"], ["陽菜", "Hina"], ["湊", "Minato"], ["結衣", "Yui"], ["大翔", "Hiroto"], ["美咲", "Misaki"], ["蒼", "Aoi"], ["さくら", "Sakura"], ["悠真", "Yūma"], ["凛", "Rin"]];
const KOREAN_FAMILY: Pair[] = [["김", "Kim"], ["이", "Lee"], ["박", "Park"], ["최", "Choi"], ["정", "Jung"], ["강", "Kang"], ["조", "Cho"], ["윤", "Yoon"], ["장", "Jang"], ["임", "Lim"]];
const KOREAN_GIVEN: Pair[] = [["민준", "Min-jun"], ["서연", "Seo-yeon"], ["도윤", "Do-yun"], ["지우", "Ji-woo"], ["하준", "Ha-jun"], ["수아", "Su-a"], ["시우", "Si-woo"], ["예은", "Ye-eun"], ["지호", "Ji-ho"], ["하은", "Ha-eun"]];
const SINGAPORE: Pair[] = [
  ["陈伟明", "Tan Wei Ming"], ["林慧敏", "Lim Hui Min"], ["黄俊杰", "Ng Jun Jie"], ["李佳欣", "Lee Jia Xin"],
  ["Nur Aisyah binti Rahman", "Nur Aisyah binti Rahman"], ["Muhammad Hafiz bin Ismail", "Muhammad Hafiz bin Ismail"],
  ["Priya Raman", "Priya Raman"], ["Arjun Pillai", "Arjun Pillai"], ["Siti Nurhaliza Osman", "Siti Nurhaliza Osman"], ["Daniel Koh", "Daniel Koh"],
];
const THAI_GIVEN: Pair[] = [["สมชาย", "Somchai"], ["นภัสสร", "Napassorn"], ["ธนกร", "Thanakorn"], ["พิมพ์ชนก", "Pimchanok"], ["ณัฐวุฒิ", "Nattawut"], ["กมลชนก", "Kamonchanok"], ["วรพล", "Woraphon"], ["ศิริพร", "Siriporn"]];
const THAI_FAMILY: Pair[] = [["วงศ์สกุล", "Wongsakul"], ["ศรีสุข", "Srisuk"], ["แก้วมณี", "Kaewmanee"], ["บุญมา", "Boonma"], ["จันทร์เพ็ญ", "Chanpen"], ["ทองดี", "Thongdee"]];
const VIET_FAMILY: Pair[] = [["Nguyễn", "Nguyen"], ["Trần", "Tran"], ["Lê", "Le"], ["Phạm", "Pham"], ["Hoàng", "Hoang"], ["Võ", "Vo"], ["Đặng", "Dang"], ["Bùi", "Bui"]];
const VIET_GIVEN: Pair[] = [["Minh Anh", "Minh Anh"], ["Quốc Bảo", "Quoc Bao"], ["Thu Hà", "Thu Ha"], ["Đức Huy", "Duc Huy"], ["Ngọc Lan", "Ngoc Lan"], ["Gia Khang", "Gia Khang"], ["Bảo Ngọc", "Bao Ngoc"], ["Thanh Tùng", "Thanh Tung"]];
const FILIPINO_GIVEN: Pair[] = [["Maria Clara", "Maria Clara"], ["Jose Miguel", "Jose Miguel"], ["Angelica", "Angelica"], ["Paolo", "Paolo"], ["Kristine", "Kristine"], ["Rafael", "Rafael"], ["Bea", "Bea"], ["Carlo", "Carlo"]];
const FILIPINO_FAMILY: Pair[] = [["Santos", "Santos"], ["Reyes", "Reyes"], ["Cruz", "Cruz"], ["Bautista", "Bautista"], ["Dela Cruz", "Dela Cruz"], ["Mendoza", "Mendoza"], ["Villanueva", "Villanueva"], ["Aquino", "Aquino"]];

/** East Asian names put the family name first; Thai, Filipino and Vietnamese romanisations as used locally. */
export function person(rng: Rng, city: City): Person {
  const fg = (f: Pair, g: Pair, sep = ""): Person => ({ native: f[0] + sep + g[0], roman: `${f[1]} ${g[1]}` });
  switch (city) {
    case "hongkong":
      return fg(rng.pick(CANTONESE_FAMILY), rng.pick(CANTONESE_GIVEN));
    case "taipei":
      return fg(rng.pick(MANDARIN_FAMILY), rng.pick(MANDARIN_GIVEN));
    case "osaka":
      return fg(rng.pick(JAPANESE_FAMILY), rng.pick(JAPANESE_GIVEN));
    case "busan":
      return fg(rng.pick(KOREAN_FAMILY), rng.pick(KOREAN_GIVEN));
    case "singapore": {
      const p = rng.pick(SINGAPORE);
      return { native: p[0], roman: p[1] };
    }
    case "bangkok": {
      const g = rng.pick(THAI_GIVEN);
      const f = rng.pick(THAI_FAMILY);
      return { native: `${g[0]} ${f[0]}`, roman: `${g[1]} ${f[1]}` };
    }
    case "hcmc": {
      const f = rng.pick(VIET_FAMILY);
      const g = rng.pick(VIET_GIVEN);
      return { native: `${f[0]} ${g[0]}`, roman: `${f[1]} ${g[1]}` };
    }
    case "manila": {
      const g = rng.pick(FILIPINO_GIVEN);
      const f = rng.pick(FILIPINO_FAMILY);
      return { native: `${g[0]} ${f[0]}`, roman: `${g[1]} ${f[1]}` };
    }
  }
}

const CODE_A = ["Grey", "Paper", "Night", "Salt", "Jade", "Iron", "Silk", "Ash", "Rain", "Ink", "Lantern", "Tide", "Static", "Neon", "Cipher", "Monsoon"];
const CODE_B = ["Heron", "Ferry", "Crane", "Moth", "Kite", "Fox", "Gull", "Carp", "Wasp", "Owl", "Sparrow", "Bell", "Gecko", "Mynah", "Kingfisher", "Tern"];

/** Codenames are never reused within a campaign. */
export function codename(rng: Rng, taken: ReadonlySet<string>): string {
  for (let i = 0; i < 300; i++) {
    const c = `${rng.pick(CODE_A)} ${rng.pick(CODE_B)}`;
    if (!taken.has(c)) return c;
  }
  throw new Error("out of codenames");
}
