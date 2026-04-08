import dotenv from 'dotenv';
import { writeFileSync, readFileSync } from 'fs';

dotenv.config();

const APP_SECRET = process.env.THREADS_APP_SECRET;
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;

try {
  const res = await fetch(
    `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${ACCESS_TOKEN}`
  );
  const data = await res.json();
  console.log('レスポンス:', data);

  if (!data.access_token) throw new Error('トークン取得失敗');

  console.log('新しいトークン:', data.access_token);
  console.log('有効期限(秒):', data.expires_in);

  // GitHub Actions の場合はoutputに書き出す
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `new_token=${data.access_token}\n`, { flag: 'a' });
    console.log('GitHub Outputに書き出しました');
  }
} catch (err) {
  console.error('トークン更新失敗:', err.message);
  process.exit(1);
}
