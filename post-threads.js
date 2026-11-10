// posts.jsonから次の未投稿(pending)を取り出してThreadsに投稿する。
// x-auto-post/auto-post.js（X向け）をThreads API向けに移植したもの。
//
// アフィリエイトURLは原則として本文テキストに含めて1回のAPI呼び出しで投稿する
// （DMM。以前はリンクを別のリプライ投稿にしていたが、本文内リンク方式に変更した）。
// ただしLINK_IN_REPLY_SOURCES（楽天）は「本文（リンクなし）→ 自分の投稿へのリプライでリンク」の
// 2段階で投稿する。リプライは本体確定後の非致命的な処理で、失敗しても本体は重複投稿しない。
// Threads APIのreply_to_idには「公開後のID」（threads_publishのレスポンスID）を渡す。
// imageUrlがある投稿（DMMブックス）はIMAGE、ない投稿（DMM TV、楽天の画像なし運用）はTEXTとして投稿する。
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

// DMM APIへのリクエストはAPI用のaffiliate_id(990番台)で行うが、投稿本文に載せるURLは
// Threads用サイトのaf_id(peeyew-002)に置換する。未設定時はAPI用IDのまま投稿する
const DISPLAY_AFFILIATE_ID = process.env.DMM_AFFILIATE_ID_THREADS_DISPLAY;

// 種別を限定して投稿したい場合に'dmmtv'|'ebook'|'rakuten'を指定する。未設定なら種別を問わず先頭を選ぶ
const POST_SOURCE = process.env.POST_SOURCE;
// dmmtvの枠（latest/popular/other）ごとにpendingを分けたい場合に指定する。未設定なら枠を問わない。
// otherのDRY_RUNで積んだpendingがアニメ枠から消化されてしまうのを防ぐ
const POST_VARIANT = process.env.POST_VARIANT;

// リンクを本文ではなくリプライに付ける種別
const LINK_IN_REPLY_SOURCES = new Set(['rakuten']);

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
const next = posts.find(p => p.status === 'pending' && (!POST_SOURCE || p.source === POST_SOURCE) && (!POST_VARIANT || p.variant === POST_VARIANT));

if (!next) {
  console.log(POST_SOURCE ? `対象種別(${POST_SOURCE}${POST_VARIANT ? `/${POST_VARIANT}` : ''})の投稿待ちの記事がありません` : '投稿待ちの記事がありません');
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

// DMM APIから取得したURLのaf_idパラメータのみをThreads用サイトIDに置換する。
// lurl・ch等の他パラメータやパラメータ順序はそのまま保持する
function toDisplayUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  if (!DISPLAY_AFFILIATE_ID) {
    console.warn('DMM_AFFILIATE_ID_THREADS_DISPLAY未設定のため、URLのaf_idをAPI用IDのまま投稿します');
    return rawUrl;
  }
  try {
    const u = new URL(rawUrl);
    if (u.searchParams.has('af_id')) {
      u.searchParams.set('af_id', DISPLAY_AFFILIATE_ID);
    }
    return u.toString();
  } catch (err) {
    console.warn(`URL解析失敗のためaf_id置換をスキップ: ${err.message}`);
    return rawUrl;
  }
}

// トピック(topic_tag)。Threads APIでは1投稿につき1つ、1〜50文字、ピリオドとアンパサンドは使えない。
// 種別ごとの割り当てはconfig/topic-map.jsonで管理する（ebookはgenresの先頭から順にルール照合）。
const TOPIC_MAP_FILE = './config/topic-map.json';

function sanitizeTopic(topic) {
  if (!topic || typeof topic !== 'string') return undefined;
  const cleaned = topic.replace(/[.&]/g, '').trim().slice(0, 50);
  return cleaned || undefined;
}

function pickTopicTag(post) {
  if (!existsSync(TOPIC_MAP_FILE)) return undefined;
  let map;
  try {
    map = JSON.parse(readFileSync(TOPIC_MAP_FILE, 'utf-8'));
  } catch (err) {
    console.warn(`topic-map.jsonの解析に失敗したためトピックなしで投稿します: ${err.message}`);
    return undefined;
  }
  const entry = map[post.source];
  if (typeof entry === 'string') return sanitizeTopic(entry);
  if (!entry) return undefined;
  const genres = post.genres || [];
  for (const rule of entry.rules || []) {
    if (rule.genres?.some(g => genres.includes(g))) return sanitizeTopic(rule.topic);
  }
  return sanitizeTopic(entry.default);
}

// コンテナ作成（image_urlがあればIMAGE、なければTEXT。replyToIdがあれば返信になる）
async function createContainer({ text, imageUrl, topicTag, replyToId }) {
  const payload = {
    media_type: imageUrl ? 'IMAGE' : 'TEXT',
    text,
    access_token: ACCESS_TOKEN,
  };
  if (imageUrl) payload.image_url = imageUrl;
  if (topicTag) payload.topic_tag = topicTag;
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

const linkInReply = LINK_IN_REPLY_SOURCES.has(next.source);
// DMMのaf_id置換はDMM用の処理のため、リプライ運用の種別（楽天）のURLには適用しない
const mainText = linkInReply
  ? buildMainText(next.body || next.text || '', '')
  : buildMainText(next.body || next.text || '', toDisplayUrl(next.url) || '');
const replyText = linkInReply ? (next.url || '') : '';
const topicTag = pickTopicTag(next);

if (DRY_RUN) {
  console.log('[DRY_RUN] 本体投稿:');
  console.log(mainText);
  console.log(`[DRY_RUN] media_type: ${next.imageUrl ? 'IMAGE' : 'TEXT'}`);
  console.log(`[DRY_RUN] topic_tag: ${topicTag || '(なし)'}`);
  if (next.imageUrl) console.log(`[DRY_RUN] 画像URL: ${next.imageUrl}`);
  if (replyText) {
    console.log('[DRY_RUN] リプライ(リンク):');
    console.log(replyText);
  }
  console.log(`[DRY_RUN] 本文文字数: ${mainText.length}/${THREADS_TEXT_LIMIT}`);
  console.log(`[DRY_RUN] source: ${next.source}${next.variant ? ` (variant: ${next.variant})` : ''}`);
  console.log(`[DRY_RUN] genres: ${(next.genres || []).join(', ') || '(なし)'}`);
  console.log('[DRY_RUN] 実際の投稿・posts.json/posted-ids.json更新・GAS送信は行いません');
  process.exit(0);
}

let mainPublishedId;

// ── 本体投稿（失敗したらここでexit(1)。next.statusは未更新のまま = 次回リトライ対象） ──
try {
  const mainCreationId = await createContainer({ text: mainText, imageUrl: next.imageUrl || undefined, topicTag });
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

// ── リプライ投稿（リンク）。本体確定後の非致命的な処理のため、失敗してもexit(1)しない ──
if (replyText) {
  try {
    const replyCreationId = await createContainer({ text: replyText, replyToId: mainPublishedId });
    console.log(`リプライ:\n${replyText}\n`);
    await new Promise(r => setTimeout(r, 3000));
    const replyPublishedId = await publishContainer(replyCreationId);
    console.log('リプライ投稿完了！');
    console.log(`公開ID: ${replyPublishedId}`);
  } catch (err) {
    // 本体は公開・記録済みのためリプライ失敗は警告に留める。リンクなしの投稿が残るが自動リトライはしない
    console.error('リプライ投稿失敗（本体投稿は成功済み）:', err.message);
  }
}
