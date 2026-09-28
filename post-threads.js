// posts.jsonから次の未投稿(pending)を取り出してThreadsに投稿する。
// x-auto-post/auto-post.js（X向け）をThreads API向けに移植したもの。
//
// アフィリエイトURLは本文テキストに含めて1回のAPI呼び出しで投稿する
// （以前はリンクを別のリプライ投稿にしていたが、本文内リンク方式に変更した）。
// imageUrlがある投稿（DMMブックス）はIMAGE、ない投稿（DMM TV）はTEXTとして投稿する。
//
// posted-ids.jsonへの書き込みはここで行う（fetch-dmm.js側では行わない）。
// 投稿が実際に成功した場合にのみcontentIdを記録することで、投稿失敗時にpendingのまま
// 商品が永久にfetch対象から除外される事故を防ぐ（fetch-dmm.js冒頭のコメント参照）。
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { sendToGAS } from './send-to-gas.js';
import { isValidThreadsId, fetchThreadsInsights } from './threads-insights.js';

dotenv.config();

const USER_ID = process.env.THREADS_USER_ID;
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const GRAPH_BASE = 'https://graph.threads.net/v1.0';

const postsFile = './posts.json';
const POSTED_IDS_FILE = './posted-ids.json';
const POSTED_ID_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90日

// 広告表記。copy-writerの生成文には含めず、ここで機械的に付与する
const PR_TAG = '【PR】';
const PR_TAG_BLOCK = `\n${PR_TAG}`;
// Threadsのテキスト上限は500文字
const THREADS_TEXT_LIMIT = 500;

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!existsSync(postsFile)) {
  console.log('posts.jsonが存在しません。スキップします。');
  process.exit(0);
}

const posts = JSON.parse(readFileSync(postsFile, 'utf-8'));
const next = posts.find(p => p.status === 'pending');

if (!next) {
  console.log('投稿待ちの記事がありません');
  process.exit(0);
}

function trimBody(body, maxLen) {
  return body.length > maxLen ? body.slice(0, maxLen - 1) + '…' : body;
}

// 本文 + 【PR】 + URLを組み立てる。500字上限に収まるよう超過時は本文側を切り詰める
function buildMainText(bodyText, url) {
  const suffix = url ? `${PR_TAG_BLOCK}\n${url}` : PR_TAG_BLOCK;
  const maxBodyLen = Math.max(0, THREADS_TEXT_LIMIT - suffix.length);
  return `${trimBody(bodyText, maxBodyLen)}${suffix}`;
}

// コンテナ作成（image_urlがあればIMAGE、なければTEXT）
async function createContainer({ text, imageUrl }) {
  const payload = {
    media_type: imageUrl ? 'IMAGE' : 'TEXT',
    text,
    access_token: ACCESS_TOKEN,
  };
  if (imageUrl) payload.image_url = imageUrl;

  const res = await fetch(`${GRAPH_BASE}/${USER_ID}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`コンテナ作成失敗: ${JSON.stringify(data)}`);
  return data.id;
}

async function publishContainer(creationId) {
  const res = await fetch(`${GRAPH_BASE}/${USER_ID}/threads_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: ACCESS_TOKEN }),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`公開失敗: ${JSON.stringify(data)}`);
  return data.id; // 公開後の実ID（インサイト取得・GAS送信に使う）
}

// 投稿成功後にposted-ids.jsonへ記録する（読み込み→TTL失効分を除外→追記→書き戻し）
function recordPostedId(contentId) {
  if (!contentId) return;
  const raw = existsSync(POSTED_IDS_FILE)
    ? JSON.parse(readFileSync(POSTED_IDS_FILE, 'utf-8'))
    : [];
  const now = Date.now();
  const valid = raw.filter(e => now - new Date(e.postedAt).getTime() < POSTED_ID_TTL_MS);
  valid.push({ contentId, postedAt: new Date().toISOString() });
  writeFileSync(POSTED_IDS_FILE, JSON.stringify(valid, null, 2), 'utf-8');
  console.log(`posted-ids.jsonを更新しました（有効${valid.length}件）`);
}

const mainText = buildMainText(next.body || next.text || '', next.url || '');

if (DRY_RUN) {
  console.log('[DRY_RUN] 本体投稿:');
  console.log(mainText);
  console.log(`[DRY_RUN] media_type: ${next.imageUrl ? 'IMAGE' : 'TEXT'}`);
  if (next.imageUrl) console.log(`[DRY_RUN] 画像URL: ${next.imageUrl}`);
  console.log(`[DRY_RUN] source: ${next.source}${next.variant ? ` (variant: ${next.variant})` : ''}`);
  console.log(`[DRY_RUN] genres: ${(next.genres || []).join(', ') || '(なし)'}`);
  console.log('[DRY_RUN] 実際の投稿・posts.json/posted-ids.json更新・GAS送信は行いません');
  process.exit(0);
}

let mainPublishedId;

// ── 本体投稿（失敗したらここでexit(1)。next.statusは未更新のまま = 次回リトライ対象） ──
try {
  const mainCreationId = await createContainer({ text: mainText, imageUrl: next.imageUrl || undefined });
  console.log(`本体投稿:\n${mainText}\n`);

  // 公開前の待機（Threads APIの一般的な推奨パターン。画像取得・処理の完了を待つ）
  await new Promise(r => setTimeout(r, 3000));

  mainPublishedId = await publishContainer(mainCreationId);
  console.log('本体投稿完了！');
  console.log(`公開ID: ${mainPublishedId}`);
} catch (err) {
  console.error('本体投稿失敗:', err.message);
  process.exit(1);
}

// ── 投稿成功時点でposts.jsonの状態を確定する ──
next.status = 'posted';
next.postedAt = new Date().toISOString();
writeFileSync(postsFile, JSON.stringify(posts, null, 2), 'utf-8');
recordPostedId(next.contentId);

// ── engagementスプレッドシートのthreadsタブに初回記録する ──
// 投稿直後のインサイトはほぼ0だが、行を確定させておけば日次のupdate-threads-engagement.jsが
// 以降の値を更新する。インサイト取得の失敗は致命的でないため、その場合は指標を空欄のまま記録する。
// 公開IDが数字以外（診断・テスト残骸など）の場合はシートを汚さないよう書き込まない。
if (!isValidThreadsId(mainPublishedId)) {
  console.error(`Threads投稿IDが不正なためエンゲージメント記録をスキップ: ${JSON.stringify(mainPublishedId)}`);
} else {
  let insights = {};
  try {
    insights = await fetchThreadsInsights(mainPublishedId, ACCESS_TOKEN);
  } catch (err) {
    console.error('インサイト取得失敗（指標は空欄で記録）:', err.message);
  }
  await sendToGAS({
    id: mainPublishedId,
    type: next.source,
    keyword: next.body?.slice(0, 30) || '',
    genres: (next.genres || []).join(', '),
    platform: 'threads',
    postedAt: next.postedAt,
    ...insights,
  });
}
