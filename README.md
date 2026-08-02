# Discord Schedule Manager

Discordだけで会議の登録、参加者へのDM、出欠集計、個人別リマインド、開始時の参加者メンションを管理する公開テンプレートです。

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
- 30分前などのチャンネル通知と、指定時刻の「参加」回答者だけへの自動メンション
- SQLiteによる再起動復旧、配信claim、重複送信防止
- Google Sheetsへの任意ミラー同期。URL同期は既定で無効
- 会議・URL・Discord ID・メンバー対応表を分離するプライバシー設計

## すぐに試す

必要なものはNode.js 24以上と、新規Discord Application / Botです。自然言語で会議を作成・更新する場合は、OpenAI API（既定）または実験的なCodex App Serverを選びます。

```powershell
git clone https://github.com/OWNER/Discord-Schedule-Manager.git
Set-Location -LiteralPath "Discord-Schedule-Manager"
npm.cmd install
Copy-Item -LiteralPath ".env.example" -Destination ".env"
```

OpenAI APIを使う場合、`.env`へ次を設定します。値をREADME、Issue、コミットへ貼らないでください。

```env
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
MEETING_AI_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MEETING_MODEL=gpt-5.6-terra
OPENAI_REASONING_EFFORT=medium
```

ChatGPT ProのCodex SparkをこのPCだけで試す場合は、Codex CLIへChatGPTログインしたうえで次へ切り替えられます。App Serverは外部ポートを開かずstdioだけを使い、要求を直列化し、一時thread・read-only・承認なしで動かします。Bot専用の一時`CODEX_HOME`と、所有マーカー以外は空の作業フォルダーを作り、ChatGPT認証と対象モデル1件の検査済みカタログ情報だけを移します。普段のCodex設定・MCP・plugins・skills・memoriesは引き継がず、shell・web検索・アプリ・フック・サブエージェントも無効化します。子プロセスへDiscord、Sheets、OpenAI APIの秘密環境変数は継承しません。一時領域にはBot所有マーカー、PID、プロセス開始時刻を記録します。正常終了では`auth.json`を最初に削除して一時領域の削除完了を待ちます。異常終了後の次回起動ではPIDと開始時刻の両方を照合し、PIDが別プロセスへ再利用されていても古いBot所有領域を回収します。マーカーのない領域や、同じプロセス実体が稼働中の領域は削除しません。開始時刻を安全に確認できない環境では稼働中PIDを削除しない側へ倒します。

```env
MEETING_AI_PROVIDER=codex_app_server
CODEX_MEETING_MODEL=gpt-5.3-codex-spark
CODEX_REASONING_EFFORT=medium
```

SparkはChatGPT Pro限定のCoding向けresearch previewで、利用上限があります。常駐BOTでの可用性が保証されたAPIではないため、安定運用では`openai`を推奨します。またApp Serverはローカル窓口ですが推論文はOpenAIへ送信されます。このBotはどちらを選んでもURL・実名対応・Discord ID・会議IDを送信前に除去します。

起動します。

```powershell
npm.cmd start
```

起動時に対象サーバーへ`/meeting`を登録し、`data/meetings.sqlite3`を自動作成します。

## Windowsログオン後に自動復旧する

タスクスケジューラ用スクリプトは、実行しただけでは登録内容を変更しません。既定動作は確認です。`.env`の値やトークンをタスク引数へ保存せず、現在のWindowsユーザー権限で`start.ps1`を起動します。`SYSTEM`では動かさないため、CodexのChatGPT認証を別アカウントへコピーしません。

登録（推奨・現在のWindowsユーザーがログオンしたとき）:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ".\scripts\manage-autostart.ps1" -Action Register
```

Bot本体が終了した場合は、5秒から最大5分まで待ち時間を伸ばしながら`start.ps1`が再起動します。10分以上安定稼働した後は待ち時間を5秒へ戻します。起動ラッパー自体が異常終了した場合も、タスクスケジューラが1分間隔で最大999回再試行します。多重起動は`IgnoreNew`で防止し、バッテリー動作へ切り替わっても停止しません。

`-TriggerMode Both`を明示するとPC起動時トリガーも追加できますが、Windowsの仕様上、登録には管理者権限が必要です。また、このBotは現在のWindowsユーザーのCodex/ChatGPT認証を使うため、サインイン前の実行はできません。通常は既定の`Logon`を使ってください。`SYSTEM`や別サービスアカウントへ認証情報をコピーしないでください。

メンテナンスで止めるときは、Botの子プロセスだけでなくタスクスケジューラ上の`DiscordMeetingManagerBot`タスクを停止してください。タスクを実行すれば同じWindowsセッション内で再開でき、次回ログオン時にも自動起動します。

登録内容と直近結果の確認:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ".\scripts\manage-autostart.ps1" -Action Verify
```

同名タスクがある場合、登録コマンドは勝手に上書きしません。内容を確認したうえで置換するときだけ`-Replace`を付けます。解除も確認フラグが必要です。

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File ".\scripts\manage-autostart.ps1" -Action Unregister -ConfirmRemoval
```

このリポジトリのスクリプトを移動した場合は、`-Replace`付きで再登録してから`-Action Verify`を実行してください。

## Discord側の準備

Discord Developer Portalで専用Applicationを作成し、Botを追加します。既存Botのトークンを流用しないことを推奨します。

このBotは`GUILDS`、`GUILD_MESSAGES`、`DIRECT_MESSAGES`だけを要求し、特権的な`MESSAGE CONTENT INTENT`を要求しません。サーバー内ではBot自身が直接メンションされたメッセージだけを自然言語操作の対象にします。

招待URLには`bot`と`applications.commands`スコープを付け、次の権限を許可します。

- チャンネルを見る
- メッセージを送信
- 埋め込みリンク
- メッセージ履歴を読む
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

会議名・日時・固定メンバー・URLは、順番をそろえたり定型文にしたりする必要はありません。URLは未定のままでも登録できます。登録済みの呼び名やDiscordメンションはローカルで参加者へ変換し、残りの文章からAIが会議名と日時を整理します。

```text
@予定管理 メンバーAとメンバーB 30分前 全体定例
https://calendar.app.google/招待用トークン 来週月曜20時30分 1時間
```

Googleカレンダーの招待URLを送った場合は、Botが動くPCからGoogleへ直接アクセスし、ページ内のGoogle Meet URLをbest-effortで自動取得します。このページ内容やURLをOpenAIへは送りません。Google側の表示形式やログイン状態によって取得できない場合は、直接のMeet URLを貼ってください。直接のMeet・Zoom・Teams・Whereby・Jitsiなど、HTTPSの会議URLも使えます。直接URLはBotからアクセスせず、そのまま保存します。

足りない必須項目があれば「開始日時が足りません」のように項目名を返します。会議名だけ無い場合は`会議 7/21 19:00`のような仮名を付け、黄色い確認画面で自動設定と明示します。URL未定の確認画面では「Discord VCを選ぶ」「Google Meet / 外部URL」「未定で登録」をボタンで選びます。Discord VCは一覧から指定でき、自分が先に入室する必要はありません。「自動議事録 ON/OFF」も同じ確認画面で切り替えられます。`/meeting create`では`voice_channel`と`auto_transcribe`を指定でき、`url`と`voice_channel`の両方を省略すれば未定で作成できます。

作成後にURLだけ直す場合、チャンネル内の開催予定が1件だけなら、`@予定管理`の後へURLだけ貼っても認識します。通常チャンネルでは誤作動を避けるため、会議カードへの返信でもBotの直接メンションが必要です。

```text
@予定管理 全体定例のリンクはこれ https://meet.google.com/会議コード
```

```text
@予定管理 https://calendar.app.google/招待用トークン
```

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
| `create` | `来週月曜20:30から定例、URL未定` | 管理者 |
| `url` | `@予定管理 URL`、複数候補なら会議カードへBotをメンションして返信 | 管理者 |
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

会議が複数ある場合は`MEET0001 参加`のようにDMへ表示された会議IDを付けます。新しいIDは8文字で、修正前に作成された7文字IDもそのまま使えます。DMだけでなく、通常チャンネルで`@予定管理 MEET0001の会議に参加します`と回答することもできます。公開チャンネルの確認返信には会議URLを再掲しません。

## Discord VCの文字起こし・議事録

会議の開催場所にDiscord VCを選び、自動議事録をONにすると、開始15分前から終了予定までの間に人が指定VCへ入った時点で同意確認を自動表示します。すでに入室している場合やBotを再起動した場合も定期確認で拾います。入室しただけでは録音せず、VC内の全員が同意してからBotが接続して録音を始めます。同じVCで複数の会議時間が重なっている場合は、誤った会議を選ばず自動開始を見送ります。自動議事録をOFFにして手動で開始することもできます。途中から人が入った場合は全員分の収録を一時停止し、その人の同意後に再開します。現在の参加者なら誰でも停止できます。

音声認識は`faster-whisper`を使ってBotのPC内だけで行います。音声をOpenAIや外部STT APIへ送りません。暗号化した音声・文字起こし・要約のローカルバックアップは、再処理や人間確認のため開始から固定24時間だけ保持し、再処理しても期限を延ばしません。期限後は自動削除され、管理者はそれより前に削除できます。専用チャンネルへ投稿した匿名化済み文字起こし・議事録はDiscord側のデータなので、ローカルの24時間削除には含まれません。

準備は一度だけです。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-local-voice.ps1 -PythonPath "Pythonの実行ファイル"
```

`.env`へ`.env.example`の`MEETING_VOICE_*`を設定します。`MEETING_VOICE_OUTPUT_CHANNEL_ID`には議事録専用の非公開テキストチャンネルを指定し、そのチャンネルでは`@everyone`の「チャンネルを見る」を明示的に拒否してください。暗号鍵は32バイトのランダム値をBase64化したものを使い、GitやDiscordへ貼らないでください。

```text
@予定管理 VCの文字起こしを開始して
@予定管理 VC文字起こしの状態を見せて
@予定管理 VCの録音を止めて
@予定管理 VC録音のプライバシーを教えて
```

同じ操作は`/meeting voice-start`、`voice-stop`、`voice-status`、`voice-privacy`でもできます。24時間以内の失敗データは`voice-reprocess`、即時削除は`voice-delete`です。AI要約を有効にした場合も、実名・Discord ID・URL・メール・電話番号・会議IDをローカルで除去した文字起こしだけをCodexへ送ります。裏取りを有効にした場合は、個人情報を含まない公開事実の短い主張だけがWeb検索対象です。

## プライバシー設計

自然言語の便利さを残しながら、識別情報とURLをAI入力から分離します。

1. Discordメッセージをローカルで受信
2. URL、Discordメンション、Discord ID、会議ID、メールアドレス、登録済み呼び名、テンプレート名を抽出または伏せ字化
3. Googleカレンダーの招待URLなら、許可したGoogleの2ホストだけをローカル取得して直接会議URLを抽出
4. URLや識別子が残っていないことを再検査
5. 伏せ字本文と「URLがあるか」の真偽値だけを、選択したAIプロバイダーからOpenAIへ送信
6. OpenAI API経路は`store: false`を明示。Codex App Server経路は一時threadを使い、処理後に削除
7. 会議名・日時・通知時刻だけをJSON Schemaで受け取る
8. AI出力にURLが含まれた場合は結果全体を破棄
9. ローカルに退避したURLと結果を、管理者の確認後にSQLiteで結合

| 情報 | OpenAIへ送信 | 保存先 |
|---|---:|---|
| 会議URL | しない | SQLite、Discord |
| Discord ID・メンション | しない | SQLite、Discord処理 |
| 呼び名と本人の対応 | しない | SQLiteのみ |
| 参加者テンプレート名・構成 | しない | SQLiteのみ |
| DM本文 | しない・本文保存もしない | ルール判定後に破棄 |
| 出欠結果 | しない | SQLite、Discord、任意でSheets |
| 伏せ字化後の会議名・日時・通知表現 | 自然言語作成・更新時のみ | API処理対象 |

招待URLの自動取得はOpenAI APIではなく、BotのPCからGoogleカレンダーへの通常のHTTPS通信です。取得先は`calendar.app.google`と`calendar.google.com`に限定し、転送回数・応答サイズ・待ち時間を制限します。招待ページ本文は保存せず、抽出した直接会議URLだけをSQLiteへ保存します。これは非公開ページのHTMLを安全側に解析するbest-effort機能であり、Google Calendar APIの認証済み`hangoutLink`取得を保証するものではありません。

OpenAI APIの入出力は、組織またはプロジェクトがデータ共有へ明示的にオプトインしない限り、既定ではモデル学習に使われません。ただし、共有トラフィックや無料トークン特典を有効にしたAPIプロジェクトでは、共有した入出力が評価・学習に利用される場合があります。`store:false`を指定しても、このデータ共有設定をOFFにはできません。

`store:false`はOpenAI API経路でResponses APIのResponseオブジェクト保存を無効にしますが、不正利用監視ログまで無効にするものではなく、Zero Data Retentionの保証でもありません。Codex App Server経路にはこのAPIフィールドはなく、一時threadの削除とChatGPT側のデータコントロールを使います。通常のAPI不正利用監視ログにはプロンプトや応答が含まれる場合があり、既定では最大30日保持されます。ZDR / Modified Abuse Monitoringは対象顧客がOpenAIの承認を受ける別制度です。

`gpt-5.6-terra`は通常はAPI従量課金です。OpenAIの共有トラフィック特典へ登録済みの対象組織では無料トークン対象ですが、対象プロジェクトでの共有有効化、正のAPI残高、日次上限内であることが必要です。上限超過分は通常料金になります。最新条件はOpenAI公式の[データ共有特典](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)と[API料金表](https://developers.openai.com/api/docs/pricing)を確認してください。

ChatGPTサブスクリプション認証を使うCodex App Server側は、APIプロジェクトの共有設定とは別にChatGPTのデータコントロールが適用されます。「すべての人のためにモデルを改善する」をOFFにしている場合でも推論文はOpenAIへ送られるため、Bot側の伏せ字化は同じように行います。

そのため、このBotはデータ共有設定に頼らず、URLやDiscord識別子をAIへ送らない構成にしています。会議名そのものもOpenAIへ出せない場合は、AIを使わない`/meeting create`と`/meeting url`を使ってください。詳細はOpenAI公式の[データ管理ガイド](https://developers.openai.com/api/docs/guides/your-data)、[Responses APIの保存説明](https://developers.openai.com/api/docs/guides/conversation-state)、[APIデータ利用方針](https://help.openai.com/en/articles/5722486-api-data-usage-policies)を確認してください。

## Google Sheets連携

SQLiteを正本、Sheetsを閲覧用ミラーとして扱います。Sheetsが停止してもDiscord通知と回答は継続します。

```env
GOOGLE_SHEETS_SPREADSHEET_ID=
GOOGLE_SERVICE_ACCOUNT_FILE=
GOOGLE_SHEETS_SYNC_URLS=false
```

サービスアカウントでSheets APIを有効化し、対象スプレッドシートをその`client_email`へ共有します。起動後に`会議一覧`、`出欠`、`通知ログ`を不足分だけ作成します。認証ファイル、権限、初回同期のいずれかに失敗した場合は、秘密を含まないエラーコードを警告してSheetsだけを無効化し、Discord BOTと通知処理は継続します。設定を直した後はBOTを再起動してください。

`GOOGLE_SHEETS_SYNC_URLS=false`ではURL本体を同期しません。値は`RAW`で書き込み、数式注入を防止します。

## SQLiteのオンラインバックアップ

BOTを止めずに、WALにある確定済みデータを含む整合したSQLiteバックアップを作成できます。単純なファイルコピーではなくNode.jsのSQLite backup APIを使い、`PRAGMA quick_check`が`ok`になったファイルだけを完成扱いにします。

```powershell
npm.cmd run backup
```

既定の出力先はGit対象外の`data/backups/`です。元DBと出力先を明示する場合:

```powershell
node .\scripts\backup-database.mjs --source .\data\meetings.sqlite3 --output-dir D:\MeetingBotBackups
```

バックアップには会議URL、氏名、Discord IDなどSQLite内の非公開情報が含まれます。公開リポジトリ、共有ドライブ、無暗号の外部媒体へ置かないでください。復元するときはBOTを停止し、現在のDBを別名で保全してから、選んだバックアップを`data/meetings.sqlite3`へコピーします。

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
- 参加者メンションの既定は開始時だけ。その時点で「参加」の人だけを対象にし、未定・欠席・未回答はメンションしない
- 「参加」が0人の場合も開始通知は送るが、誰もメンションしない
- 時刻は`MEETING_ATTENDEE_MENTION_OFFSETS_MINUTES=0`で変更できる。旧`MEETING_EVERYONE_OFFSETS_MINUTES`も移行用に読み取るが、`@everyone`は送らない
- 個人DM通知の初期値は1時間前と10分前
- 各人は今後の既定値、または特定会議だけの値を変更可能
- 欠席中の個人通知は送信せず、参加・未定へ戻すと未送信分を再生成
- 再起動後はSQLiteから未送信通知を復元
- 初回招待DMの予約は招待者登録と同じSQLite transactionで確定し、一時障害は自動再試行
- 招待DMの作成・更新jobは会議参照、宛先のローカルDiscord user ID、世代・lease・再試行状態だけを保持し、URL・会議名・本文・message/channel IDは複製しない。完了・恒久失敗したjobは削除
- 送信直後に停止した場合は、自Botが送った直近50件のDMから同じ会議ボタンを探して再利用し、重複送信を抑止
- 遅れすぎた通知は、復旧直後の突然の大量送信を避けるためスキップ

## モジュール構成

- `src/index.mjs`: Discordイベントと各モジュールの配線
- `src/coordinator.mjs`: 権限と操作のオーケストレーション
- `src/attendance-templates.mjs`: テンプレート自然言語解析
- `src/participant-resolution.mjs`: 明示・名前付き・既定テンプレートの優先順位
- `src/personal-reminders.mjs`: 個人通知の自然言語解析
- `src/self-service-controller.mjs`: DM/サーバー共通の本人操作
- `src/discord-direct-messenger.mjs`: 在籍確認付きDM送信
- `src/direct-invite-update-scheduler.mjs`: 初回招待DMと既存招待DM更新の永続送信・再試行・再起動復旧
- `src/meeting-card-update-scheduler.mjs`: 会議カードの永続更新・再試行
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
- `scripts/runtime-support.mjs`: 任意連携の起動分離と安全な終了待ち
- `scripts/manage-autostart.ps1`: Windowsタスクの登録・確認・解除
- `scripts/backup-database.mjs`: WAL対応SQLiteオンラインバックアップ

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
