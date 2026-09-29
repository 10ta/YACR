const ADJ = [
  '害羞的', '困倦的', '勇敢的', '好奇的', '安静的', '快乐的', '迷糊的', '认真的',
  '慢吞吞的', '爱笑的', '神秘的', '优雅的', '倔强的', '机灵的', '温柔的', '淡定的',
  '忙碌的', '贪吃的', '乖巧的', '调皮的', '沉稳的', '热情的', '悠闲的', '聪明的',
];
const ANIMALS = [
  '狐狸', '水獭', '企鹅', '考拉', '刺猬', '海豹', '鹦鹉', '熊猫', '浣熊', '树懒',
  '河马', '犀牛', '斑马', '长颈鹿', '骆驼', '羊驼', '袋鼠', '海豚', '鲸鱼', '章鱼',
  '海马', '乌龟', '青蛙', '蜗牛', '松鼠', '仓鼠', '兔子', '狸猫', '獾', '鼹鼠',
  '火烈鸟', '猫头鹰', '啄木鸟', '孔雀', '天鹅', '鸭嘴兽', '食蚁兽', '穿山甲', '犰狳', '狐獴',
  '雪豹', '猞猁', '蝙蝠', '水母', '螃蟹', '海獭', '白鲸', '小熊猫', '驯鹿', '北极熊',
];

// FNV-1a 32 位
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

// 头像颜色：OKLCH 色彩空间，色相 0–359 连续取值，再叠加 4 档明度和 3 档彩度，
// 可区分的颜色比原来"只变色相"多出一个数量级。浅色头像配深色文字，保证可读。
const LIGHTNESS = [0.5, 0.58, 0.66, 0.74];
const CHROMA = [0.12, 0.16, 0.2];
const colorFor = (uid) => {
  const l = LIGHTNESS[hash(uid + '#l') % LIGHTNESS.length];
  const c = CHROMA[hash(uid + '#s') % CHROMA.length];
  const h = hash(uid + '#c') % 360;
  return { color: `oklch(${l} ${c} ${h})`, ink: l >= 0.66 ? '#15191f' : '#ffffff' };
};

export const identityFor = (uid) => {
  const h = hash(uid);
  const animal = ANIMALS[h % ANIMALS.length];
  return {
    uid,
    name: ADJ[hash(uid + '#a') % ADJ.length] + animal,
    initial: animal[0],
    ...colorFor(uid),
  };
};

export const loadSelf = () => {
  let uid = null;
  try {
    uid = localStorage.getItem('rc_uid');
  } catch {}
  if (!uid || !/^[a-z0-9]{10,32}$/.test(uid)) {
    uid = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => (b % 36).toString(36)).join('');
    try {
      localStorage.setItem('rc_uid', uid);
    } catch {}
  }
  return identityFor(uid);
};
