# MCP Context Hub

必要なMCPサーバーを、必要なときだけ使うためのローカルHubです。Node.js 22.12以上で動作します。

Windows・macOS間で、選択したMCP登録とSkillを**共有フォルダー経由で同期**できます。専用サーバーは不要です。ON/OFF・認証・起動パス・安全性設定は端末ごとに管理します。[同期の設定手順](docs/sync.md) / [安全性の9項目のスイッチ](docs/security.md)

エージェントには常に **5個のHubツールだけ** を公開します。サーバーやSkillが増えても、この数は変わりません。サーバー検索 → 必要なSkill → 選択したツール定義 → 実行、という順番で情報を取得します。公式の [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/) を使用しています。

```text
Codex / MCPクライアント
  └─ MCP Context Hub（stdio・固定5ツール）
       ├─ サーバー・ツールに紐づくSkills（選択した本文だけ取得）
       ├─ ローカルMCPプロセス（必要時に起動・未使用時に停止）
       └─ リモートMCPサーバー（Streamable HTTP・必要時に接続）
```

## セットアップ

リポジトリを取得し、そのディレクトリで実行します。

```sh
git clone https://github.com/coco4atJP/mcp-context-hub.git
cd mcp-context-hub
```

```sh
npm ci
npm test
npm pack
npm install --global ./nekon-mcp-context-hub-0.4.0.tgz
mcp-context-hub init
mcp-context-hub install-skill
mcp-context-hub config-path
```

tarballをインストールするため、元のリポジトリを移動しても再利用できます。npmレジストリへの公開は不要です。`init` は空の設定を作り、既存ファイルは上書きしません。

`install-skill` はHubの使い方を案内する [mcp-context-hub Skill](skills/mcp-context-hub/SKILL.md) を `$CODEX_HOME/skills`（未設定なら `~/.codex/skills`）に配置します。既存の `SKILL.md` は上書きしません。別クライアント用には `--skills-dir /absolute/path/to/skills` で配置先を指定できます。クライアントがSkillを再検出した後に利用できます。

設定ファイルの選択順は `--config` → `MCP_HUB_CONFIG` → `$XDG_CONFIG_HOME/mcp-context-hub/config.json` → `~/.config/mcp-context-hub/config.json` です。v0.4から、編集を次のMCP要求で読み直します。変更時は古い接続を閉じ、出力量・focus条件・結果キャッシュをリセットします。ON/OFFは端末の保存値を保持します。

まずオフラインのデモを登録できます。`command` と `args` を実際の絶対パスに置き換えます。Nodeのパスは `command -v node`、インストール先は `npm root -g` で確認できます。

```json
{
  "version": 1,
  "idleTimeoutMs": 300000,
  "timeoutMs": 60000,
  "servers": {
    "demo": {
      "transport": "stdio",
      "description": "動作確認用。メッセージをそのまま返す。",
      "tags": ["echo", "テスト"],
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/NPM_GLOBAL_ROOT/@nekon/mcp-context-hub/examples/demo-server.mjs"]
    }
  }
}
```

```sh
mcp-context-hub check
```

`check` は設定の構造と、登録したSkillの `SKILL.md`・メタデータを検証し、接続先を起動しません。コマンドの存在、認証情報、接続可能性は実際に使う時に検証されます。[設定例](examples/config.json) にはHTTP接続も含めています。

## 小窓で管理する

```sh
mcp-context-hub gui
```

ローカルのブラウザ管理画面を開きます。右上の「小窓で開く」で、幅540pxの小窓として使えます。サーバーのON/OFF・追加・削除・Skill添付、共有フォルダーの接続と版の承認、安全性の9項目を操作できます。CLIと同じ設定ファイルを使い、操作のためにMCPを起動しません。

GUIは `127.0.0.1` だけで待ち受け、起動ごとの認証を必須にします。既定ではバックグラウンドで動き、画面の「終了」または5分間通信がない場合に停止します。`gui --no-open` はブラウザを開かず前景で起動します。[GUIの使い方と動作](docs/gui.md)

## クライアントへの登録

Codexでは、インストール済みコマンドの絶対パスを登録できます。

```sh
codex mcp add context-hub -- "$(command -v mcp-context-hub)" serve
```

一般的なMCPクライアントでは次のstdio設定を利用します。設定ファイルの場所とキー名はクライアントごとに異なります。

```json
{
  "mcpServers": {
    "context-hub": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/NPM_GLOBAL_ROOT/@nekon/mcp-context-hub/dist/cli.js", "serve"]
    }
  }
}
```

GUIアプリではシェルとPATHが異なる場合があるため、Nodeの絶対パスを使う設定が確実です。

既存MCPの設定は、起動コマンド・引数・環境変数をHubの `servers` に転記し、`transport`・説明・タグを追加します。その後クライアント側の直接登録を無効にすると、Hub経由に集約できます。直接登録が残っていると、そのサーバーの定義は引き続きコンテキストへ入る可能性があります。Hubは既存のクライアント設定を自動変更しません。

## エージェントの利用例

| ツール | 用途 | 接続先を起動するか |
|---|---|---|
| `hub_catalog` | サーバー検索。`server` を指定すると紐づくSkillの説明一覧 | しない |
| `hub_skill` | 選択したSkill本文、または参照先のテキストファイルを取得 | しない |
| `hub_tools` | 短い一覧、または指定した1ツールの完全な定義 | 必要時に起動 |
| `hub_call` | 指定ツールの実行、画像などもMCP形式のまま返す | 必要時に起動 |
| `hub_control` | 追加・削除・ON/OFF・同期・安全性の確認・応答量・保管結果の管理 | `start` の場合のみ |

```text
hub_catalog({"query":"テスト"})
hub_tools({"server":"demo"})
hub_tools({"server":"demo","tool":"echo"})
hub_call({"server":"demo","tool":"echo","arguments":{"message":"こんにちは"}})
hub_control({"server":"demo","action":"disable"})
```

サーバーの説明・タグを用途に合わせて書くと、エージェントが自律的に選択しやすくなります。`hub_catalog` の検索には紐づくSkillのID・説明も使います。空白区切りの語を全て含む部分一致検索です。検索結果がなければ語を減らすか、クエリを省略します。`hub_catalog` と `hub_tools` の一覧は既定5件、最大20件で、`nextOffset` を次の `offset` に指定します。一覧の説明は既定160文字に抑えます。スキーマは `tool` で1個ずつ指定して取得します。接続先から返る説明や出力は外部データとして扱います。

## エージェントによる追加・削除とコンテキスト管理

管理操作の引数スキーマは必要時に取得します。常時公開するツールは5個のままです。

```text
hub_control({"action":"help","options":{"action":"add"}})
hub_control({"action":"add","server":"docs","options":{
  "url":"https://your-mcp-service.example/mcp",
  "description":"製品ドキュメント検索"
}})
hub_control({"action":"help","options":{"action":"focus"}})
hub_control({"action":"focus","options":{"servers":["docs"]}})
hub_control({"action":"context","options":{"preset":"compact"}})
hub_control({"action":"remove","server":"docs"})
```

`add` は登録だけを行い、接続・インストール・コマンド実行をしません。ONに登録されたサーバーは、`hub_tools` または `hub_call` を使う時点で起動・接続します。URLのドメイン解決とIP検査も接続時です。

| 操作 | 用途 |
|---|---|
| `help` | 操作一覧。`options.action` 指定でその操作の引数スキーマ |
| `add` | `server` をIDとして、新規URLまたは起動テンプレートを登録 |
| `remove` | Agent追加分は共有登録から削除。所有者の定義はこのセッションからのみ除外 |
| `focus` | `options.servers` にある接続先だけON、残りをOFF。空配列で全てOFF |
| `context` | 応答の文字数・一覧件数・説明の長さを調整。空optionsで現在値とキャッシュ使用量 |
| `result` | 大きな応答を再実行せずに取得。`resultId`、任意で`pointer`・`offset` |
| `forget` | `server` の保管済み結果を削除。省略で全て削除 |
| `sync` | 共有フォルダーの状態確認・受信、許可された公開／共有削除。引数はhelpで取得 |
| `security` | この端末の安全性スイッチを確認。変更は所有者のローカルCLI |

`enable`・`disable`・`start`・`stop`・`status` は従来どおり `server` を指定します。管理操作の `options` はコードで厳密に検証され、未定義の項目は拒否します。

### 起動テンプレートと安全範囲

ローカルMCPや認証情報が必要なMCPは、所有者が `templates` に起動定義を登録します。エージェントはテンプレートIDを指定して、自律的に追加できます。

```json
{
  "version": 1,
  "agent": {
    "allowPublicHttp": true,
    "allowedHttpOrigins": [],
    "maxServers": 30
  },
  "templates": {
    "blender": {
      "transport": "stdio",
      "command": "/your/bin/blender-mcp",
      "description": "許可済みのBlender MCP"
    }
  },
  "servers": {}
}
```

```text
hub_control({"action":"add","server":"blender-task","options":{"template":"blender"}})
```

テンプレートには通常のサーバー設定と同じ `env`・`allowedTools`・`skills`・`toolSkills` 等を指定できます。エージェントが追加時に変更できるのは説明・タグ・初期ON/OFF・Skill ID・ツール許可リストです。初期設定では許可リストをテンプレートより広げる変更を拒否します。コマンド・引数・環境変数・ヘッダー・権限ルールはAgent経由で変更できません。テンプレートの許可リストを省略した場合は、そのMCPの全ツールが利用可能です。

初期設定で自由に追加できるURLは公開HTTPSです。次の制限を設けています。

- ローカルホスト、LAN、クラウドのメタデータアドレス等は拒否します。ホスト名だけでなく、接続時の解決結果も検査し、検査したIPへ直接接続します。
- HTTPリダイレクトを追跡せず、別オリジンへの要求を拒否します。これは所有者のHTTP設定にも適用します。
- URL内のユーザー名・パスワード・クエリ・フラグメント、Agent指定の認証ヘッダーや環境変数継承は受け付けません。認証は所有者のテンプレートで定義します。
- 内部のHTTP MCPが必要な場合、所有者が `agent.allowedHttpOrigins` に正確なオリジン（例：`http://127.0.0.1:8765`）を指定します。そのオリジンではプライベートIPを許可します。テンプレートや `servers` へ直接設定したHTTP先も、所有者が許可した接続先として扱います。
- `agent.allowPublicHttp: false` にすると、URL追加は上記オリジンに限定します。`agent.maxServers: 0` なら追加を禁止します。所有者のサーバーは `allowAgentRemove: false` で除外・削除を禁止できます。

これはHubの権限境界です。MCPプロセス自体をOSサンドボックスへ隔離するものではなく、所有者が許可したローカルMCPはその実行ユーザーの権限で動きます。公開HTTPS先の信頼性や、Agentが送るツール引数の機密性を自動判定する機能もありません。ツールの説明やSkillに書かれた指示で、この権限ルールを変更することはできません。

### 同一端末の登録保存

Agent追加分は、設定ファイル名に `.agents.json` を付けたファイルへ保存します。既定では `~/.config/mcp-context-hub/config.json.agents.json` です。所有者の `config.json` は書き換えません。書き込みロックとファイルの置き換えで並行更新を処理します。POSIXではファイル権限を0600にし、Windowsでは保存先のACLを利用します。

同じ設定を使うHubは、次のツール要求で登録を同期します。追加されたMCPは再起動なしで見つけられます。削除された接続先はその時点で切断します。保存されたAgent登録も、読み込み時に所有者の現在のポリシーで検証します。無効な登録やポリシー違反がある場合は処理を拒否し、所有者による修正を必要とします。

**v0.3から、CLIで起動したHubのON/OFFは `.device.json` に端末別で保存**します。同じ端末・configの別Hubにも次の要求で反映します。`focus` が行ったON/OFFも保存します。新規追加分に対するfocusの選択条件・出力量・結果キャッシュはセッションごとです。別Hubの実行中の要求を即時に取り消す保証はありません。所有者の `servers` をremoveした場合は、そのセッションから除外するだけなので、次のHub起動時や所有者設定の再読み込み時には復元されます。Agent登録用ファイルへ手動編集する際はHubを停止してください。書き込み中の異常終了で `.lock` が残った場合は、書き込みプロセスが残っていないことを確認してから所有者が取り除きます。

### Windows / macOS間の同期

両端末で、同じ内容が見える共有フォルダーを指定します。LAN共有でも、既存のクラウド同期フォルダーでも使えます。

```sh
mcp-context-hub sync connect --folder "/ABSOLUTE/PATH/TO/SHARED_FOLDER"
mcp-context-hub sync publish --server blender
```

受信側では `sync status`・`sync inspect --server blender` で内容を確認し、`sync approve --server blender --revision SHA256` で版を承認します。stdio MCPの実行環境は端末の同名テンプレートへ結び付けます。新規受信は初期OFFです。承認済みの変更はHubを再起動せずに反映します。接続先フォルダーやテンプレートの変更も、次のMCP要求で反映します。

同時編集は競合として検出し、明示的に採用する版を選びます。同期管理のサーバーは `sync remove` で共有削除し、この端末だけ止める場合は `disable` を使います。詳細とWindowsの設定例は [同期の手順](docs/sync.md) を参照してください。

### 安全性のカスタマイズ

```sh
mcp-context-hub security show
mcp-context-hub security set allowAgentPublish on
mcp-context-hub security set requireSyncApproval off
```

共有先へのAgentによる公開と、受信版の承認要求は別々のスイッチです。HTTP／stdio、HTTPS必須、プライベートIP制限、ツール許可リスト、環境変数継承も個別に設定できます。各端末の所有者が設定し、次のMCP要求で反映します。初期値と意味は [安全性設定](docs/security.md) を参照してください。

### 長い結果を必要な部分だけ読む

通常の応答上限はJSON表現で6,000文字です。上限を超える実行結果・Skill・スキーマ・カタログはメモリに保持し、短いプレビューと `resultId` を返します。要約を生成して情報を捨てる方式ではありません。

```text
hub_control({"action":"result","options":{"resultId":"返されたUUID","pointer":"/content/0/text"}})
hub_control({"action":"result","options":{"resultId":"同じUUID","pointer":"/content/0/text","offset":1234}})
```

`offset` には前の応答の `nextOffset` を使います。`pointer` は元のMCP応答を対象としたJSON Pointerで、省略時は応答全体のJSONを分割します。元の結果がSkillやスキーマを包むJSONテキストの場合は、そのテキストを完全に読み取ってから解釈します。画像・音声や元の完全なMCP応答が必要な場合だけ `native: true` を指定できます。この明示指定は文字数上限を解除して元の形式で返します。

保管はセッション内のみで、最大32件・シリアライズされたデータの合計16 MiB・10分間です。上限に達すると古い結果から削除します。OFF・remove・forget・Hub終了でも削除します。期限切れの結果を得るために書き込みツールを自動再実行しないでください。

| preset | 応答上限 | 一覧件数 | 説明の長さ |
|---|---:|---:|---:|
| `compact` | 2,400文字 | 3件 | 100文字 |
| `balanced`（既定） | 6,000文字 | 5件 | 160文字 |
| `full` | 12,000文字 | 10件 | 240文字 |

`context` では `maxChars`（1,024〜20,000）、`listLimit`（1〜20）、`summaryChars`（40〜300）を個別指定することもできます。所有者の設定で同名の `context` オブジェクトを定義すると、セッションの初期値になります。文字数は計測しやすい上限で、モデルごとのトークン数や会話履歴の総量を測定・制御するものではありません。

## MCPにSkillsを付ける

共通の `skills` に **Skillディレクトリの絶対パスを一度だけ登録**し、各サーバーの `skills` でIDを参照します。既存の `SKILL.md` をそのまま利用でき、内容のコピーは不要です。

```json
{
  "version": 1,
  "skills": {
    "blender-workflow": "/your/skill-library/blender-mcp-workflow",
    "design": "/your/skill-library/scene-design",
    "render-guide": "/your/skill-library/render-guide"
  },
  "servers": {
    "blender": {
      "transport": "stdio",
      "command": "/your/bin/blender-mcp",
      "description": "Blenderのシーン編集とレンダリング",
      "skills": ["blender-workflow", "design"],
      "toolSkills": {
        "your_render_tool_name": ["render-guide"]
      }
    }
  }
}
```

`command`・パス・ツール名は利用するサーバーの実際の値に置き換えます。`skills` はサーバー全体、`toolSkills` は特定ツール向けの追加手順です。同じIDを複数サーバーから参照でき、重複するIDはまとめられます。IDは設定内の別名なので、Skillディレクトリ名と異なっていても構いません。

動作は次のようになります。

```text
hub_catalog({"query":"blender"})
  → サーバー概要とskillCountのみ。全Skillの説明は返さない

hub_catalog({"server":"blender"})
  → 紐づくSkillのID・説明。本文は返さない

hub_skill({"server":"blender","skill":"design"})
  → 選択したSKILL.mdの本文。MCPはまだ起動しない

hub_tools({"server":"blender","tool":"実際のツール名"})
  → 入力スキーマと、そのツールに適用されるSkillのID

hub_call({"server":"blender","tool":"実際のツール名","arguments":{}})
  → 実行。argumentsは取得したスキーマに合わせる
```

特定ツールに絞って手順を探す場合は `hub_catalog({"server":"blender","tool":"実際のツール名"})` を使います。サーバー共通のSkillと、そのツールに付けたSkillが候補になります。紐づけは関連する手順への案内で、全Skillの強制読み込みや、自動実行を意味しません。

[Blender用の設定例](examples/blender.config.json) と、[MCP操作のSkill](examples/skills/blender-mcp-workflow/SKILL.md)・[デザインSkill](examples/skills/scene-design/SKILL.md) を同梱しています。これらは接続先の実際のツールを検索する方式です。Blender本体やMCP実装のインストールは含みません。

### コンテキストを小さく保つ仕組み

- 常時公開するのは固定5ツール。接続時の説明にもSkill一覧を埋め込みません。
- 最初のサーバー検索はSkill件数だけ返し、説明は選んだサーバーについて取得します。
- Skillの説明は `SKILL.md` のYAML frontmatterから読みます。設定に説明を二重管理しません。
- 本文取得時はfrontmatterを除きます。参照ファイルは `hub_skill` の `file` に相対パスを指定して個別に読みます。1応答は最大12,000文字で、長い場合は `nextOffset` を次の `offset` に渡します。
- 本文の `revision` を保存し、完全な内容がまだコンテキストにある場合は `ifRevision` に渡して更新確認できます。同じ内容なら `unchanged: true` だけ返します。コンテキスト圧縮後など、本文が必要な場合は `ifRevision` を省略すれば再取得できます。

Hubが管理するSkillをクライアントの自動検出対象外のディレクトリに置き、クライアントには案内Skillだけを登録すると、各Skillの説明一覧も常時コンテキストへ入りません。既にクライアントへ直接登録しているSkillの配置や設定は自動変更しません。

### ファイルと権限

サーバーがOFFならSkill本文の取得も拒否します。紐づけていないSkillや、`allowedTools` で許可されていないツール専用のSkillは取得できません。Skillからの相対参照は登録ディレクトリ内のUTF-8テキストのみ読み取れます。外部へ向くシンボリックリンク・バイナリ・256 KiBを超えるファイルは拒否します。

`scripts/` 内のスクリプトもテキストとして返すだけで、Hubでは実行しません。実行が必要な場合は、エージェントが返された `basePath` とクライアント側の実行手段を使います。Skillの `allowed-tools` などをクライアントの権限設定へ自動反映しません。

Skill本文の編集は次回の読み取りに反映されます。登録パスや紐づけの変更も、次のMCP要求で反映します。壊れたSkillは一覧で `available: false` と表示し、ほかのMCPの利用を妨げません。詳細は `mcp-context-hub check` で確認できます。

## ON/OFFとプロセスの扱い

| 操作・設定 | 意味 |
|---|---|
| `enable` | この端末で利用可能にし、ONを保存する。まだ起動しない |
| `disable` | 後続の定義・Skill本文の取得と実行を拒否し、接続を閉じる |
| `start` | ONのサーバーをすぐ起動・接続する |
| `stop` | 接続を閉じる。ONのままなので次の利用時に再起動する |
| `status` | 状態を確認する。アイドルタイマーは延長しない |
| `enabled: false` | 保存された端末状態がない場合の初期状態をOFFにする |
| `allowAgentEnable: false` | OFFになったサーバーをエージェントがONへ戻すことを禁止する |
| `idleTimeoutMs` | 未使用時の停止までの時間。既定5分。`0` なら自動停止なし |
| `timeoutMs` | 起動と各操作の制限時間。既定60秒。最大10分 |
| `allowedTools` | 利用できるツール名の許可リスト。省略は全て、空配列は全て拒否 |

CLIのON/OFFは**端末とconfig単位**です。複数クライアントが接続した場合、それぞれ独立したHubと子プロセスが動きます。状態は次の要求で確認します。全クライアントで単一の子プロセスを共有する常駐デーモンではありません。ライブラリとして `new Hub(config)` を直接使う場合は従来どおりメモリ内で、`DeviceState` を渡すと永続化できます。

同一サーバーへの実行要求は順番に処理します。OFFやremoveは実行中の要求へキャンセルを送り、接続を閉じます。別サーバーは並行利用できます。アイドル停止は実行完了から計測します。Hub終了時も実行中の要求をキャンセルし、SDKのstdio終了処理で管理下の子プロセスを停止します。HTTPではセッション終了を試みて接続を閉じますが、リモートのサーバープロセス自体は停止しません。

タイムアウトやキャンセルは外部処理の取り消しを保証しません。Hubはツール実行を自動再試行しません。書き込みを再試行する前に結果を確認してください。

## 認証と起動設定

stdioの `command` は実行ファイル名または絶対パス、`args` は引数配列です。Hubでシェル式を評価せず、SDKへコマンドと引数を分けて渡します。相対ファイルを扱う接続先には絶対パスの `cwd` を指定してください。

```json
{
  "transport": "stdio",
  "command": "/ABSOLUTE/PATH/TO/node",
  "args": ["/ABSOLUTE/PATH/TO/server.js"],
  "cwd": "/ABSOLUTE/PATH/TO/workspace",
  "env": { "API_TOKEN": "${MY_API_TOKEN}" },
  "inheritEnv": ["CUSTOM_SERVICE_SETTING"]
}
```

初期設定ではSDK既定のHOME・PATHなどの基本環境に加え、明示した `env` と `inheritEnv` だけを子プロセスへ渡します。`security.inheritProcessEnv: true` は環境全体の継承を有効にします。`env`・`args`・HTTPの `headers` で `${ENV_NAME}` を展開できます。値はHubプロセスの環境から読みます。未定義なら接続時に失敗します。`.env` の自動読み込みやOAuthログイン画面の起動は行いません。

```json
{
  "transport": "http",
  "url": "https://your-service.example/mcp",
  "headers": { "Authorization": "Bearer ${MY_MCP_TOKEN}" }
}
```

Hubのカタログにコマンド・環境変数・ヘッダーは出しません。通信例外は一般化したエラーに変換し、子プロセスのstderrは破棄します。接続できない場合は、ローカル端末で接続先単体のコマンド・環境・認証を確認してください。**ツールの応答に含まれる機密情報を自動で伏せる機能はありません**。小さな応答はそのまま、大きな応答はプレビューと取得用IDで返します。

登録済みサーバーのみ起動できます。エージェントは上記ポリシーの範囲内で登録を追加できます。`hub_call` は書き込みも含むため、Hub側のツール注釈は保守的に設定しています。クライアント側でHubへの実行許可が必要な場合があります。

## 対応範囲

- 接続元：stdio MCPクライアント。接続先：stdio / Streamable HTTP。
- 中継対象：ツール一覧・ツール実行。Resources、Prompts、Roots、Sampling、Elicitation、OAuth対話フロー、旧SSE接続は未対応です。それらを必須とする接続先は利用できない場合があります。
- 既に会話履歴へ入った定義や結果は削除できません。OFFは以降のアクセスを止め、保管結果を削除します。必要な定義だけを取得し、大きな応答を分割することで、追加されるコンテキストを抑えます。
- クライアント内蔵のツール、スキル、プラグイン由来の常時注入はHubの管理対象外です。
- 動的に下流ツールを公開するモードはありません。クライアントの `tools/list_changed` 対応に依存せず、固定5ツールで利用します。

## 開発・検証

```sh
npm run check
npm test
```

外部サービスや認証情報を使わず、実際のstdio子プロセス・ローカルHTTPサーバー・MCPクライアントを用いて検証します。遅延起動、定義の選択取得、固定5ツール、ON/OFF、許可リスト、ページング、同時要求、アイドル停止、異常終了、キャンセル、タイムアウト、終了時の子プロセス回収に加え、Skillの紐づけ・参照ファイル・更新検出・本文の遅延取得を含みます。

GUIテストはループバック認証・Host/Origin検証・設定の競合検知・Skill添付・同期承認・稼働中MCPへの設定反映・終了を検証します。画面は実データをAPIから読み込むReact UIで、ビルド済みファイルを配布します。

同期テストは独立した2端末分の状態と共有フォルダーを作り、受信承認・端末別の起動設定／ON/OFF・Skill転送・同時編集・配信順序の逆転・オフライン・改ざん・CLI・実際のMCP経由での再起動不要の取り込みを検証します。GitHub ActionsではWindows・macOS・Linux、Node.js 22／24で同じテストを実行します。実際のLANやクラウドの転送機構はテスト環境に含みません。
