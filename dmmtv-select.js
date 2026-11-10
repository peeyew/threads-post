// DMM TV投稿の選定ロジックのうち、副作用のない純粋関数をまとめたもの（fetch-dmm.jsから利用）。
// 単体で動作確認できるよう、APIアクセスやファイル読み書きはここに置かない。

// 同一作品の複数シーズン・続編表記を同じキーに寄せる（作品単位の重複排除用）。
// 「おいしい給食」「おいしい給食 season2」「おいしい給食 第3期」は同じキーになる。
// 空白・記号は無視する。「映画」「劇場版」などの接頭辞は別作品を区別するため落とさない。
const SEASON_SUFFIXES = [
  /(season|シーズン|シリーズ|第)\s*[0-9一二三四五六七八九十]+\s*(期|シリーズ|章|部|作|シーズン)?$/i,
  /[0-9]+(nd|rd|th)\s*season$/i,
  /\s(ii|iii|iv|v|vi)$/i,
  /[ⅡⅢⅣⅤⅥ]$/,
  /(完全版|特別版|ディレクターズカット版|ノーカット版)$/,
];

export function workKey(title) {
  let t = String(title || '').normalize('NFKC').trim();
  let prev;
  do {
    prev = t;
    for (const re of SEASON_SUFFIXES) t = t.replace(re, '').trim();
  } while (t !== prev);
  return t.toLowerCase().replace(/[\s​・･・、。,.!！?？:：;；~〜～\-‐―ー—–＝=\/／()（）「」『』【】\[\]<>＜＞'"’“”&＆]/g, '');
}

// ジャンル（category）の決定。アニメ枠はそのままアニメ。
// 他ジャンル枠は検索キーワード由来とし、タイトルに「劇場版」「アニメ」を含むものはアニメに寄せる。
// （「映画」検索にはアニメ映画が多く混ざるため。「劇場版」等を含まないアニメ映画は映画のまま残る）
const ANIME_TITLE_PATTERN = /劇場版|アニメ/;

export function categorize({ mode, keyword, title }) {
  if (mode === 'latest' || mode === 'popular') return 'アニメ';
  if (ANIME_TITLE_PATTERN.test(String(title || ''))) return 'アニメ';
  return keyword || 'その他';
}
