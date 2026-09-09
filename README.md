# MCP Context Hub

必要なMCPサーバーを、必要なときだけ使うためのローカルHubです。Node.js 22.12以上で動作します。

WindowsとmacOSの間で、**URLやQRコードによるペアリングにより、同一LAN内で自動同期**が可能です。外部サーバーはもちろん、共有フォルダーの事前準備も不要です（従来の共有フォルダーによる同期にも対応しています）。各サーバーのON/OFF、認証情報、実行パス、安全性設定は端末ごとに独立して管理されます。[LANペアリング](docs/lan.md) / [共有フォルダー](docs/sync.md) / [安全性設定](docs/security.md)

AIエージェントに対しては、常に **固定の5つのHubツールのみ** を公開します。登録するサーバーやSkillがどれだけ増えてもツール数は変わりません。「サーバー検索 → 必要なSkillの参照 → 選択したツール定義の取得 → ツール実行」という段階的なステップで情報を取得するため、コンテキストウィンドウの消費を最小限に抑えられます。公式の [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/) に準拠しています。

```text
Codex / MCPクライアント
  └─ MCP Context Hub（stdio・固定5ツール）
       ├─ サーバー・ツールに紐づくSkills（選択した本文だけ取得）
       ├─ ローカルMCPプロセス（必要時に起動・未使用時に停止）
       └─ リモートMCPサーバー（Streamable HTTP・必要時に接続）
```

## LANでつなぐ

両方の端末にHubをインストールし、`mcp-context-hub lan install` を1回実行して自動起動とURIスキームを登録します。その後、`mcp-context-hub gui` の「同期 → 端末を追加」から招待URL／QRコードを発行し、もう一方の端末で開いて両画面の6桁の番号を確認するだけで、自動同期が開始されます。起動パスや認証情報は端末ローカルに保持され、受信した設定は安全のため既定で承認待ちとなります。[手順とCLIの詳細](docs/lan.md)

## セットアップ

リポジトリをクローンし、ディレクトリに移動してビルド・インストールを行います。

```sh
git clone https://github.com/coco4atJP/mcp-context-hub.git
cd mcp-context-hub
```

```sh
npm ci
npm test
npm pack
npm install --global ./nekon-mcp-context-hub-0.5.0.tgz
mcp-context-hub init
mcp-context-hub install-skill
mcp-context-hub config-path
```

作成されたtarballからグローバルインストールするため、元のリポジトリディレクトリを移動・削除しても問題なく利用できます（npmレジストリへの公開は不要です）。`init` コマンドは初期設定ファイルを生成します（既存のファイルは上書きされません）。

`install-skill` は、エージェント向けにHubの使い方を案内する [mcp-context-hub Skill](skills/mcp-context-hub/SKILL.md) を `$CODEX_HOME/skills`（未設定時は `~/.codex/skills`）に配置します（既存の `SKILL.md` は上書きされません）。他のクライアント向けには `--skills-dir /absolute/path/to/skills` で出力先を指定可能です。クライアントがSkillを再検出した後に利用可能になります。

設定ファイルの優先順位は、`--config` → 環境変数 `MCP_HUB_CONFIG` → `$XDG_CONFIG_HOME/mcp-context-hub/config.json` → `~/.config/mcp-context-hub/config.json` の順です。v0.4以降、設定ファイルの変更内容は次回のMCPリクエスト時に自動で再読み込みされます。再読み込み時は古い接続を閉じ、出力量・focus条件・結果キャッシュをリセットします。なお、サーバーのON/OFF状態は端末に保存された値が維持されます。

まずは動作確認として、オフラインで動くデモサーバーを登録できます。`command` と `args` は環境に合わせた絶対パスに置き換えてください。Nodeのパスは `command -v node`、グローバルパッケージのインストール先は `npm root -g` で確認できます。

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

`check` コマンドは設定の構文や構造、登録されたSkillの `SKILL.md`・メタデータを検証します（この時点で接続先サーバーは起動しません）。コマンドの存在、認証情報、ネットワーク接続性は、実際にエージェントから呼び出された際に検証されます。より実践的な構成は [設定例](examples/config.json)（HTTP接続を含む）を参照してください。

## 小窓で管理する

```sh
mcp-context-hub gui
```

ブラウザでローカル管理画面を開きます。画面右上の「小窓で開く」をクリックすると、幅540pxのコンパクトな独立ウィンドウとして操作できます。サーバーのON/OFF切り替え、追加・削除、Skill添付、共有フォルダーの接続や版の承認、9項目の安全性スイッチなどをGUIから設定可能です。CLIと同一の設定ファイルを参照し、GUI操作の段階でMCPサーバーが起動することはありません。

GUIサーバーは `127.0.0.1`（ループバックアドレス）のみでリッスンし、起動ごとにランダムな認証トークンを要求します。既定ではバックグラウンドで動作し、画面上の「終了」ボタンを押すか、5分間アクセスがない場合に自動停止します。`gui --no-open` を指定すると、ブラウザを開かずにフォアグラウンドで待機します。詳細は [GUIの使い方と動作](docs/gui.md) を参照してください。

## クライアントへの登録

Codexでは、インストールされたコマンドの実行パスをそのまま登録できます。

```sh
codex mcp add context-hub -- "$(command -v mcp-context-hub)" serve
```

一般的なMCPクライアントでは、以下のようなstdio設定を記述します（設定ファイルの配置場所やキー名はクライアントごとに異なります）。

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

デスクトップアプリ形式のクライアントではシェルとPATH環境変数が異なる場合があるため、`node` の絶対パスを指定する設定が確実です。

既存のMCP設定をHubへ移行する場合は、起動コマンド・引数・環境変数をHubの `servers` 設定に転記し、`transport`・説明・タグを追加します。その後、クライアント側で既存サーバーの直接登録を無効化することで、Hub経由に一本化できます（直接登録が残っていると、そのツールの定義が常時コンテキストへ展開され続けます）。なお、Hubがクライアント側の設定ファイルを自動で書き換えることはありません。

## エージェントの利用例

| ツール | 用途 | 接続先を起動するか |
|---|---|---|
| `hub_catalog` | サーバーの検索。`server` を指定すると紐づくSkillの説明一覧を取得 | 起動しない |
| `hub_skill` | 選択したSkillの本文、または参照先テキストファイルを取得 | 起動しない |
| `hub_tools` | ツールの簡易一覧、または指定した1ツールの完全な定義スキーマを取得 | 必要時に起動 |
| `hub_call` | 指定ツールの実行（画像などのバイナリもMCP標準形式で返却） | 必要時に起動 |
| `hub_control` | 追加・削除・ON/OFF・同期・安全性確認・応答量調整・結果キャッシュの管理 | `start` 指定時のみ |

```text
hub_catalog({"query":"テスト"})
hub_tools({"server":"demo"})
hub_tools({"server":"demo","tool":"echo"})
hub_call({"server":"demo","tool":"echo","arguments":{"message":"こんにちは"}})
hub_control({"server":"demo","action":"disable"})
```

サーバーの説明やタグを用途に合わせて分かりやすく記述しておくと、エージェントが自律的に適切なツールを選択しやすくなります。`hub_catalog` の検索対象には、紐づくSkillのIDや説明も含まれます。スペース区切りの単語をすべて含むAND検索（部分一致）です。意図した結果が得られない場合は単語数を減らすか、クエリを省略して一覧を取得してください。`hub_catalog` と `hub_tools` の一覧取得は既定で5件（最大20件）ずつ返され、続きがある場合は返された `nextOffset` を次回の `offset` に指定します。一覧表示時の説明文は既定で160文字に切り詰められます。ツール詳細スキーマは `tool` 引数で1件ずつ明示して取得します。なお、接続先サーバーから返される説明や出力はすべて外部データとして扱われます。

## エージェントによる追加・削除とコンテキスト管理

管理操作用の詳細引数スキーマは、必要なタイミングでのみエージェントが取得します。これにより、常時公開されるHubツールは5個のまま維持されます。

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

`add` はサーバー定義の登録のみを行い、この時点では接続・インストール・コマンド実行は行われません。ONとして登録されたサーバーは、後続の `hub_tools` や `hub_call` が呼び出された時点で初めて起動・接続されます。URLの名前解決やプライベートIPの検証も接続時に実行されます。

| 操作 | 用途 |
|---|---|
| `help` | 利用可能な操作の一覧を取得。`options.action` を指定すると該当操作の引数スキーマを返却 |
| `add` | `server` をIDとして、新規のHTTP URLまたは許可済みテンプレートを登録 |
| `remove` | エージェントが追加した登録を共有データから削除（所有者定義のサーバーはこのセッションからのみ除外） |
| `focus` | `options.servers` で指定した接続先のみをONにし、それ以外をOFFに変更（空配列で全OFF） |
| `context` | 応答文字数・一覧件数・説明の長さを調整（`options` 省略で現在値とキャッシュ使用量を表示） |
| `result` | サイズ超過で保管された大きな応答を再実行なしで部分取得（`resultId`、任意で `pointer`・`offset`） |
| `forget` | `server` の保管済み結果キャッシュを削除（省略時は全削除） |
| `sync` | 共有フォルダーの状態確認・取り込み、許可された公開／共有削除（詳細は `action: "help"` で確認） |
| `security` | この端末における安全性スイッチの現在値を確認（設定変更は所有者のみCLI等から可能） |

`enable`・`disable`・`start`・`stop`・`status` は、従来どおり対象の `server` を指定して実行します。各管理操作の `options` はコード側で厳格にバリデーションされ、未定義のプロパティは拒否されます。

### 起動テンプレートと安全範囲

ローカルMCPや認証情報が必要なMCPは、所有者が `templates` に起動定義を事前登録します。エージェントはテンプレートIDを指定することで、安全にサーバーを自律追加できます。

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

テンプレートには通常のサーバー設定と同じく `env`・`allowedTools`・`skills`・`toolSkills` などを指定できます。エージェントが追加時に変更できるのは、説明・タグ・初期ON/OFF・Skill ID・ツール許可リストのみです。デフォルトでは、テンプレートで定義されたツール許可リストを拡大する変更は拒否されます。また、コマンド・引数・環境変数・ヘッダー・権限ルールをエージェント経由で変更することはできません。なお、テンプレートで許可リストが省略されている場合は、そのMCPの全ツールが利用可能になります。

初期設定においてエージェントが自由に追加できるURLは、公開HTTPSのみに制限されています。具体的には以下の保護が適用されます。

- ローカルホスト、LAN、クラウドのメタデータアドレス宛のリクエストは拒否されます。ホスト名だけでなく接続時のDNS解決結果も検証され、検証済みのIPアドレスへ直接接続します。
- HTTPリダイレクトは追跡せず、別オリジンへのリクエストは拒否されます（所有者が定義したHTTP設定にも同様に適用されます）。
- URL内のユーザー名・パスワード・クエリ・フラグメントや、エージェントが指定した認証ヘッダー、環境変数の継承は受け付けません。認証が必要な場合は、所有者のテンプレート側で定義します。
- 内部ネットワークのHTTP MCPを利用する場合は、所有者が `agent.allowedHttpOrigins` に完全なオリジン（例：`http://127.0.0.1:8765`）を明示的に指定します。許可されたオリジンに対してのみプライベートIPへの接続を許可します。なお、テンプレートや `servers` へ直接設定されたHTTPエンドポイントも、所有者が明示的に許可した接続先として扱われます。
- `agent.allowPublicHttp: false` に設定すると、URL追加は上記オリジン宛のみに制限されます。また `agent.maxServers: 0` の場合はエージェントによる新規追加自体が禁止されます。所有者が定義したサーバーは `allowAgentRemove: false` を指定することで、エージェントによる除外や削除を禁止できます。

これらはHubが提供する権限境界です。MCPプロセス自体をOSレベルでサンドボックス隔離するものではなく、所有者が許可したローカルMCPはその実行ユーザーの権限で動作します。また、公開HTTPS接続先の信頼性や、エージェントが渡すツール引数の機密性を自動判定する機能はありません。ツールの説明文やSkill内の指示によって、これらの権限ルールが改変されることはありません。

### 同一端末の登録保存

エージェントが追加した設定は、設定ファイル名に `.agents.json` を付与した別ファイルに保存されます（既定では `~/.config/mcp-context-hub/config.json.agents.json`）。所有者の `config.json` が書き換えられることはありません。書き込みロックとファイル置換によって並行更新を安全に処理します。POSIX環境ではファイルパーミッションを0600で作成し、Windows環境では保存先ディレクトリのACLを利用します。

同じ設定ファイルを参照するHubは、次回のツール要求時に登録内容を同期します。新たに追加されたMCPは再起動なしで認識され、削除された接続先はその時点で切断されます。保存されたエージェント登録も、読み込み時に所有者の最新ポリシーに基づいて検証されます。無効な登録やポリシー違反が含まれる場合は処理が拒否され、所有者による設定修正が必要となります。

**v0.3以降、CLIで操作したHubのON/OFF状態は `.device.json` に端末単位で保存されます**。同じ端末・同じconfigを参照する別のHubインスタンスにも、次回のMCPリクエスト時に反映されます。`focus` 操作によるON/OFF切り替えも保存されます。ただし、新規追加サーバーに対するfocusの選択条件、出力量、結果キャッシュはセッションごとに独立しています。別プロセスで実行中の要求を即座に取り消す保証はありません。所有者の `servers` を `remove` した場合は該当セッションから除外されるだけであり、次回のHub起動時や設定再読み込み時には復元されます。エージェント登録用ファイルを手動で編集する際は、事前にHubを停止してください。書き込み中の異常終了などによって `.lock` ファイルが残留した場合は、書き込みプロセスが終了していることを確認した上で、所有者が手動で削除してください。

### Windows / macOS間の同期

両端末から同一の内容が参照できる共有フォルダーを指定します。LAN内のファイル共有（SMB等）でも、Dropbox等のクラウド同期フォルダーでも利用可能です。

```sh
mcp-context-hub sync connect --folder "/ABSOLUTE/PATH/TO/SHARED_FOLDER"
mcp-context-hub sync publish --server blender
```

受信側の端末では、`sync status` や `sync inspect --server blender` で内容を確認し、`sync approve --server blender --revision SHA256` で受信した版を承認します。stdio MCPの実行環境は、受信端末側の同名テンプレートに紐付けられます。新規に受信したサーバーは安全のため初期状態ではOFFになります。承認済みの変更内容はHubを再起動することなく反映されます。同期先フォルダーやテンプレートの変更も、次回のMCPリクエスト時に自動で反映されます。

複数端末での同時編集が発生した場合は競合として検知され、明示的に採用する版を選択します。共有管理されているサーバーを完全に削除する場合は `sync remove` を実行し、自端末のみで停止したい場合は `disable` を使用します。詳細やWindows環境向けの設定例は [同期の手順](docs/sync.md) を参照してください。

### 安全性のカスタマイズ

```sh
mcp-context-hub security show
mcp-context-hub security set allowAgentPublish on
mcp-context-hub security set requireSyncApproval off
```

共有先へのエージェントによる公開許可と、受信した版の承認要求は、それぞれ独立したスイッチとして管理されます。HTTP／stdioの個別許可、HTTPS必須化、プライベートIP制限、ツール許可リストの強制、環境変数の継承なども個別に設定可能です。各端末の所有者が設定を変更でき、次回のMCPリクエスト時に反映されます。各設定の初期値と動作の詳細は [安全性設定](docs/security.md) を参照してください。

### 長い結果を必要な部分だけ読む

通常の応答サイズ上限はJSON形式で6,000文字です。上限を超えるツール実行結果、Skill本文、スキーマ、カタログ情報はメモリ上に一時保持され、短いプレビューと `resultId` のみが返されます。AIによる要約生成などで情報を切り捨てる方式ではありません。

```text
hub_control({"action":"result","options":{"resultId":"返されたUUID","pointer":"/content/0/text"}})
hub_control({"action":"result","options":{"resultId":"同じUUID","pointer":"/content/0/text","offset":1234}})
```

`offset` には前回の応答に含まれる `nextOffset` の値を指定します。`pointer` は元のMCP応答を対象としたJSON Pointerであり、省略した場合は応答全体のJSON文字列を分割して取得します。元の結果がSkillやスキーマを内包するJSONテキストの場合は、そのテキストを完全に読み取った上で解釈されます。画像や音声などのバイナリデータ、あるいは未加工の完全なMCP応答をそのまま受け取りたい場合のみ、`native: true` を指定してください。これを明示的に指定した場合、文字数制限が解除され、元の形式のまま返されます。

結果の保管はセッション内限定で、最大32件・合計16 MiB・有効期間10分間です。上限に達した場合は古い結果から順に自動削除されます。サーバーのOFF、remove、forget、あるいはHubプロセスの終了時にも破棄されます。期限切れとなった結果を再取得する目的で、副作用のある書き込み系ツールを自動で再実行しないようご注意ください。

| preset | 応答上限 | 一覧件数 | 説明の長さ |
|---|---:|---:|---:|
| `compact` | 2,400文字 | 3件 | 100文字 |
| `balanced`（既定） | 6,000文字 | 5件 | 160文字 |
| `full` | 12,000文字 | 10件 | 240文字 |

`context` 操作では、`maxChars`（1,024〜20,000）、`listLimit`（1〜20）、`summaryChars`（40〜300）を個別に数値指定することも可能です。所有者の設定ファイルにあらかじめ同名の `context` オブジェクトを定義しておくと、セッション開始時の初期値として適用されます。なお、ここで扱う文字数は計測しやすい簡易的な上限であり、LLMモデル固有のトークン数や会話履歴全体のコンテキスト長を厳密に制御するものではありません。

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

`command`・パス・ツール名は利用環境に合わせた実際の値に置き換えてください。`skills` はサーバー全体、`toolSkills` は特定ツール向けの追加手順を定義します。同一のSkill IDを複数サーバーから参照でき、重複するIDは自動的に統合されます。なお、Skill IDは設定ファイル内の識別名（エイリアス）であるため、実際のSkillディレクトリ名と一致していなくても問題ありません。

動作の流れは次のようになります。

```text
hub_catalog({"query":"blender"})
  → サーバー概要とskillCountのみ取得（全Skillの説明文は返さない）

hub_catalog({"server":"blender"})
  → 紐づくSkillのIDと説明文を取得（Skill本文は返さない）

hub_skill({"server":"blender","skill":"design"})
  → 選択したSKILL.mdの本文を取得（この時点でもMCPは起動しない）

hub_tools({"server":"blender","tool":"実際のツール名"})
  → 入力スキーマと、そのツールに適用されるSkillのIDを取得

hub_call({"server":"blender","tool":"実際のツール名","arguments":{}})
  → ツールを実行（argumentsは取得したスキーマに合わせて指定）
```

特定ツールに絞って手順を探す場合は、`hub_catalog({"server":"blender","tool":"実際のツール名"})` を呼び出します。サーバー共通のSkillと、そのツール固有のSkillが候補として返されます。Skillの紐付けは関連する手順への案内に過ぎず、すべてのSkillが強制的に読み込まれたり自動実行されたりするわけではありません。

[Blender用の設定例](examples/blender.config.json) と、[MCP操作のSkill](examples/skills/blender-mcp-workflow/SKILL.md)・[デザインSkill](examples/skills/scene-design/SKILL.md) を同梱しています。これらは接続先の実際のツールを検索して利用する構成例です（Blender本体やMCP実装のインストールは含みません）。

### コンテキストを小さく保つ仕組み

- 常時公開するのは固定5ツールのみ。接続時のツール説明文にもSkill一覧を埋め込みません。
- 最初のサーバー検索ではSkillの登録件数のみを返し、各Skillの説明は対象サーバーを指定して取得します。
- Skillの説明は `SKILL.md` のYAML frontmatterから動的に読み取るため、設定ファイル側で説明文を二重管理する必要はありません。
- Skill本文の取得時はfrontmatter部分を除外して返します。付随する参照ファイルは、`hub_skill` の `file` 引数に相対パスを指定して個別に読み込みます。1回の応答は最大12,000文字で、長文の場合は `nextOffset` を次回の `offset` に指定してページングします。
- 取得した本文の `revision` ハッシュを保存しておき、すでに完全な内容がコンテキスト内に存在する場合は `ifRevision` に渡して更新チェックが可能です。変更がなければ `unchanged: true` のみを返します。コンテキスト圧縮後など、本文の再取得が必要な場合は `ifRevision` を省略して再度取得できます。

Hubが管理するSkillをMCPクライアントの自動検出対象外のフォルダーに配置し、クライアント側にはHub自体の案内Skillのみを登録しておくことで、各Skillの説明文が常時コンテキストへ展開されるのを防ぎます（すでにクライアントへ直接登録されているSkillの配置や設定をHubが変更することはありません）。

### ファイルと権限

サーバーがOFFに設定されている場合、紐づくSkill本文の取得も拒否されます。紐付けられていないSkillや、`allowedTools` で除外されたツール専用のSkillは取得できません。Skillディレクトリからの相対参照は、登録ディレクトリ内のUTF-8テキストファイルのみに制限されます。外部を参照するシンボリックリンク、バイナリファイル、256 KiBを超えるファイルは読み込みを拒否します。

`scripts/` ディレクトリ内のスクリプトファイルもテキストとして返却されるだけであり、Hub側で自動実行されることはありません。実行が必要な場合は、エージェントが返却された `basePath` とクライアント側の実行機能（シェルツール等）を用いて実行します。なお、Skill内の `allowed-tools` 指定などをクライアント側の実行権限設定へ自動反映することはありません。

Skill本文を編集した内容は次回の読み取り時に即座に反映されます。登録パスや紐付けの変更も、次回のMCPリクエスト時に反映されます。構文エラー等の壊れたSkillがあっても一覧上は `available: false` と表示されるだけで、他のMCPサーバーの利用を妨げません。詳細は `mcp-context-hub check` で検証可能です。

## ON/OFFとプロセスの扱い

| 操作・設定 | 意味 |
|---|---|
| `enable` | この端末で利用可能にし、ON状態を保存する（この時点ではプロセスは起動しない） |
| `disable` | 後続の定義・Skill本文の取得やツール実行を拒否し、既存の接続を閉じる |
| `start` | ON状態のサーバーを即座に起動・接続する |
| `stop` | 接続を閉じる（ON状態は維持されるため、次回利用時に再起動する） |
| `status` | 接続状態を確認する（アイドルタイマーはリセットしない） |
| `enabled: false` | 端末状態が未保存の場合の初期状態をOFFにする |
| `allowAgentEnable: false` | OFFになったサーバーをエージェントが自律的にONへ戻すことを禁止する |
| `idleTimeoutMs` | アイドル状態から自動停止するまでの待機時間（既定5分、`0` で自動停止無効） |
| `timeoutMs` | 起動および各操作のタイムアウト時間（既定60秒、最大10分） |
| `allowedTools` | 利用可能なツール名のホワイトリスト（省略時は全ツール許可、空配列は全ツール拒否） |

CLIによるON/OFF設定は**端末・設定ファイル単位**で管理されます。複数のMCPクライアントが接続した場合、それぞれ独立したHubインスタンスと子プロセスが稼働します。状態はリクエストごとに確認されます。すべてのクライアントで単一の子プロセスを共有する常駐デーモン方式ではありません。ライブラリとして `new Hub(config)` を直接利用する場合は従来どおりメモリ内で保持され、`DeviceState` を渡すことで端末状態を永続化できます。

同一サーバーに対するツール実行要求は順次（キューイングされて）処理されます。OFFやremoveの操作は実行中の要求へキャンセル通知を送信し、接続を切断します。異なるサーバー同士であれば並行して利用可能です。アイドル停止タイマーは実行完了時点からカウントされます。Hubプロセスの終了時にも実行中の要求がキャンセルされ、SDKのstdio終了処理によって管理下の子プロセスが安全に停止されます。HTTP接続の場合はセッション終了を試行して接続を閉じますが、リモートのサーバープロセス自体の停止は行いません。

タイムアウトやキャンセルによって、外部処理が完全に取り消される保証はありません。Hubはツールの自動再試行を行わないため、副作用を伴う書き込み操作を再試行する際は事前に結果を確認してください。

## 認証と起動設定

stdio接続の `command` には実行可能ファイル名または絶対パス、`args` には引数の配列を指定します。Hubはシェル式を独自に評価せず、SDKへコマンドと引数を分離して渡します。相対パスを扱うサーバーの場合は、絶対パスで `cwd` を指定してください。

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

デフォルト設定では、SDKが提供するHOMEやPATHなどの基本環境変数に加え、設定で明示した `env` および `inheritEnv` のみが子プロセスへ渡されます。`security.inheritProcessEnv: true` に設定すると、Hubプロセスの環境変数全体の継承が有効になります。`env`・`args`・HTTPの `headers` では `${ENV_NAME}` 形式の環境変数展開が利用可能です。展開値はHubプロセスの環境変数から読み取られます。未定義の環境変数が含まれる場合は接続時にエラーとなります。なお、`.env` ファイルの自動読み込みやOAuth認証画面のポップアップ表示などは行いません。

```json
{
  "transport": "http",
  "url": "https://your-service.example/mcp",
  "headers": { "Authorization": "Bearer ${MY_MCP_TOKEN}" }
}
```

Hubがエージェントへ提供するカタログ情報に、コマンドライン・環境変数・HTTPヘッダーが含まれることはありません。内部の通信例外は一般化したエラーメッセージに変換され、子プロセスの標準エラー出力（stderr）は破棄されます。接続に失敗する場合は、ローカル端末上で接続先単体のコマンド、環境変数、認証設定を確認してください。**ツールの実行結果に含まれる機密情報を自動でマスキングする機能はありません**。サイズが小さい応答はそのまま返され、大きな応答はプレビューと取得用IDで返されます。

起動できるのは事前登録されたサーバーのみです。エージェントは前述のセキュリティポリシーの範囲内でのみ登録を追加できます。`hub_call` は書き込み処理を含む可能性があるため、Hub側のツール注釈は安全側に倒して設定されています。クライアントの環境によっては、Hubへのツール実行許可を求めるダイアログが表示される場合があります。

## 対応範囲

- 接続元：stdio MCPクライアント。接続先：stdio / Streamable HTTP。
- 中継対象：ツール一覧・ツール実行。Resources、Prompts、Roots、Sampling、Elicitation、OAuth対話フロー、旧SSE接続には未対応です。これらを必須とする接続先は利用できない場合があります。
- すでに会話履歴（コンテキスト）に入ってしまったツール定義や実行結果をHub側から削除することはできません。サーバーをOFFにすると以降のアクセスを遮断し、メモリ上の保管結果を削除します。必要なツール定義のみを選択取得し、大きな応答を部分取得することで、コンテキストへの余分な追加を最小限に抑えます。
- クライアント自体が内蔵するツールやスキル、プラグイン等による常時注入はHubの管理対象外です。
- 下流のツール群を動的に公開・展開するモードはありません。クライアント側の `tools/list_changed` 対応状況に左右されず、固定5ツール経由で安定して利用できます。

## 開発・検証

```sh
npm run check
npm test
```

外部サービスやモック認証情報に依存せず、実際のstdio子プロセス・ローカルHTTPサーバー・MCPクライアントを立ち上げて包括的な検証を行っています。遅延起動、ツール定義のオンデマンド取得、固定5ツールの整合性、ON/OFF制御、許可リスト、ページネーション、同時リクエスト処理、アイドル停止、異常終了処理、キャンセル、タイムアウト、終了時のプロセス回収に加え、Skillの紐付け・参照ファイル解決・更新検知・本文の遅延取得などをテストしています。

GUIテストでは、ループバック認証、Host/Origin検証、設定競合の検知、Skill添付、同期承認、稼働中MCPへの設定ホットリロード、プロセス終了処理などを検証します。画面はAPIから実データを取得するReact UIで構成されており、ビルド済み成果物を同梱して配布しています。

同期テストでは、独立した2端末分の環境と共有フォルダーを構築し、受信承認、端末別の起動設定およびON/OFF状態、Skill転送、同時編集時の競合検知、配信順序の逆転耐性、オフライン復帰、改ざん検知、CLI操作、実際のMCP経由での再起動不要な取り込みを検証します。GitHub ActionsのCIでは、Windows・macOS・Linux、およびNode.js 22／24の環境で同一テストを実行しています。LANテストでは実際のTLS通信を用いて、ペアリング、両側確認、証明書不一致検知、失効処理、Skill転送、不正レコードの拒否を検証します。CI環境はループバック通信を用いた擬似的な独立端末で実施しており、物理的に別々のPC間でのWi-Fi通信、OSの権限ポップアップ、外部クラウドの転送機構は検証範囲に含みません。

## ライセンス

[Apache License 2.0](LICENSE)
