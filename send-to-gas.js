// GAS Web AppエンドポイントにエンゲージメントデータをPOSTするヘルパー
// x-auto-post/send-to-gas.jsと同一実装。X/Threads統合済みのengagement-recorder.gsに
// platform: 'threads' を明示して送る（呼び出し元のfetch-dmm.js/post-threads.js側で付与）。

const GAS_ENDPOINT = process.env.GAS_ENDPOINT;

export async function sendToGAS(data) {
  if (!GAS_ENDPOINT) return; // エンドポイント未設定時はスキップ
  try {
    const res = await fetch(GAS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      redirect: 'follow', // GASはリダイレクトするため必須
    });
    const json = await res.json();
    if (json.status !== 'ok') {
      console.error('GAS記録エラー:', json.message);
    }
  } catch (err) {
    console.error('GAS送信失敗:', err.message);
  }
}
