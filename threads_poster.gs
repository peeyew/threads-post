// ============================================================
// Threads 投稿スクリプト（Google Apps Script）
// 事前にScript Propertiesに以下を設定：
//   THREADS_ACCESS_TOKEN : アクセストークン
//   THREADS_USER_ID      : ThreadsユーザーID（getMyUserId()で取得可能）
// ============================================================

const SHEET_NAME  = 'posts';
const STATUS_POST = '投稿する';
const STATUS_DONE = '投稿済';
const STATUS_ERROR = 'エラー';

// ------------------------------------------------------------
// Web App エンドポイント：Claude Codeからの投稿追記
// POSTボディ: { "text": "投稿内容" }
// ------------------------------------------------------------
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const text = body.text;

    if (!text || !text.trim()) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'text is empty' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);

    // シートがなければ自動作成
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.getRange(1, 1, 1, 4).setValues([['No.', '本文', 'ステータス', '投稿日時']]).setFontWeight('bold');
      sheet.setColumnWidth(1, 50);
      sheet.setColumnWidth(2, 450);
      sheet.setColumnWidth(3, 100);
      sheet.setColumnWidth(4, 150);
    }

    const lastRow = sheet.getLastRow();
    const nextNo  = lastRow < 1 ? 1 : lastRow;

    sheet.appendRow([nextNo, text.trim(), STATUS_POST, '']);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, no: nextNo }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ------------------------------------------------------------
// タイマートリガー用：「投稿する」を1件だけ投稿
// ------------------------------------------------------------
function postToThreads() {
  const props  = PropertiesService.getScriptProperties();
  const token  = props.getProperty('THREADS_ACCESS_TOKEN');
  const userId = props.getProperty('THREADS_USER_ID');

  if (!token || !userId) {
    Logger.log('THREADS_ACCESS_TOKEN または THREADS_USER_ID が未設定です');
    return;
  }

  const sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();

  for (let i = 0; i < data.length; i++) {
    const text   = String(data[i][1]); // B列: 本文
    const status = String(data[i][2]); // C列: ステータス
    const rowIndex = i + 2;

    if (status !== STATUS_POST) continue;
    if (!text.trim()) continue;

    try {
      const containerId = createContainer(userId, token, text);
      Utilities.sleep(3000); // 公開前の待機（API推奨）
      publishContainer(userId, token, containerId);

      sheet.getRange(rowIndex, 3).setValue(STATUS_DONE);
      sheet.getRange(rowIndex, 4).setValue(
        Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')
      );

      Logger.log(`投稿完了 行${rowIndex}: ${text.slice(0, 30)}...`);

    } catch (err) {
      sheet.getRange(rowIndex, 3).setValue(STATUS_ERROR);
      sheet.getRange(rowIndex, 4).setValue('ERR: ' + err.message);
      Logger.log(`エラー 行${rowIndex}: ${err.message}`);
    }

    break; // 1件だけ投稿して終了
  }
}

// ------------------------------------------------------------
// Threads API: メディアコンテナ作成
// ------------------------------------------------------------
function createContainer(userId, token, text) {
  const url = `https://graph.threads.net/v1.0/${userId}/threads`;
  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    payload: { text: text, media_type: 'TEXT', access_token: token },
    muteHttpExceptions: true
  });

  const result = JSON.parse(res.getContentText());
  if (!result.id) throw new Error(JSON.stringify(result));
  return result.id;
}

// ------------------------------------------------------------
// Threads API: コンテナ公開
// ------------------------------------------------------------
function publishContainer(userId, token, containerId) {
  const url = `https://graph.threads.net/v1.0/${userId}/threads_publish`;
  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    payload: { creation_id: containerId, access_token: token },
    muteHttpExceptions: true
  });

  const result = JSON.parse(res.getContentText());
  if (!result.id) throw new Error(JSON.stringify(result));
  return result.id;
}

// ------------------------------------------------------------
// 補助：ユーザーIDを取得（初回設定時に一度だけ実行）
// ------------------------------------------------------------
function getMyUserId() {
  const token = PropertiesService.getScriptProperties().getProperty('THREADS_ACCESS_TOKEN');
  if (!token) {
    SpreadsheetApp.getUi().alert('先に THREADS_ACCESS_TOKEN を設定してください');
    return;
  }

  const res = UrlFetchApp.fetch(
    `https://graph.threads.net/v1.0/me?fields=id,username&access_token=${token}`,
    { muteHttpExceptions: true }
  );
  const result = JSON.parse(res.getContentText());

  if (result.id) {
    SpreadsheetApp.getUi().alert(
      `ユーザーID : ${result.id}\nユーザー名 : ${result.username}`
    );
  } else {
    SpreadsheetApp.getUi().alert('取得失敗: ' + JSON.stringify(result));
  }
}

// ------------------------------------------------------------
// 補助：シートの初期化
// ------------------------------------------------------------
function initSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  const headers = ['No.', '本文', 'ステータス', '投稿日時'];
  sheet.getRange(1, 1, 1, 4).setValues([headers]).setFontWeight('bold');
  sheet.setColumnWidth(1, 50);
  sheet.setColumnWidth(2, 450);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(4, 150);

  SpreadsheetApp.getUi().alert('シートを初期化しました');
}
