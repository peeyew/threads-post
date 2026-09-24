// engagementスプレッドシートのthreadsタブに記録済みの投稿について、
// Threads Insights APIの最新値（閲覧数・いいね・返信・リポスト・引用・シェア）で更新する。
// x-auto-post/log-engagement.js（X向け）のThreads版。GAS側が正で、ローカルには状態を持たない。
import dotenv from 'dotenv';
import { sendToGAS } from './send-to-gas.js';
import { isValidThreadsId, fetchThreadsInsights } from './threads-insights.js';

dotenv.config();

const GAS_ENDPOINT = process.env.GAS_ENDPOINT;
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const MAX_TARGETS = 30;
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

if (!GAS_ENDPOINT || !ACCESS_TOKEN) {
  console.log('GAS_ENDPOINTまたはTHREADS_ACCESS_TOKENが未設定のためスキップ');
  process.exit(0);
}

const res = await fetch(`${GAS_ENDPOINT}?action=get_threads_data`, { redirect: 'follow' });
const rows = await res.json();

if (!Array.isArray(rows) || rows.length === 0) {
  console.log('threadsタブにデータがありません');
  process.exit(0);
}

// 24時間以上前に更新された行を古い順に最大30件。不正なIDはAPIに渡さず警告のみ出す
const now = Date.now();
const candidates = rows
  .filter(r => !r.updatedAt || now - new Date(r.updatedAt).getTime() > MIN_INTERVAL_MS)
  .sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));

const targets = [];
for (const r of candidates) {
  if (isValidThreadsId(String(r.threadsId))) {
    if (targets.length < MAX_TARGETS) targets.push(r);
  } else {
    console.warn(`不正なThreads投稿IDをスキップ: ${JSON.stringify(r.threadsId)} (type=${r.type || ''})`);
  }
}

if (targets.length === 0) {
  console.log('更新対象なし');
  process.exit(0);
}

console.log(`${targets.length}件のインサイトを取得中...`);
let updated = 0;
for (const row of targets) {
  try {
    const insights = await fetchThreadsInsights(String(row.threadsId), ACCESS_TOKEN);
    console.log(`[${row.type}] ${row.keyword || ''} 閲覧:${insights.views ?? '-'} いいね:${insights.likes ?? '-'} 返信:${insights.replies ?? '-'}`);
    // GAS側はID一致の行を丸ごと上書きするため、type/keyword/genres/postedAtも渡し直す
    await sendToGAS({
      id: String(row.threadsId),
      type: row.type || '',
      keyword: row.keyword || '',
      genres: row.genres || '',
      postedAt: row.postedAt || '',
      platform: 'threads',
      ...insights,
    });
    updated++;
  } catch (err) {
    // 削除済み投稿など1件の失敗で他を巻き添えにしない
    console.error(err.message);
  }
}
console.log(`${updated}件のエンゲージメントを更新しました`);
