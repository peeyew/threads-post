// posts.jsonから次の未投稿(pending)を取り出してThreadsに投稿する。
// x-auto-post/auto-post.js（X向け）をThreads API向けに移植したもの。
//
// imageUrlがある投稿（DMMブックス）は「画像付き本体投稿 → リプライでリンク」の2段階、
// imageUrlがない投稿（DMM TV。ItemList APIがimageURLを返さないため）は
// 「本文のみ投稿 → リプライでリンク」の2段階で投稿する。
//
// Threads APIのreply_to_idには「公開後のID」（threads_publishのレスポンスID）を渡す必要がある
// （コンテナ作成時のcreation_idではない）。公式リファレンス(Publishing)で確認済み。
//
// 【本体投稿とリプライ投稿を独立した成功/失敗として扱う】
// 本体投稿(publishContainer)が成功した時点でThreads上には既に公開済みのため、
// その直後にposts.jsonのstatus更新とposted-ids.jsonへの記録を確定させる。
// これを本体+リプライ両方の成功を待ってからまとめて行うと、リプライだけが失敗した場合に
// 本体はpendingのまま残り、次回実行で本体が重複投稿されてしまう。
// そのためリプライ投稿は本体確定後の別ブロックとし、失敗してもexit(1)せずログのみ残す
// （本体の重複投稿さえ防げればよく、リプライの自動リトライは行わない）。
//
// posted-ids.jsonへの書き込みはここで行う（fetch-dmm.js側では行わない）。
// 投稿が実際に成功した場合にのみcontentIdを記録することで、投稿失敗時にpendingのまま
// 商品が永久にfetch対象から除外される事故を防ぐ（fetch-dmm.js冒頭のコメント参照）。
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { sendToGAS } from './send-to-gas.js';

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

function buildMainText(bodyText) {
  const maxLen = THREADS_TEXT_LIMIT - PR_TAG_BLOCK.length;
  return `${trimBody(bodyText, maxLen)}${PR_TAG_BLOCK}`;
}

// コンテナ作成（image_urlがあればIMAGE、なければTEXT。reply_to_idがあれば返信になる）
async function createContainer({ text, imageUrl, replyToId }) {
  const payload = {
    media_type: imageUrl ? 'IMAGE' : 'TEXT',
    text,
    access_token: ACCESS_TOKEN,
  };
  if (imageUrl) payload.image_url = imageUrl;
  if (replyToId) payload.reply_to_id = replyToId;

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
  return data.id; // 公開後の実IDを返す（reply_to_idに使うのはこちら）
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

const mainText = buildMainText(next.body || next.text || '');
const replyText = next.url || '';

if (DRY_RUN) {
  console.log('[DRY_RUN] 本体投稿:');
  console.log(mainText);
  console.log(`[DRY_RUN] media_type: ${next.imageUrl ? 'IMAGE' : 'TEXT'}`);
  if (next.imageUrl) console.log(`[DRY_RUN] 画像URL: ${next.imageUrl}`);
  if (replyText) {
    console.log('[DRY_RUN] リプライ:');
    console.log(replyText);
  }
  console.log(`[DRY_RUN] source: ${next.source}`);
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

// ── 本体投稿が成功した時点でThreads上には公開済みのため、ここで状態を確定する ──
// （この後のリプライが失敗しても本体の重複投稿を防ぐため、リプライの成否を待たない）
next.status = 'posted';
next.postedAt = new Date().toISOString();
writeFileSync(postsFile, JSON.stringify(posts, null, 2), 'utf-8');
recordPostedId(next.contentId);

await sendToGAS({
  id: mainPublishedId,
  type: next.source,
  keyword: next.body?.slice(0, 30) || '',
  genres: (next.genres || []).join(', '),
  platform: 'threads',
  likes: 0,
  retweets: 0,
  replies: 0,
  postedAt: next.postedAt,
});

// ── リプライ投稿（本体確定後の非致命的な処理。失敗してもexit(1)しない） ──
if (replyText) {
  try {
    const replyCreationId = await createContainer({ text: replyText, replyToId: mainPublishedId });
    console.log(`リプライ:\n${replyText}\n`);
    await new Promise(r => setTimeout(r, 3000));
    const replyPublishedId = await publishContainer(replyCreationId);
    console.log('リプライ投稿完了！');
    console.log(`公開ID: ${replyPublishedId}`);
  } catch (err) {
    // 本体は既に公開・記録済みのため、リプライ失敗は警告に留めて正常終了する。
    // リンクが付かない投稿がThreads上に残るが、自動リトライは行わない方針
    console.error('リプライ投稿失敗（本体投稿は成功済み）:', err.message);
  }
}
