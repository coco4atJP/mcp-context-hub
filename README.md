# MCP Context Hub

必要なMCPサーバーを、必要なときだけ使うためのローカルHubです。Node.js 22以上で動作します。

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
npm install --global ./nekon-mcp-context-hub-0.1.0.tgz
mcp-context-hub init
mcp-context-hub install-skill
mcp-context-hub config-path
```

tarballをインストールするため、元のリポジトリを移動しても再利用できます。npmレジストリへの公開は不要です。`init` は空の設定を作り、既存ファイルは上書きしません。

`install-skill` はHubの使い方を案内する [mcp-context-hub Skill](skills/mcp-context-hub/SKILL.md) を `$CODEX_HOME/skills`（未設定なら `~/.codex/skills`）に配置します。既存の `SKILL.md` は上書きしません。別クライアント用には `--skills-dir /absolute/path/to/skills` で配置先を指定できます。クライアントがSkillを再検出した後に利用できます。

設定ファイルの選択順は `--config` → `MCP_HUB_CONFIG` → `$XDG_CONFIG_HOME/mcp-context-hub/config.json` → `~/.config/mcp-context-hub/config.json` です。Hub起動時に読み込みます。編集後はクライアントからHubを再起動してください。

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
| `hub_control` | ON/OFF、起動、停止、状態確認 | `start` の場合のみ |

```text
hub_catalog({"query":"テスト"})
hub_tools({"server":"demo"})
hub_tools({"server":"demo","tool":"echo"})
hub_call({"server":"demo","tool":"echo","arguments":{"message":"こんにちは"}})
hub_control({"server":"demo","action":"disable"})
```

サーバーの説明・タグを用途に合わせて書くと、エージェントが自律的に選択しやすくなります。`hub_catalog` の検索には紐づくSkillのID・説明も使います。空白区切りの語を全て含む部分一致検索です。検索結果がなければ語を減らすか、クエリを省略します。`hub_catalog` と `hub_tools` の一覧は既定20件、最大50件で、`nextOffset` を次の `offset` に指定します。一覧には入力スキーマを含めません。スキーマは `tool` で1個ずつ指定して取得します。接続先から返る説明や出力は外部データとして扱います。

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

Skill本文の編集は次回の読み取りに反映されます。登録パスや紐づけの変更はHubの再起動で反映します。壊れたSkillは一覧で `available: false` と表示し、ほかのMCPの利用を妨げません。詳細は `mcp-context-hub check` で確認できます。

## ON/OFFとプロセスの扱い

| 操作・設定 | 意味 |
|---|---|
| `enable` | このHubセッションで利用可能にする。まだ起動しない |
| `disable` | 後続の定義・Skill本文の取得と実行を拒否し、接続を閉じる |
| `start` | ONのサーバーをすぐ起動・接続する |
| `stop` | 接続を閉じる。ONのままなので次の利用時に再起動する |
| `status` | 状態を確認する。アイドルタイマーは延長しない |
| `enabled: false` | Hub起動時の初期状態をOFFにする |
| `allowAgentEnable: false` | OFFになったサーバーをエージェントがONへ戻すことを禁止する |
| `idleTimeoutMs` | 未使用時の停止までの時間。既定5分。`0` なら自動停止なし |
| `timeoutMs` | 起動と各操作の制限時間。既定60秒。最大10分 |
| `allowedTools` | 利用できるツール名の許可リスト。省略は全て、空配列は全て拒否 |

ON/OFFは**会話側のHubプロセス単位**です。グローバルに共有するのは設定ファイルと実行プログラムです。複数クライアントが接続した場合、それぞれ独立したHubと子プロセスが動きます。全クライアントで単一の子プロセスを共有する常駐デーモンではありません。

同一サーバーへの操作は順番に実行し、実行中の操作が終わってから停止します。別サーバーは並行利用できます。アイドル停止は実行完了から計測します。Hub終了時は実行中の要求をキャンセルし、SDKのstdio終了処理で管理下の子プロセスを停止します。HTTPではセッション終了を試みて接続を閉じますが、リモートのサーバープロセス自体は停止しません。

タイムアウトやキャンセルは外部処理の取り消しを保証しません。Hubはツール実行を自動再試行しません。書き込みを再試行する前に結果を確認してください。

## 認証と起動設定

stdioの `command` は実行ファイル名または絶対パス、`args` は引数配列です。シェルを介さず起動します。相対ファイルを扱う接続先には絶対パスの `cwd` を指定してください。

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

SDK既定のHOME・PATHなどの基本環境に加え、明示した `env` と `inheritEnv` だけを子プロセスへ渡します。`env`・`args`・HTTPの `headers` で `${ENV_NAME}` を展開できます。値はHubプロセスの環境から読みます。未定義なら接続時に失敗します。`.env` の自動読み込みやOAuthログイン画面の起動は行いません。

```json
{
  "transport": "http",
  "url": "https://your-service.example/mcp",
  "headers": { "Authorization": "Bearer ${MY_MCP_TOKEN}" }
}
```

Hubのカタログにコマンド・環境変数・ヘッダーは出しません。通信例外は接続先IDを含む一般化したエラーに変換し、子プロセスのstderrは破棄します。接続できない場合は、ローカル端末で接続先単体のコマンド・環境・認証を確認してください。**ツールが正常応答として返す内容はそのまま転送されます**。

登録済みサーバーのみ起動できます。エージェント向けに任意コマンドの登録機能は公開していません。`hub_call` は書き込みも含むため、Hub側のツール注釈は保守的に設定しています。クライアント側でHubへの実行許可が必要な場合があります。

## 対応範囲

- 接続元：stdio MCPクライアント。接続先：stdio / Streamable HTTP。
- 中継対象：ツール一覧・ツール実行。Resources、Prompts、Roots、Sampling、Elicitation、OAuth対話フロー、旧SSE接続は未対応です。それらを必須とする接続先は利用できない場合があります。
- 既に会話履歴へ入った定義や結果は削除できません。OFFは以降のアクセスを止めます。コンテキスト削減はツール定義を最初から自動注入しないことで実現します。ツール実行結果のサイズは制限していません。
- クライアント内蔵のツール、スキル、プラグイン由来の常時注入はHubの管理対象外です。
- 動的に下流ツールを公開するモードはありません。クライアントの `tools/list_changed` 対応に依存せず、固定5ツールで利用します。

## 開発・検証

```sh
npm run check
npm test
```

外部サービスや認証情報を使わず、実際のstdio子プロセス・ローカルHTTPサーバー・MCPクライアントを用いて検証します。遅延起動、定義の選択取得、固定5ツール、ON/OFF、許可リスト、ページング、同時要求、アイドル停止、異常終了、キャンセル、タイムアウト、終了時の子プロセス回収に加え、Skillの紐づけ・参照ファイル・更新検出・本文の遅延取得を含みます。
