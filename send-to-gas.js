// GAS Web AppエンドポイントにエンゲージメントデータをPOSTするヘルパー
// x-auto-post/send-to-gas.jsと同一実装。engagement-recorder.gsはplatform: 'threads'を
// 同一スプレッドシート内のthreadsタブに振り分ける（Xのengagementタブとは混ぜない）。

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
