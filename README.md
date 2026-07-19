# 予定管理DiscordBOT

Discordだけで会議の登録、参加者へのDM、出欠集計、個人別リマインド、開始時の`@everyone`通知を管理する公開テンプレートです。

管理者は`/meeting`コマンドでも、通常チャンネルでBotを直接メンションした自然な日本語でも操作できます。約15人の固定チームを想定し、名前付き参加者テンプレートと既定テンプレートを備えています。

非技術者向けの説明は[USER_GUIDE.md](./USER_GUIDE.md)にあります。

## 主な機能

- 会議名・日時・URL・通知時刻を自然な日本語から登録
- 登録前の確認画面。確定前は会議もDMも作成しない
- 名前付き参加者テンプレート、既定テンプレート、今回だけDMなし
- 「参加・未定・欠席」ボタンと未回答者集計
- 招待DMへ普通の日本語で出欠回答
- 各メンバーが自分の通知を`1時間前と10分前`のように複数設定
- 会議ごとの一時的な個人通知と、今後の既定通知を分離
- DM回答後に「確認しました」、会議名、日時、出欠、通知設定、URLボタンを返信
- 30分前などのチャンネル通知と、指定時刻の自動`@everyone`
- SQLiteによる再起動復旧、配信claim、重複送信防止
- Google Sheetsへの任意ミラー同期。URL同期は既定で無効
- 会議・URL・Discord ID・メンバー対応表を分離するプライバシー設計

## すぐに試す

必要なものはNode.js 24以上と、新規Discord Application / Botです。自然言語で会議を作成・更新する場合だけOpenAI APIキーを使います。

```powershell
git clone https://github.com/OWNER/YoteiKanriDiscordBOT.git
Set-Location -LiteralPath "YoteiKanriDiscordBOT"
npm.cmd install
Copy-Item -LiteralPath ".env.example" -Destination ".env"
```

`.env`へ最低限次の3項目を設定します。値をREADME、Issue、コミットへ貼らないでください。

```env
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
OPENAI_API_KEY=
OPENAI_MEETING_MODEL=gpt-5.6-terra
OPENAI_REASONING_EFFORT=medium
```

起動します。

```powershell
npm.cmd start
```

起動時に対象サーバーへ`/meeting`を登録し、`data/meetings.sqlite3`を自動作成します。

## Discord側の準備

Discord Developer Portalで専用Applicationを作成し、Botを追加します。既存Botのトークンを流用しないことを推奨します。

このBotは`GUILDS`、`GUILD_MESSAGES`、`DIRECT_MESSAGES`だけを要求し、特権的な`MESSAGE CONTENT INTENT`を要求しません。サーバー内ではBot自身が直接メンションされたメッセージだけを自然言語操作の対象にします。

招待URLには`bot`と`applications.commands`スコープを付け、次の権限を許可します。

- チャンネルを見る
- メッセージを送信
- 埋め込みリンク
- メッセージ履歴を読む
- `@everyone`、`@here`、すべてのロールにメンション
- アプリコマンドを使う

`Administrator`は不要です。

## 固定メンバーを最初に登録する

まず、Discordメンバーへサーバー内だけで使う呼び名を付けます。

```text
@予定管理 @対象メンバー を メンバーA として登録して
```

同じ操作は`/meeting member-add`でもできます。呼び名とDiscord IDの対応はローカルSQLiteだけに保存し、OpenAIやSheetsへ送りません。

次に参加者テンプレートを保存します。

```text
@予定管理 テンプレート「全体定例」として
参加者: メンバーA、メンバーB、メンバーC
を保存
```

```text
@予定管理 テンプレート「全体定例」を既定にして
```

既定テンプレートを設定すると、会議登録のたびに参加者を書かなくても、その時点のメンバー一覧を会議へコピーします。あとでテンプレートを変更しても、作成済み会議の参加者は勝手に変わりません。

## 会議を登録する

```text
@予定管理 来週月曜20時30分から全体定例を1時間。
URL: https://meet.example.com/team
30分前と開始時にチャンネル通知して
```

黄色い確認画面で日時、URLが登録済みであること、個別DMの相手を確認して「登録する」を押します。

別テンプレートを使う場合:

```text
参加者テンプレート: 少人数レビュー
```

今回だけ個別DMを送らない場合:

```text
参加者: なし
```

AIを使わず項目を直接入力する場合は`/meeting create`を使います。

## `/meeting`と`@Bot`の対応

すべてのSlash Commandに、通常チャンネルの直接メンション経路があります。

| Slash Command | 通常チャンネルの例 | 利用者 |
|---|---|---|
| `create` | `来週月曜20:30から定例、URLは…` | 管理者 |
| `url` | `MEET0001のURLを…へ変更` | 管理者 |
| `list` | `今後の会議を見せて` | 全員 |
| `status` | `MEET0001の出欠状況` | 全員 |
| `cancel` | `MEET0001を中止して` | 管理者 |
| `member-add` | `@メンバーをメンバーAとして登録` | 管理者 |
| `member-list` | `呼び名一覧を見せて` | 管理者 |
| `member-remove` | `呼び名「メンバーA」を削除` | 管理者 |
| `template-save` | `テンプレート「全体定例」として参加者: …を保存` | 管理者 |
| `template-list` | `テンプレート一覧を見せて` | 管理者 |
| `template-show` | `テンプレート「全体定例」を見せて` | 管理者 |
| `template-default` | `テンプレート「全体定例」を既定にして` | 管理者 |
| `template-remove` | `テンプレート「全体定例」を削除` | 管理者 |
| `invite` | `MEET0001の招待DMを参加者: …へ送って` | 管理者 |
| `my-reminders` | `自分の通知設定を見せて` | 本人 |
| `help` | `使い方` | 全員 |

管理操作は「サーバー管理」「イベントの管理」、または`MEETING_CREATOR_ROLE_IDS`で指定したロールだけが使えます。出欠と自分の通知設定は本人が操作できます。

## 招待された人の使い方

招待DMには会議名、日時、現在の個人通知、URLボタン、出欠ボタンが表示されます。文章でも回答できます。

```text
参加します
```

```text
未定です。今回は1時間前と10分前に通知して
```

```text
欠席します
```

```text
今後は毎回1時間前と10分前に通知して
```

会議が複数ある場合は`MEET0001 参加`のように会議IDを付けます。DMだけでなく、通常チャンネルで`@予定管理 MEET0001の会議に参加します`と回答することもできます。公開チャンネルの確認返信には会議URLを再掲しません。

## プライバシー設計

自然言語の便利さを残しながら、識別情報とURLをAI入力から分離します。

1. Discordメッセージをローカルで受信
2. URL、Discordメンション、Discord ID、メールアドレス、登録済み呼び名、テンプレート名を抽出または伏せ字化
3. URLや識別子が残っていないことを再検査
4. 伏せ字本文と「URLがあるか」の真偽値だけをOpenAI Responses APIへ送信
5. `store: false`を明示し、会議名・日時・通知時刻だけをJSON Schemaで受け取る
6. AI出力にURLが含まれた場合は結果全体を破棄
7. ローカルに退避したURLと結果を、管理者の確認後にSQLiteで結合

| 情報 | OpenAIへ送信 | 保存先 |
|---|---:|---|
| 会議URL | しない | SQLite、Discord |
| Discord ID・メンション | しない | SQLite、Discord処理 |
| 呼び名と本人の対応 | しない | SQLiteのみ |
| 参加者テンプレート名・構成 | しない | SQLiteのみ |
| DM本文 | しない・本文保存もしない | ルール判定後に破棄 |
| 出欠結果 | しない | SQLite、Discord、任意でSheets |
| 伏せ字化後の会議名・日時・通知表現 | 自然言語作成・更新時のみ | API処理対象 |

OpenAI APIの入出力は、組織またはプロジェクトがデータ共有へ明示的にオプトインしない限り、既定ではモデル学習に使われません。共有を有効にした場合は、その入出力が評価・学習に利用される場合があります。

`store:false`はResponses APIのResponseオブジェクト保存を無効にしますが、不正利用監視ログまで無効にするものではなく、Zero Data Retentionの保証でもありません。通常の不正利用監視ログにはプロンプトや応答が含まれる場合があり、既定では最大30日保持されます。ZDR / Modified Abuse Monitoringは対象顧客がOpenAIの承認を受ける別制度です。

`gpt-5.6-terra`は通常はAPI従量課金です。OpenAIの共有トラフィック特典へ登録済みの対象組織では無料トークン対象ですが、対象プロジェクトでの共有有効化、正のAPI残高、日次上限内であることが必要です。上限超過分は通常料金になります。最新条件はOpenAI公式の[データ共有特典](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)と[API料金表](https://developers.openai.com/api/docs/pricing)を確認してください。

そのため、このBotはデータ共有設定に頼らず、URLやDiscord識別子をAIへ送らない構成にしています。会議名そのものも外部APIへ出せない場合は、AIを使わない`/meeting create`と`/meeting url`を使ってください。詳細はOpenAI公式の[データ管理ガイド](https://developers.openai.com/api/docs/guides/your-data)、[Responses APIの保存説明](https://developers.openai.com/api/docs/guides/conversation-state)、[APIデータ利用方針](https://help.openai.com/en/articles/5722486-api-data-usage-policies)を確認してください。

## Google Sheets連携

SQLiteを正本、Sheetsを閲覧用ミラーとして扱います。Sheetsが停止してもDiscord通知と回答は継続します。

```env
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SERVICE_ACCOUNT_FILE=
GOOGLE_SHEETS_SYNC_URLS=false
```

サービスアカウントでSheets APIを有効化し、対象スプレッドシートをその`client_email`へ共有します。起動後に`会議一覧`、`出欠`、`通知ログ`を不足分だけ作成します。

`GOOGLE_SHEETS_SYNC_URLS=false`ではURL本体を同期しません。値は`RAW`で書き込み、数式注入を防止します。

## 公開WEBへの片方向同期（任意）

SQLiteを唯一の正本としたまま、公開用の最小スナップショットを任意のWEB受信口へHTTPS POSTできます。受信側からBotやSQLiteを書き換える経路はありません。

```env
MEETING_WEB_SYNC_URL=
MEETING_WEB_SYNC_SECRET=
MEETING_WEB_AUTH_TOKEN=
MEETING_WEB_SYNC_INTERVAL_SECONDS=60
MEETING_WEB_SYNC_TIMEOUT_MS=8000
MEETING_WEB_SYNC_MAX_RETRIES=2
```

`MEETING_WEB_SYNC_URL`と32文字以上の`MEETING_WEB_SYNC_SECRET`の両方がある場合だけ有効です。片方だけ、または両方未設定ならsnapshotの作成もHTTP通信も行いません。短いsecretは設定ミスとして起動時に拒否します。

OpenAI Sitesを所有者限定で公開した場合は、無人API通信用に発行したbypass tokenを`MEETING_WEB_AUTH_TOKEN`へ設定します。これはHMAC secretとは別の認証情報です。一般的なHMAC受信口で不要なら空欄のままにします。値はログ、projection本文、Gitへ出しません。

公開される値は次だけです。

- HMACから作る16文字の匿名`id`
- 開始・終了日時、状態
- チャンネル通知の時刻
- URL本体ではなく`registered` / `missing`だけ
- 参加・未定・欠席・未回答の人数

会議名、会議URL、内部会議ID、DiscordのGuild/Channel/Message/User ID、氏名、呼び名、DM設定、配信ログはprojectionへ入りません。会議名を公開する設定自体を用意していません。

各POSTは本文SHA-256と、次のcanonical文字列に対するHMAC-SHA256署名を付けます。

```text
POST
<設定URLのpathname>
<13桁timestampMs>
<nonce>
<bodySha256>
```

ヘッダーは`X-Meeting-Sync-Timestamp`、`X-Meeting-Sync-Nonce`、`X-Meeting-Sync-Body-SHA256`、`X-Meeting-Sync-Signature`です。payloadは`schemaVersion`、秘密を含まない`sourceRevision`、同じ`timestampMs`を使う`generatedAtMs`、`meetings`だけです。受信側は署名、timestampの許容時間、nonceの未使用を確認してリプレイを拒否してください。secretをGit、README、Issue、クライアント側JavaScriptへ入れてはいけません。secretを変更すると匿名IDも変わります。

## 通知の挙動

- チャンネル通知の既定は30分前と開始時
- `@everyone`の既定は開始時だけ
- 個人DM通知の初期値は1時間前と10分前
- 各人は今後の既定値、または特定会議だけの値を変更可能
- 欠席中の個人通知は送信せず、参加・未定へ戻すと未送信分を再生成
- 再起動後はSQLiteから未送信通知を復元
- 遅れすぎた通知は、復旧直後の突然の大量送信を避けるためスキップ

## モジュール構成

- `src/index.mjs`: Discordイベントと各モジュールの配線
- `src/coordinator.mjs`: 権限と操作のオーケストレーション
- `src/attendance-templates.mjs`: テンプレート自然言語解析
- `src/participant-resolution.mjs`: 明示・名前付き・既定テンプレートの優先順位
- `src/personal-reminders.mjs`: 個人通知の自然言語解析
- `src/self-service-controller.mjs`: DM/サーバー共通の本人操作
- `src/discord-direct-messenger.mjs`: 在籍確認付きDM送信
- `src/personal-reminder-scheduler.mjs`: 個人通知のclaimと配信
- `src/storage/`: テンプレート・個人通知の永続化
- `src/privacy.mjs`: AI送信前の秘密情報分離
- `src/interpreter.mjs`: OpenAI Structured Outputs
- `src/database.mjs`: SQLite会議・出欠・通知状態
- `src/scheduler.mjs`: チャンネル通知
- `src/sheets-sync.mjs`: 任意のSheetsミラー
- `src/web-projection.mjs`: WEB公開用の明示allowlist projection
- `src/web-sync.mjs`: HMAC署名付きの任意片方向WEB同期
- `src/discord-ui.mjs`: 会議カード、DM、ボタン

## テスト

```powershell
npm.cmd test
```

テストは秘密情報の分離、`store:false`、15人テンプレート、Slash/メンション経路、本人だけのDM回答、複数個人通知、欠席時停止と復帰、重複送信防止、SheetsのURL非同期と`RAW`書き込みを確認します。

## 公開前の安全確認

- `.env`、`data/`、SQLite、ログ、サービスアカウントJSONは`.gitignore`対象
- `.env.example`には値を入れない
- 実在メンバー名、サーバーID、会議URLをテストや説明へ書かない
- APIキーやBotトークンを貼った場合は、Git履歴削除だけでなく必ず失効・再発行する

公開候補を`git add`した後は、実際の`.env`値との一致も含めて検査できます。

```powershell
npm.cmd run security:public
```

## License

MIT
