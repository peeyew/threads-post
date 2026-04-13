import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import Parser from 'rss-parser';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── 1. 時間チェック（JST 7:00〜23:00）──────────────────────
const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
const jstHour = jstNow.getUTCHours();
if (jstHour < 7 || jstHour >= 23) {
  console.log(`深夜帯のためスキップ（JST ${jstHour}時）`);
  process.exit(0);
}

// ── 2. RSSニュース取得 ──────────────────────────────────────
const RSS_SOURCES = [
  'https://www3.nhk.or.jp/rss/news/cat4.xml',       // NHK経済
  'https://www3.nhk.or.jp/rss/news/cat6.xml',       // NHK国際
  'https://www3.nhk.or.jp/rss/news/cat5.xml',       // NHK政治
  'https://fx.minkabu.jp/news.rss',                  // みんかぶFX
  'https://www.fxstreet.com/rss/news',               // FXStreet
  'https://feeds.bbci.co.uk/japanese/rss.xml',       // BBC日本語
  'https://jp.reuters.com/rssFeed/worldNews',        // ロイター国際
];

const KEYWORDS = ['為替', 'ドル', '円', '金利', '日銀', '米', '中国', '政治', '経済', '株', '関税', 'トランプ', '政府', '首相', '大統領', 'インフレ', '利上げ', '利下げ', '国際', '外交', '戦争', 'ウクライナ', 'ロシア', 'イスラエル', 'ガザ', '中東', '北朝鮮', 'NATO'];

const parser = new Parser({ timeout: 5000 });
const allItems = [];

await Promise.allSettled(
  RSS_SOURCES.map(url =>
    parser.parseURL(url)
      .then(feed => {
        const items = feed.items.slice(0, 8).map(item => ({
          title: item.title,
          link: item.link,
        }));
        allItems.push(...items);
        console.log(`RSS取得: ${url} → ${items.length}件`);
      })
      .catch(err => console.error(`RSS取得失敗 (${url}):`, err.message))
  )
);

console.log(`合計ニュース: ${allItems.length}件`);

// キーワードフィルター
const matched = allItems.filter(item =>
  KEYWORDS.some(kw => item.title.includes(kw))
);
const candidates = matched.length > 0 ? matched : allItems;

// ランダムに1件選ぶ
const selected = candidates[Math.floor(Math.random() * Math.min(candidates.length, 5))];
if (!selected) {
  console.log('ニュースなし、スキップ');
  process.exit(0);
}
console.log(`選択記事: ${selected.title}`);

// ── 3. Claude Haiku で投稿文生成 ──────────────────────────
const prompt = `以下のニュースタイトルをもとに、Threadsへの速報スタイルの投稿文を1つ書いてください。

ニュース:「${selected.title}」

条件：
- 150文字以内
- 冒頭に【速報】または【Breaking】をつける
- 事実を1行で伝えた後、改行して「→ 」で始まる一言コメントを加える
- コメントは驚き・共感・警戒感のどれかを引き出す内容
- 読者が「シェアしたい」と思えるトーン
- ハッシュタグは付けない
- URLは含めない
- 投稿文のみ出力（説明不要）`;

let postBody = '';
try {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });
  postBody = res.content[0].text.trim();
  console.log(`生成文:\n${postBody}`);
} catch (err) {
  console.error('Claude エラー:', err.message);
  process.exit(1);
}

// ── 4. Threads API で投稿 ──────────────────────────────────
const APP_ID = process.env.THREADS_USER_ID;
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;

try {
  const createRes = await fetch(
    `https://graph.threads.net/v1.0/${APP_ID}/threads`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'TEXT',
        text: postBody,
        access_token: ACCESS_TOKEN,
      }),
    }
  );
  const createData = await createRes.json();
  console.log('コンテナ作成:', createData);

  if (!createData.id) throw new Error('コンテナID取得失敗');

  await new Promise(r => setTimeout(r, 3000));

  const publishRes = await fetch(
    `https://graph.threads.net/v1.0/${APP_ID}/threads_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: createData.id,
        access_token: ACCESS_TOKEN,
      }),
    }
  );
  const publishData = await publishRes.json();
  console.log('投稿完了！', publishData);
} catch (err) {
  console.error('Threads投稿失敗:', err.message);
  process.exit(1);
}
