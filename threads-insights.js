// Threads Graph APIのインサイト取得と、Threads投稿IDのバリデーション。
// post-threads.js（投稿直後の初回記録）とupdate-threads-engagement.js（日次更新）で共用する。

const GRAPH_BASE = 'https://graph.threads.net/v1.0';

// ThreadsのmediaIDは数字のみの文字列（17桁前後）。x-auto-post側で"diag-final-test"のような
// 診断・テストの残骸がシートに混入して一括取得が壊れた事故を避けるため、
// シートへ書き込む前・APIへ渡す前の両方でこの検証を通す
export function isValidThreadsId(id) {
  return typeof id === 'string' && /^[0-9]{5,30}$/.test(id);
}

// 投稿のインサイトを取得する。取得できた指標のみを含むオブジェクトを返す
// （未取得の指標は含めない = シート上は「未計測(空欄)」になり、0と区別できる）。
// views/likes/replies/reposts/quotes/sharesはThreads Insights APIのmediaメトリクス。
export async function fetchThreadsInsights(mediaId, accessToken) {
  if (!isValidThreadsId(mediaId)) {
    throw new Error(`不正なThreads投稿ID: ${JSON.stringify(mediaId)}`);
  }
  const params = new URLSearchParams({
    metric: 'views,likes,replies,reposts,quotes,shares',
    access_token: accessToken,
  });
  const res = await fetch(`${GRAPH_BASE}/${mediaId}/insights?${params}`);
  const json = await res.json();
  if (!Array.isArray(json.data)) {
    throw new Error(`インサイト取得失敗(${mediaId}): ${JSON.stringify(json.error || json)}`);
  }
  const result = {};
  for (const m of json.data) {
    const value = m.values?.[0]?.value ?? m.total_value?.value;
    if (typeof value === 'number') result[m.name] = value;
  }
  return result;
}
