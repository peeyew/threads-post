import dotenv from 'dotenv';

dotenv.config();

const GAS_URL = process.env.GAS_WEBHOOK_URL;

const text = process.argv[2];
if (!text?.trim()) {
  console.error('使い方: node add-post.js "投稿テキスト"');
  process.exit(1);
}

if (!GAS_URL) {
  console.error('.envに GAS_WEBHOOK_URL が設定されていません');
  process.exit(1);
}

const res = await fetch(GAS_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: text.trim() }),
});

const data = await res.json();

if (data.ok) {
  console.log(`✓ シートに追記しました (No.${data.no}): ${text.slice(0, 40)}...`);
} else {
  console.error('✗ エラー:', data.error);
  process.exit(1);
}
