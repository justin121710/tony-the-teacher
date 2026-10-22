/*
 * Tony老師 — 雲端設定
 *
 * 一般使用者不需要改這個檔案：在 APP「管理 → 設定 → 開啟雲端同步」貼上設定即可。
 *
 * 進階：如果想讓所有手機打開就自動連到同一個 Firebase（不用每支手機貼一次），
 * 可以把 null 換成 Firebase 的 firebaseConfig，例如：
 *
 *   firebase: {
 *     apiKey: "AIza...",
 *     authDomain: "tony-the-teacher.firebaseapp.com",
 *     projectId: "tony-the-teacher",
 *     appId: "1:123:web:abc"
 *   }
 *
 * （Firebase 網頁設定本來就是公開的，安全性靠資料庫安全規則把關。）
 */
window.TONY_CONFIG = {
  firebase: null
};
