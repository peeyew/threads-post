import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config();

const SHEET_ID     = process.env.GOOGLE_SHEET_ID;
const KEY_FILE     = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // サービスアカウントJSONのパス
const USER_ID      = process.env.THREADS_USER_ID;
const ACCESS_TOKEN = process.env.THREADS_ACCESS_TOKEN;
const SHEET_NAME   = 'posts';

const STATUS_POST  = '投稿する';
const STATUS_DONE  = '投稿済';
const STATUS_ERROR = 'エラー';

// ── 認証・Sheetsクライアント取得 ──────────────────────────────
async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ── シートからデータ取得（A2:D 全行）────────────────────────
async function getRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A2:D`,
  });
  return res.data.values || [];
}

// ── ステータスと投稿日時を更新 ────────────────────────────────
async function updateRow(sheets, rowIndex, status, datetime) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!C${rowIndex}:D${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status, datetime]] },
  });
}

// ── Threads: メディアコンテナ作成 ─────────────────────────────
async function createContainer(text) {
  const res = await fetch(
    `https://graph.threads.net/v1.0/${USER_ID}/threads`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'TEXT',
        text,
        access_token: ACCESS_TOKEN,
      }),
    }
  );
  const data = await res.json();
  if (!data.id) throw new Error(JSON.stringify(data));
  return data.id;
}

// ── Threads: コンテナ公開 ─────────────────────────────────────
async function publishContainer(containerId) {
  const res = await fetch(
    `https://graph.threads.net/v1.0/${USER_ID}/threads_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: ACCESS_TOKEN,
      }),
    }
  );
  const data = await res.json();
  if (!data.id) throw new Error(JSON.stringify(data));
  return data.id;
}

// ── JST現在日時を文字列で返す ─────────────────────────────────
function nowJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);
}

// ── メイン ────────────────────────────────────────────────────
const sheets = await getSheets();
const rows   = await getRows(sheets);

let postedCount = 0;

for (let i = 0; i < rows.length; i++) {
  const [, text, status] = rows[i];
  const rowIndex = i + 2; // 2行目スタート（1行目はヘッダー）

  if (status !== STATUS_POST) continue;
  if (!text?.trim()) continue;

  try {
    const containerId = await createContainer(text);
    await new Promise(r => setTimeout(r, 3000)); // 公開前の待機（API推奨）
    await publishContainer(containerId);

    await updateRow(sheets, rowIndex, STATUS_DONE, nowJST());
    console.log(`✓ 行${rowIndex} 投稿完了: ${text.slice(0, 30)}...`);
    postedCount++;

    break; // 1件だけ投稿して終了
  } catch (err) {
    await updateRow(sheets, rowIndex, STATUS_ERROR, `ERR: ${err.message}`);
    console.error(`✗ 行${rowIndex} エラー: ${err.message}`);
    break; // エラーでも1件で止める
  }
}

console.log(`\n完了: ${postedCount}件投稿しました`);
