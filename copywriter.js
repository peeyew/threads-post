// DMM.com一般（DMM TV / DMMブックス）の投稿本文をClaude APIで生成する。
// x-auto-post/copywriter.js（FANZA/DUGA/ソクミル向け）をThreads・DMM.com一般向けに移植したもの。
// 設計思想（複数パターンの言い回し・過去投稿との重複回避・口癖化ガード・AIっぽさを消した
// 人間らしい文体）はそのまま踏襲し、対象媒体と文体の前提だけをThreads/DMM.com向けに変更している。
//
// 呼び出し元(fetch-dmm.js)は1回のスケジュール実行につき通常1件しか商品を取得しないため、
// Claude API呼び出しも1日あたり最大3回程度に収まる。
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';

const MODEL = 'claude-sonnet-5';

const MEDIA_LABEL = {
  dmmtv: 'DMM TV',
  ebook: 'DMMブックス',
  rakuten: '楽天市場',
};

// 過去投稿との重複回避のため、プロンプトに含める直近投稿の件数
const RECENT_HISTORY_LIMIT = 8;

// 「AIっぽい」「ワンパターン」と判断される定型パターン。ユーザー指定の禁止リストをそのままプロンプト化する
const STYLE_AVOID_LIST = [
  '「〜必見」「〜必至」「衝撃の」等の煽り定型句を多用しない',
  '「ぜひご覧ください」「お見逃しなく」等の締めの定型フレーズで終わらない',
  '🔥✨💦等の記号的な絵文字を毎回同じ位置・同じ種類で使わない（絵文字を使わない投稿があってもよい）',
  '「〜な件」「〜すぎる」等のバズり構文をワンパターンで繰り返さない',
  '一人称・語尾を投稿ごとに機械的に統一しない（例: 毎回「〜だ。」で終わる、を避ける）',
];

// 媒体ごとの対象説明・文字数の指示。DMMは画像とタイトルが別表示される前提の短い一言、
// 楽天は画像なしのテキスト投稿もあり得るため、商品が何かが本文だけで伝わる紹介文にする
const SOURCE_PROMPT = {
  dmm: {
    intro: `対象はDMM.com一般（FANZAではない）のDMM TV(配信作品)またはDMMブックス(コミック・写真集・小説等)。
画像とタイトルは投稿に別途表示されるため、本文では画像・タイトルとそのまま重複しない一言
（気になるポイント・感想めいた一言・軽い煽りなど）を添えます。`,
    length: `日本語で、40〜90文字程度（長くても100文字を超えない。Threadsは500文字まで書けるが、
  テンポの良い一言コメントを保つためあえて短くまとめる）`,
    extra: '',
  },
  rakuten: {
    intro: `対象は楽天市場の商品（日用品・ペット用品・本など、季節を問わず使えるもの）。
投稿は画像なしのテキストのみの場合があるため、本文だけで「どんな商品で、どんな場面で便利そうか」が
伝わるようにします（商品名は長ければ要点だけに短縮してよい）。リンクは別のリプライに付きます。`,
    length: `日本語で、60〜140文字程度（長くても160文字を超えない）`,
    extra: `- 渡された商品情報（商品名・価格・ジャンル）に書かれていない仕様・効果・効能・数値・受賞歴を創作しない
- 「最安」「No.1」「絶対」「必ず効く」等の断定・最上級表現や、医薬的な効能の示唆をしない
- 価格は変動し得るため、価格を書く場合は「◯◯円前後」程度にとどめる（書かなくてもよい）`,
  },
};

// DMM TVの他ジャンル枠(mode='other')だけに追加する指示。アニメ枠(latest/popular)のプロンプトは変えない
const STRICT_EXTRA = `- 渡された情報（作品名と、渡された場合はその評価）に無い内容を書かない。あらすじ・設定・舞台・登場人物・出演者・制作陣・元ネタ・パロディ元・原作・受賞歴などを、推測でも断定でも書かない
- 作品のジャンル・形態（実写かアニメか、ドラマ・映画・バラエティのどれか、学園ものか等）を断定しない。映画化・ドラマ化・続編・シリーズ・原作にも触れない
- 評価は「評価: 平均◯◯（◯件）」と渡された場合だけ触れてよい。触れる場合は渡された数値をそのまま使い（例:「評価4.8（1,200件）」）、他の数字を書かない。「高評価」「人気」などの言い換えも、評価が渡された場合に限って使ってよい
- 評価の数値を解釈・論評しない。「賛否」「分かれ」「微妙」「低評価」「評価が割れ」などは書かない
- 「評価: なし」と渡された場合は、評価・人気・口コミ・レビュー・ランキングに一切触れない（作品名とジャンルへの反応だけで書く）
- 配信日・公開時期に触れない。「新作」「最新」「最新作」「新着」とも書かない
- 実際に視聴した体験を装う表現を書かない。「見入ってしまった」「再生ボタン押してた」「目が離せなくなった」「泣けてくる」「観終わった」「ハマった」「思わず」「気づいたら」など、視聴済みの人の感想として語らない。作品名とジャンルから言える範囲の印象や特徴を、一般的な言い方で書く
- 「妙に」「地味に」は使わない
- 価格・金額・料金・「無料」「お得」「安い」「コスパ」など、お金に関する表現を一切書かない
- アルファベット(英字)の単語を書かない。作品タイトルに含まれる語を引用する場合を除き、カタカナや日本語で書く
- 「〜は安い」「〜はずるい」「一気見できる」「見ておく価値がある」のような、定番の締め方を繰り返さない`;

function buildSystemPrompt(ngWords, source, strict = false) {
  const cfg = source === 'rakuten' ? SOURCE_PROMPT.rakuten : SOURCE_PROMPT.dmm;
  const extra = strict ? [cfg.extra, STRICT_EXTRA].filter(Boolean).join('\n') : cfg.extra;
  return `あなたはThreadsのアフィリエイト投稿の本文だけを書くコピーライターです。
${cfg.intro}

## 絶対条件
- ${cfg.length}
- 出力は投稿本文のみ。前置き・説明・見出し・引用符・ハッシュタグを付けない
- URLは含めない（リンクは投稿システム側で本文末尾に機械的に付与するため）
- 広告表記【PR】は付けない（投稿システム側で機械的に付与するため）
- 次のNGワードや、それを想起させる表現は絶対に使わない: ${ngWords.join('、')}
- 際どい表現で規約に触れそうな場合は無難な表現に倒す${extra ? `\n${extra}` : ''}

## 人間らしさ（最重要）
実際に商品ページを見た人が思わず一言つぶやいたような、ラフで揺れのある短文にする。
整いすぎた広告コピーやテンプレのように見える文章は避ける。

以下は避けること:
${STYLE_AVOID_LIST.map(s => `- ${s}`).join('\n')}

文の長さ・語尾・句読点の打ち方は投稿ごとにばらつかせる（体言止め、疑問形、独り言のような言い切りなどを混ぜる）。
直近の投稿例が渡された場合は、その言い回し・構成・絵文字の使い方をそのまま繰り返さず、切り口を変える。

特に注意: 「妙に」「〜んだよな」「なんか」「地味に」のような口癖・フィラーを、複数の投稿にわたって
使い回さない。直近の投稿例に同じ単語・言い回しが1回でも出てきたら、今回はその単語を使わず別の表現にする。
特定の助詞・語尾・相槌に頼らず、毎回違う言葉選びをすること。`;
}

// 評価を本文に使ってよい最小件数（他ジャンル枠）。これ未満・評価なしは「評価: なし」として渡す
export const REVIEW_MIN_COUNT = 20;
const REVIEW_HIGH_AVERAGE = 4.0; // 評価を本文に使ってよい平均評価の下限（これ未満は評価に触れさせない）

function reviewUsable(review) {
  return !!review && Number.isFinite(review.average) && review.average >= REVIEW_HIGH_AVERAGE && review.count >= REVIEW_MIN_COUNT;
}

function formatReviewLine(review) {
  if (!reviewUsable(review)) return '評価: なし';
  return `評価: 平均${review.average}（${review.count.toLocaleString('en-US')}件）`;
}

function buildUserPrompt({ source, mediaLabel, title, genres, price, strict = false, review }, recentBodies) {
  const noun = source === 'rakuten' ? '商品' : '作品';
  const genreText = genres && genres.length ? genres.slice(0, 5).join('/') : 'なし';
  const recentText = recentBodies.length
    ? recentBodies.map((b, i) => `${i + 1}. ${b}`).join('\n')
    : '(まだ投稿履歴なし)';

  return `媒体: ${mediaLabel}
${noun}名: ${title}
${strict ? formatReviewLine(review) : `ジャンル: ${genreText}\n価格情報: ${price ?? '不明'}`}

直近の投稿本文（この言い回し・型を繰り返さないこと）:
${recentText}

上記を踏まえて、この${noun}を紹介する投稿本文を1つだけ書いてください。`;
}

function loadNgWords() {
  return JSON.parse(readFileSync('./config/ng-words.json', 'utf-8'));
}

// posts.jsonから直近posted済みの本文をN件読み込む（重複回避のプロンプト用）。
// 存在しない/読めない場合は空配列を返す（初回実行時などで異常終了させないため）。
// variantを指定した場合は、その枠の本文を状態(pending/posted/skipped)を問わず新しい順に返す
// （他ジャンル枠は投稿実績が無い間も、DRY_RUN等で生成済みの本文との重複を避けたいため）
export function loadRecentBodies(postsFile = './posts.json', limit = RECENT_HISTORY_LIMIT, { variant } = {}) {
  if (!existsSync(postsFile)) return [];
  try {
    const posts = JSON.parse(readFileSync(postsFile, 'utf-8'));
    if (variant) {
      return posts
        .filter(p => p.variant === variant && p.body)
        .sort((a, b) => new Date(b.postedAt || b.created || 0) - new Date(a.postedAt || a.created || 0))
        .slice(0, limit)
        .map(p => p.body);
    }
    return posts
      .filter(p => p.status === 'posted' && p.body)
      .sort((a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0))
      .slice(0, limit)
      .map(p => p.body);
  } catch {
    return [];
  }
}

// 機械的フォールバック用の固定テンプレ（Claude API呼び出しが失敗した場合のみ使用）
export function fallbackBody(source, title, maxLen = 40) {
  const label = MEDIA_LABEL[source] || source;
  return `【${label}】${title.slice(0, maxLen)}`;
}

// プロンプト指示だけでは口癖化を防ぎきれない語（x-auto-post側で実際に繰り返し確認された）。
// 直近投稿と生成結果の両方に含まれていたら、1回だけ言い換えを依頼する機械的なガード
const TIC_WATCHLIST = ['妙', 'んだよな', 'なんか', '地味に'];

// 他ジャンル枠で実際に繰り返された締めの型。直近の本文と同じ型が出たら言い換えさせる
const STRICT_TIC_WATCHLIST = [
  '安い', '安すぎ', 'ずるい', '得かも', 'は得', '損ない', '一気見', '見ておく価値', '見ておきたい', '破格',
  '気になる', 'のか気になる',
];

function findReusedTic(text, recentBodies, watchlist = TIC_WATCHLIST) {
  const recentWindow = recentBodies.slice(0, 3).join('\n');
  return watchlist.find(tic => text.includes(tic) && recentWindow.includes(tic));
}

// 他ジャンル枠(strict)で本文に入れてはいけないものを検査する。
// - 英字の単語（作品タイトルに含まれる語は除く）
// - 価格・金額・お得系の表現
const PRICE_PATTERN = /[0-9０-９][0-9０-９,，.]*\s*円|無料|有料|価格|料金|税込|割引|セール|お得|格安|安い|安すぎ|コスパ|プチプラ|ワンコイン|得かも|得する|は得/;

// 視聴体験を装う表現（他ジャンル枠は作品内容の情報を持たないため、体験談の形を取らせない）
const EXPERIENCE_PATTERN = /見入(っ|り)|再生(ボタン)?を?押|目が離せ|泣けて(き|く)|泣け(た|ちゃ)|泣い(た|て)|(観|見)(た(?!目)|てい?た|終|返し)|ハマ(っ|り)|引き込まれ|夢中にな|気づ(いたら|けば)|思わず|感動し(た|て)|笑っ(た|ちゃ)|驚い(た|て)|心を(掴|つか)まれ|余韻に浸/;
// 常に避ける口癖（直近の本文との重複とは無関係に禁止）
const FIXED_AVOID_PATTERN = /妙に|地味に/;

// 配信日・公開時期を匂わせる表現
const DATE_PATTERN = /新作|最新|新着|ニューリリース|配信開始|新登場|公開中/;
// 評価に触れる表現（評価が渡されていない作品では禁止）
const REVIEW_MENTION_PATTERN = /評価|レビュー|口コミ|評判|人気|支持|ランキング|星[0-9０-９]|★|[0-9０-９.]+\s*点/;
// 評価の数値の解釈・論評（評価を使える場合でも禁止）
const REVIEW_INTERPRET_PATTERN = /賛否|分かれ|微妙|低評価|割れ|両論|辛口|イマイチ|いまいち|酷評|不評|ばらつき/;
// 作品内容・形態の推測や断定につながる語（作品名に含まれる場合を除く）
const INVENTED_PATTERN = /映画化|映画版|ドラマ化|ドラマ版|実写化|アニメ化|実写版|続編|シリーズ|シーズン|リメイク|スピンオフ|原作|パロディ|オマージュ|学園|学校|職員室|教室|青春|実話|実在/;

export function findBannedContent(text, title, review) {
  const issues = [];
  const normTitle = String(title || '').normalize('NFKC').toLowerCase();
  const latin = (String(text).normalize('NFKC').match(/[A-Za-z][A-Za-z'’-]*/g) || [])
    .filter(w => !normTitle.includes(w.toLowerCase()));
  if (latin.length) issues.push({ type: 'latin', words: [...new Set(latin)] });
  const price = String(text).match(PRICE_PATTERN);
  if (price) issues.push({ type: 'price', words: [price[0]] });
  const exp = String(text).match(EXPERIENCE_PATTERN);
  if (exp) issues.push({ type: 'experience', words: [exp[0]] });
  const fixed = String(text).match(FIXED_AVOID_PATTERN);
  if (fixed) issues.push({ type: 'fixed', words: [fixed[0]] });
  const date = String(text).match(DATE_PATTERN);
  if (date) issues.push({ type: 'date', words: [date[0]] });

  // 評価まわり。渡された評価（件数がREVIEW_MIN_COUNT以上）がある場合のみ触れてよく、数値は渡した値と一致が必要
  const normText = String(text).normalize('NFKC');
  const allowed = reviewUsable(review);
  const mention = normText.match(REVIEW_MENTION_PATTERN);
  if (mention && !allowed && !normTitle.includes(mention[0].toLowerCase())) {
    issues.push({ type: 'review-unallowed', words: [mention[0]] });
  }
  const interp = normText.match(REVIEW_INTERPRET_PATTERN);
  if (interp && !normTitle.includes(interp[0].toLowerCase())) issues.push({ type: 'review-interpret', words: [interp[0]] });
  const invented = normText.match(INVENTED_PATTERN);
  if (invented && !normTitle.includes(invented[0].toLowerCase())) issues.push({ type: 'invented', words: [invented[0]] });
  // 数字は「渡した評価の平均・件数」か「作品名に含まれる数字」のみ許可（創作された数値を防ぐ）
  const titleNums = new Set((normTitle.match(/[0-9]+(?:\.[0-9]+)?/g) || []).map(Number));
  const okNums = new Set(titleNums);
  if (allowed) { okNums.add(review.average); okNums.add(review.count); }
  const badNums = (normText.replace(/(\d),(\d{3})/g, '$1$2').match(/[0-9]+(?:\.[0-9]+)?/g) || [])
    .map(Number).filter(n => !okNums.has(n));
  if (badNums.length) issues.push({ type: 'number', words: [...new Set(badNums)].map(String) });
  return issues;
}

// product: { source, title, genres, price } ※sourceは'dmmtv'|'ebook'|'rakuten'
// recentBodies: 直近投稿本文の配列（新しい順）。重複回避のプロンプトに使う
export async function generateBody(product, recentBodies) {
  const client = new Anthropic();
  const mediaLabel = MEDIA_LABEL[product.source] || product.source;
  const ngWords = loadNgWords();
  // 他ジャンル枠(mode='other')だけ厳格なルールを適用する。アニメ枠・楽天のプロンプトと処理は変えない
  const strict = product.mode === 'other';
  const system = buildSystemPrompt(ngWords, product.source, strict);
  const messages = [
    { role: 'user', content: buildUserPrompt({ ...product, mediaLabel, strict }, recentBodies) },
  ];
  const usage = { input_tokens: 0, output_tokens: 0 };

  async function requestOnce() {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      output_config: { effort: 'low' },
      system,
      messages,
    });
    usage.input_tokens += response.usage?.input_tokens || 0;
    usage.output_tokens += response.usage?.output_tokens || 0;
    const textBlock = response.content.find(b => b.type === 'text');
    const text = textBlock?.text?.trim();
    if (!text) throw new Error('copywriter: 空の応答が返されました');
    return text;
  }

  let text = await requestOnce();

  // 直近投稿と同じ口癖が混入していたら、会話を継続して1回だけ言い換えさせる
  // （プロンプト指示だけでは防ぎきれなかったため機械的なガードとして追加）
  if (!strict) {
    const reusedTic = findReusedTic(text, recentBodies);
    if (reusedTic) {
      console.log(`copywriter: 口癖「${reusedTic}」を検知したため言い換えをリクエストします`);
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: `「${reusedTic}」は直近の投稿と重複する言い回しです。この単語を使わずに、出力は本文のみで書き直してください。`,
      });
      text = await requestOnce();
    }
    return { text, usage };
  }

  // 他ジャンル枠: 口癖(締めの型の連続)・英字・価格表現を検査し、あれば1回だけまとめて書き直させる。
  // 英字・価格表現が書き直し後も残る場合はエラーにして、呼び出し元(fetch-dmm.js)の定型文フォールバックに任せる
  const tics = [...TIC_WATCHLIST, ...STRICT_TIC_WATCHLIST];
  const reusedTic = findReusedTic(text, recentBodies, tics);
  const banned = findBannedContent(text, product.title, product.review);
  if (reusedTic || banned.length) {
    const reasons = [];
    if (reusedTic) reasons.push(`「${reusedTic}」は直近の投稿と重複する言い回しです。この単語を使わないでください`);
    for (const b of banned) {
      const msg = {
        latin: `英字の単語(${b.words.join('、')})が含まれています。英字を使わず日本語で書いてください`,
        price: `金額・お得に関する表現(${b.words.join('、')})が含まれています。お金に触れないでください`,
        experience: `視聴した体験を装う表現(${b.words.join('、')})が含まれています。体験談の形を避け、作品名とジャンルから言える一般的な印象や特徴で書いてください`,
        fixed: `「${b.words.join('、')}」は使えません。別の表現にしてください`,
        date: `配信時期に関する表現(${b.words.join('、')})が含まれています。「新作」「最新」などを使わないでください`,
        'review-unallowed': `評価に関する表現(${b.words.join('、')})が含まれていますが、この作品は評価を使えません。評価・人気・口コミに触れないでください`,
        'review-interpret': `評価を解釈する表現(${b.words.join('、')})が含まれています。評価の数値の論評はせず、事実の数値だけを書くか、評価に触れないでください`,
        invented: `渡した情報にない作品の形態・設定・派生に関する表現(${b.words.join('、')})が含まれています。作品名から言える範囲だけで書いてください`,
        number: `渡していない数字(${b.words.join('、')})が含まれています。評価の数値以外の数字を書かないでください`,
      };
      reasons.push(msg[b.type]);
    }
    console.log(`copywriter: 再生成します(${reasons.join(' / ')})`);
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: `${reasons.join('。')}。出力は本文のみで書き直してください。` });
    text = await requestOnce();
    const still = findBannedContent(text, product.title, product.review);
    if (still.length) {
      throw new Error(`copywriter: 再生成後も禁止表現が残りました(${still.map(b => `${b.type}:${b.words.join(',')}`).join(' ')})`);
    }
  }

  return { text, usage };
}
