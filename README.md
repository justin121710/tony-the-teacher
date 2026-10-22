<p align="center"><img src="icons/logo-1024.png" width="160" alt="Tony the Teacher logo"></p>

<h1 align="center">Tony the Teacher｜Tony老師</h1>
<p align="center">給獨立髮型設計師的預約小幫手：快速記預約、超時一鍵順延、客人線上預約。</p>

---

## 網址

| 給誰 | 網址 |
|---|---|
| 設計師（加到手機主畫面使用） | https://justin121710.github.io/tony-the-teacher/ |
| 客人線上預約 | 在 APP「管理 → 設定 → 客人線上預約」複製（開啟雲端後才有） |

## 功能

- **今天一眼看懂**：進行中的客人一張大卡片，服務用顏色區分，稱呼和電話都是選填。
- **超時提醒**：預計時間到了還沒按「做完了」，響鈴＋震動，選擇順延幾分鐘或忽略（5 分鐘後再提醒）。
- **一鍵順延**：只移動真的會撞到的預約，並帶出寫好的簡訊通知客人。
- **客人線上預約**：選服務 → 選空檔 → 留電話，設計師在 APP 裡接受或婉拒；送出時會先佔住時段，避免兩位客人同時搶到。
- **收入統計、客人紀錄、營業時間、公休日、服務項目**自訂。
- 可加到主畫面當 APP 用（PWA），沒網路時也打得開。

## 兩種模式

| | 單機版（預設） | 雲端版 |
|---|---|---|
| 設定 | 不用設定 | 建一個免費 Firebase 專案，貼上設定 |
| 資料存在 | 這支手機 | Google Firebase |
| 客人線上預約 | ✗ | ✓ |
| 換手機 | 匯出／匯入備份 | 登入即可 |

雲端設定步驟見《操作手冊》附錄，或 APP 內「管理 → 設定 → 開啟雲端同步」。

## 檔案

| 檔案 | 說明 |
|---|---|
| `index.html` | 設計師 APP |
| `book.html` | 客人預約頁 |
| `config.js` | （選用）把 Firebase 設定寫死在這裡，所有手機自動連線 |
| `firestore.rules` | Firestore 安全規則範本（APP 內會自動帶入登入 Email） |
| `sw.js`、`manifest.webmanifest`、`icons/` | 主畫面 APP 與離線快取 |
| `docs/操作手冊.pdf` | 操作手冊 |

純 HTML／JavaScript，不需要建置，放在任何靜態主機（GitHub Pages、Netlify）即可。
