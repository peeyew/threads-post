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

function buildSystemPrompt(ngWords) {
  return `あなたはThreadsのアフィリエイト投稿の本文だけを書くコピーライターです。
対象はDMM.com一般（FANZAではない）のDMM TV(配信作品)またはDMMブックス(コミック・写真集・小説等)。
画像とタイトルは投稿に別途表示されるため、本文では画像・タイトルとそのまま重複しない一言
（気になるポイント・感想めいた一言・軽い煽りなど）を添えます。

## 絶対条件
- 日本語で、40〜90文字程度（長くても100文字を超えない。Threadsは500文字まで書けるが、
  テンポの良い一言コメントを保つためあえて短くまとめる）
- 出力は投稿本文のみ。前置き・説明・見出し・引用符・ハッシュタグを付けない
- URLは含めない（リンクは別のリプライ投稿に付くため）
- 広告表記【PR】は付けない（投稿システム側で機械的に付与するため）
- 次のNGワードや、それを想起させる表現は絶対に使わない: ${ngWords.join('、')}
- 際どい表現で規約に触れそうな場合は無難な表現に倒す

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

function buildUserPrompt({ mediaLabel, title, genres, price }, recentBodies) {
  const genreText = genres && genres.length ? genres.slice(0, 5).join('/') : 'なし';
  const recentText = recentBodies.length
    ? recentBodies.map((b, i) => `${i + 1}. ${b}`).join('\n')
    : '(まだ投稿履歴なし)';

  return `媒体: ${mediaLabel}
作品タイトル: ${title}
ジャンル: ${genreText}
価格情報: ${price ?? '不明'}

直近の投稿本文（この言い回し・型を繰り返さないこと）:
${recentText}

上記を踏まえて、この作品を紹介する投稿本文を1つだけ書いてください。`;
}

function loadNgWords() {
  return JSON.parse(readFileSync('./config/ng-words.json', 'utf-8'));
}

// posts.jsonから直近posted済みの本文をN件読み込む（重複回避のプロンプト用）。
// 存在しない/読めない場合は空配列を返す（初回実行時などで異常終了させないため）。
export function loadRecentBodies(postsFile = './posts.json', limit = RECENT_HISTORY_LIMIT) {
  if (!existsSync(postsFile)) return [];
  try {
    const posts = JSON.parse(readFileSync(postsFile, 'utf-8'));
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

function findReusedTic(text, recentBodies) {
  const recentWindow = recentBodies.slice(0, 3).join('\n');
  return TIC_WATCHLIST.find(tic => text.includes(tic) && recentWindow.includes(tic));
}

// product: { source, title, genres, price } ※sourceは'dmmtv'または'ebook'
// recentBodies: 直近投稿本文の配列（新しい順）。重複回避のプロンプトに使う
export async function generateBody(product, recentBodies) {
  const client = new Anthropic();
  const mediaLabel = MEDIA_LABEL[product.source] || product.source;
  const ngWords = loadNgWords();
  const system = buildSystemPrompt(ngWords);
  const messages = [
    { role: 'user', content: buildUserPrompt({ ...product, mediaLabel }, recentBodies) },
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
