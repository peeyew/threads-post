// DMMアフィリエイトAPI（ItemList、site=DMM.com＝FANZAを除く一般カテゴリ）から
// ランキング上位商品を取得してposts.jsonに保存する。x-auto-post/fetch-fanza.jsを
// DMM.com一般・Threads向けに移植したもの。
//
// DMM_SLOT環境変数で取得対象を切り替える:
//   dmmtv → DMM TV（service=dmmtv, floor=dmmtv_video）。1日2枠。
//           このfloorはItemList APIがimageURLを一切返さないため、画像なしの
//           TEXT投稿になる前提でimageUrlチェックをスキップする（post-threads.js側で対応）。
//   ebook → DMMブックス（service=ebook, floor=comic/photo/novel/otherbooksからランダム1つ）。
//           1日1枠。こちらはimageURLが必須（画像付きIMAGE投稿にするため）。
//
// 【DMM_TV_MODE（DMM_SLOT=dmmtvの場合のみ有効）について】
// DMM TVのアニメジャンル投稿を「最新作」「過去の人気作」の2系統に分けるための指定。
// dmmtv_videoのItemList APIレスポンスにはgenre情報が構造的に存在しない（iteminfo自体が
// 返らない）ため、ジャンル絞り込みはkeyword=アニメによるキーワード検索で代用する
// （実データ確認済み: sort/GenreSearch APIともにdmmtv_videoのジャンルマスタは未整備）。
// keyword検索はタイトル・説明文に「アニメ」が含まれる非アニメ作品（恋愛リアリティ系等）
// を誤ってヒットさせることがあるため、精度は完全ではない。運用しながら見つかった誤爆は
// config/dmmtv-anime-exclude-words.jsonに追記して弾く方針（方針B）。
//   latest  → sort=date（新着順）
//   popular → sort=review（評価順。「過去の人気作」の指標として件数より平均評価を採用）
// 未指定の場合は従来通りsort=rank・keywordなしのランキング取得を維持する。
//
// 【1cron実行=1投稿の設計について】
// TARGET_COUNTのデフォルトは1。post-threads.js側は「posts.json中の先頭のpendingを
// 1件だけ消化する」実装のため、TARGET_COUNTを1より大きくすると消化が追いつかず
// posts.jsonにpendingが際限なく積み上がる（投稿間隔を空ける設計にも反する）。
// 複数件まとめて取得したい特別な事情がある場合のみDMM_HITS環境変数で上書きすること。
//
// 【posted-ids.jsonへの書き込みについて】
// このファイルではposted-ids.jsonを読み取り専用で参照するのみで、書き込みは行わない。
// 記録は「実際に投稿が成功した後」に post-threads.js が行う（fetch時点で記録すると、
// 投稿が何らかの理由で失敗した場合にpendingのまま二度とfetchされなくなるため）。
// その代わり、まだ投稿されていないpending中の商品を重複取得しないよう、posts.json内の
// status:'pending'エントリのcontentIdもここで除外対象に含める。
import dotenv from 'dotenv';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { generateBody, loadRecentBodies, fallbackBody } from './copywriter.js';

dotenv.config();

const API_ID = process.env.DMM_API_ID;
const AFFILIATE_ID = process.env.DMM_AFFILIATE_ID_THREADS;
const SITE = 'DMM.com'; // FANZAを含めない一般カテゴリ固定

const SLOT = process.env.DMM_SLOT; // 'dmmtv' | 'ebook'
if (SLOT !== 'dmmtv' && SLOT !== 'ebook') {
  console.error(`DMM_SLOTは'dmmtv'または'ebook'を指定してください（実際: ${SLOT}）`);
  process.exit(1);
}

const EBOOK_FLOORS = ['comic', 'photo', 'novel', 'otherbooks'];
const SERVICE = SLOT === 'dmmtv' ? 'dmmtv' : 'ebook';
const FLOOR = process.env.DMM_FLOOR
  || (SLOT === 'dmmtv' ? 'dmmtv_video' : EBOOK_FLOORS[Math.floor(Math.random() * EBOOK_FLOORS.length)]);

// DMM_TV_MODE: DMM_SLOT=dmmtvの場合のみ意味を持つ。'latest'(新着順)または'popular'(評価順)。
// 未指定なら従来通りランキング取得（sort=rank・keywordなし）を維持する。
const DMM_TV_MODE = process.env.DMM_TV_MODE;
if (DMM_TV_MODE && !['latest', 'popular'].includes(DMM_TV_MODE)) {
  console.error(`DMM_TV_MODEは'latest'または'popular'を指定してください（実際: ${DMM_TV_MODE}）`);
  process.exit(1);
}
const SORT = DMM_TV_MODE === 'latest' ? 'date' : DMM_TV_MODE === 'popular' ? 'review' : 'rank';
// dmmtv_videoのItemList APIはgenre情報を返さないため、ジャンル絞り込みはkeyword検索で代用する
const KEYWORD = SLOT === 'dmmtv' && DMM_TV_MODE ? 'アニメ' : '';

// DMM TVはItemList APIがimageURLを返さないため、画像なし(TEXT投稿)を許容する。
// DMMブックスは画像付きIMAGE投稿にする方針のため、imageURLがない商品は除外する。
const REQUIRE_IMAGE = SLOT === 'ebook';

const TARGET_COUNT = Number(process.env.DMM_HITS || '1');
// 1回のAPIリクエストで取得する件数（重複・NGワードでの脱落を見込んで多めに取る）
const PAGE_SIZE = Math.max(TARGET_COUNT * 20, 20);
// ページングの安全上限（無限ループ防止。ランキングを掘り尽くしたら諦める）
const MAX_OFFSET = Number(process.env.DMM_MAX_OFFSET || '500');

const POSTED_IDS_FILE = './posted-ids.json';
const POSTED_ID_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90日

// 読み取り専用。TTL切れの除外は行うが、このファイル自体への書き戻しはpost-threads.jsの責務。
const rawPostedEntries = existsSync(POSTED_IDS_FILE)
  ? JSON.parse(readFileSync(POSTED_IDS_FILE, 'utf-8'))
  : [];
const now = Date.now();
const validPostedIds = new Set(
  rawPostedEntries
    .filter(entry => now - new Date(entry.postedAt).getTime() < POSTED_ID_TTL_MS)
    .map(entry => entry.contentId)
);

// posts.json内でまだ消化されていない(pending)商品も重複取得の対象から除外する
const postsFile = './posts.json';
const existingPosts = existsSync(postsFile)
  ? JSON.parse(readFileSync(postsFile, 'utf-8'))
  : [];
const pendingIds = new Set(
  existingPosts.filter(p => p.status === 'pending' && p.contentId).map(p => p.contentId)
);

const excludedIds = new Set([...validPostedIds, ...pendingIds]);

// NGワードフィルタ（未成年を想起させる語を含む商品はposts.jsonに書き込まない）
// リストはconfig/ng-words.jsonで管理（要調整時はそちらだけ編集すればよい）
const ngWords = JSON.parse(readFileSync('./config/ng-words.json', 'utf-8'));
// DMM TVのkeyword=アニメ検索は非アニメ作品（恋愛リアリティ系等）を誤って拾うことがあるため、
// DMM_TV_MODE指定時のみ追加の除外ワードリストも適用する（運用しながら都度追記する方針）。
const animeExcludeWords = DMM_TV_MODE && existsSync('./config/dmmtv-anime-exclude-words.json')
  ? JSON.parse(readFileSync('./config/dmmtv-anime-exclude-words.json', 'utf-8'))
  : [];
const allExcludeWords = [...ngWords, ...animeExcludeWords];
const hasNgWord = title => allExcludeWords.some(word => title.includes(word));

async function fetchPage(offset) {
  const keywordParam = KEYWORD ? `&keyword=${encodeURIComponent(KEYWORD)}` : '';
  const url = `https://api.dmm.com/affiliate/v3/ItemList?api_id=${API_ID}&affiliate_id=${AFFILIATE_ID}&site=${SITE}&service=${SERVICE}&floor=${FLOOR}&hits=${PAGE_SIZE}&offset=${offset}&sort=${SORT}${keywordParam}&output=json`;
  const res = await fetch(url);
  const data = await res.json();
  const result = data.result;
  if (!res.ok || !result || Number(result.status) !== 200 || !Array.isArray(result.items)) {
    throw new Error(result?.result_message || `${res.status}`);
  }
  return result.items.map(item => ({
    contentId: item.content_id || item.product_id || item.URL,
    title: item.title,
    price: item.prices?.price ?? null,
    imageUrl: item.imageURL?.large || item.imageURL?.list || item.imageURL?.small || '',
    url: item.affiliateURL || item.URL,
    genres: (item.iteminfo?.genre || []).map(g => g.name),
  }));
}

console.log(`DMM.com一般(${SERVICE}/${FLOOR})sort=${SORT}${KEYWORD ? `&keyword=${KEYWORD}` : ''}${DMM_TV_MODE ? `[variant=${DMM_TV_MODE}]` : ''}取得中...`);

const newPosts = [];
let skippedNg = 0;
let skippedDuplicate = 0;
let skippedNoImage = 0;
let offset = 1;
// 過去投稿＋今回すでに生成した本文（新しい順）。copy-writerへの重複回避コンテキストに使う
const recentBodies = loadRecentBodies();

try {
  while (newPosts.length < TARGET_COUNT && offset <= MAX_OFFSET) {
    const items = await fetchPage(offset);
    if (items.length === 0) break; // ランキングの末尾に到達

    for (const item of items) {
      if (newPosts.length >= TARGET_COUNT) break;
      if (!item.url) continue;

      if (REQUIRE_IMAGE && !item.imageUrl) {
        skippedNoImage++;
        continue;
      }

      if (excludedIds.has(item.contentId)) {
        skippedDuplicate++;
        continue;
      }

      if (hasNgWord(item.title)) {
        skippedNg++;
        console.log(`NGワード該当のためスキップ: ${item.title.slice(0, 40)}...`);
        continue;
      }

      let body;
      try {
        const result = await generateBody(
          { source: SLOT, title: item.title, genres: item.genres, price: item.price },
          recentBodies
        );
        body = result.text;
      } catch (err) {
        console.error(`copywriter呼び出し失敗、定型文にフォールバック: ${err.message}`);
        body = fallbackBody(SLOT, item.title);
      }
      recentBodies.unshift(body);

      newPosts.push({
        contentId: item.contentId,
        source: SLOT,
        ...(DMM_TV_MODE ? { variant: DMM_TV_MODE } : {}),
        body,
        imageUrl: item.imageUrl || '',
        url: item.url,
        genres: item.genres || [],
        status: 'pending',
        created: new Date().toISOString(),
      });
      excludedIds.add(item.contentId); // 同一実行内での重複追加も防ぐ
    }

    offset += PAGE_SIZE;
  }
} catch (err) {
  console.error('エラー:', err.message);
  process.exit(1);
}

console.log(`新規${newPosts.length}件（重複${skippedDuplicate}件・NGワード${skippedNg}件・画像なし${skippedNoImage}件をスキップ）`);

// posts.jsonに追記（posted-ids.jsonへの書き込みはここでは行わない。post-threads.js参照）
const merged = [...existingPosts, ...newPosts];
writeFileSync(postsFile, JSON.stringify(merged, null, 2), 'utf-8');
console.log(`posts.jsonに${newPosts.length}件追加しました（合計${merged.length}件）`);
