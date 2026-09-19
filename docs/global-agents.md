# グローバルSkills・設定とAgentのアクセス権限

v0.6以降は、AgentによるローカルMCP登録と `~/.agents` の同期を、端末ごとの権限で管理できます。GUI・CLI・固定5個のMCPツールから利用します。

## Agentに任せる範囲

GUIの「安全性」で「標準」「フルアクセス」を選択します。個別スイッチも使えます。

```sh
mcp-context-hub security preset full
mcp-context-hub security preset standard
```

フルアクセスは、ローカルコマンドの登録・更新、認証用環境変数やHTTPヘッダーの指定、ローカルSkill添付、共有への公開・削除、受信版の承認・競合解決、選択済みグローバルファイルの適用をAgentに許可します。受信版の都度承認・HTTPS必須・非公開IP制限・ツール許可リストの強制を解除し、子プロセスへHubの環境変数を継承します。

**実行するMCPには、このOSユーザーの権限と渡された認証情報が使えます。** フルアクセスでも、Hub管理画面の認証、LANの相手認証・暗号化、共有データの検証、選択外パスへの書き込み禁止は維持します。Codex等のクライアントやOSの承認・権限を変更する機能ではありません。

プリセットは `security` の14項目だけを変更します。既に設定した `agent.maxServers`・`agent.allowPublicHttp`、サーバー別の起動/削除ロック、同期先と同期対象は維持します。安全性はMCPや受信したSkillから変更できません。[全スイッチ](security.md)

Agentは `help` で操作のスキーマを取得します。

```text
hub_control({"action":"security"})
hub_control({"action":"help","options":{"action":"add"}})
hub_control({"action":"add","server":"local-example","options":{
  "command":"/ABSOLUTE/PATH/TO/node",
  "args":["/ABSOLUTE/PATH/TO/mcp-server.mjs"],
  "skillPaths":{"guide":"/ABSOLUTE/PATH/TO/skill-folder"}
}})
```

WindowsではWindows側のパスを指定します。シェル式ではなくコマンドと引数配列を分離します。登録だけでは起動せず、ONのサーバーへの最初のツール要求で起動します。インストール機能は含みません。`update` はAgent所有の登録を完全置換し、次の利用から新しい定義を使います。権限を取り消すと該当登録は停止状態となり、Hubの他の登録は使い続けられます。

CLIから同じAgent向け操作を実行する場合は、`options` の内容をJSONファイルに保存します。

```sh
mcp-context-hub control add --server local-example --input registration.json
mcp-context-hub control update --server local-example --input registration.json
```

この `control` 経由ではMCPと同じAgent権限を検査します。所有者用の `security`・`agents` CLIとは区別されます。

## ~/.agents の同期を始める

1. 両端末を[LANでペアリング](lan.md)するか、[同じ共有フォルダー](sync.md)へ接続します。
2. 両端末のGUI「同期」→「グローバルSkills・設定」で、全Skillsまたは選択したSkillsと設定ファイルを指定します。
3. 同期をONにして「対象を保存」を押します。常駐中は自動で公開・受信し、標準設定では受信版の「内容を見る」から承認して適用します。

設定例（`global-settings.json`）：

```json
{"enabled":true,"skills":"all","files":["AGENTS.md"]}
```

```sh
mcp-context-hub agents configure --input global-settings.json
mcp-context-hub agents preview
mcp-context-hub agents sync
mcp-context-hub agents status
```

`preview` は登録済み対象の件数・サイズ・除外理由を確認する読み取り操作です。`agents enable` / `agents disable` でも切り替えられます。OFFや対象の除外ではインストール済みファイルを削除しません。自動同期にはGUIの常駐プロセスが必要です。`lan install` でログイン時に起動でき、LANを使わないフォルダー方式でもグローバル同期を処理します。常駐させない場合は `agents sync` を実行します。

既定ルートは各端末のホームにある `.agents` です。別の場所を使う場合だけ `globalAgents.root` に絶対パスを設定します。ルートパスと対象の選択は端末ごとに保持します。`AGENTS.md` がまだない端末ではスキップし、作成された時点で共有します。

### 共有範囲

- `skills/<skill-name>/` の `SKILL.md`、参照資料、スクリプト、画像・補助ファイルを共有します。スクリプトを同期の一環として実行しません。
- 設定ファイルは明示した相対パスのUTF-8テキスト（md/txt/json/toml/yaml/yml）だけです。
- `.skill-lock.json`、ドットファイル、`node_modules` は転送しません。シンボリックリンク・秘密鍵/認証情報を示す一部のファイル名は拒否します。
- パスの逸脱、Windows予約名、大小文字の衝突を拒否します。Skill名は小文字英数字とハイフン、ディレクトリ名とfrontmatterのnameを一致させます。内部パスは移植可能なASCII名、最大240文字・10階層です。
- 1ファイル256 KiB、1パッケージ1,400 KiB・256ファイル、ローカル対象600パッケージまでです。全同期履歴の上限も[共通](sync.md#同時編集削除履歴)です。

内容に書かれた認証情報を自動検出する機能ではありません。選択する設定とSkillには秘密情報を入れないでください。ペアリング相手・共有フォルダーの利用者には履歴も共有されます。

MCPに付随するSkillはHub内だけで必要時に読みます。一方、この機能は `~/.agents/skills` へ実ファイルを配置するため、Agentクライアントが通常のグローバルSkillとして発見します。その説明のコンテキストへの読み込み方はクライアントに従います。Hub自身が公開するMCPツールは5個のままです。

## 更新・競合・復元

Skillごと・設定ファイルごとに版を管理します。ローカル編集を自動で新しい版として公開し、受信版は承認設定に従って適用します。ローカルの未共有編集と衝突した場合はフルアクセスでも保留します。Agentに判断を任せる場合は、`agents` の `inspect`、`resolve`、`apply` を使えます。

```text
hub_control({"action":"help","options":{"action":"agents"}})
hub_control({"action":"agents","options":{"operation":"status"}})
hub_control({"action":"agents","options":{"operation":"inspect","target":"skills/design-guide"}})
```

`inspect` はまずファイル一覧だけを返します。本文が必要なら返されたファイル名を `file` に指定します。`apply`・`resolve`・`remove` は対象版のSHA256を指定します。MCPからは所有者が選択した対象だけを操作できます。

```sh
mcp-context-hub agents inspect --target skills/design-guide
mcp-context-hub agents apply --target skills/design-guide --revision SHA256
# ローカル編集も置換する場合だけ明示
mcp-context-hub agents apply --target skills/design-guide --revision SHA256 --overwrite
```

書き換え前に全対象の競合を確認し、各ファイルを一時ファイルから置換します。上書き・削除前の内容は `<config.json>.global-backups/<UUID>/backup.json` にbase64で保存し、結果に保存先を返します。`files[].file` がルートからの相対パス、`before` が元のバイト列（nullは元々なかったファイル）です。復元する場合は同期をOFFにして内容とパスを確認し、必要な元ファイルを復号して戻します。

全ファイルをまとめたトランザクションではありません。異常終了やI/Oエラー時は一部だけ置換される場合があります。バックアップを保持し、残った競合を確認して再適用します。設定変更時は古い設定による以後の書き込みを止めますが、既に完了した変更は巻き戻しません。

削除は管理済みで変更のないファイルだけに反映します。未管理ファイルは残します。ファイルの実行権限は共有せず、既存ファイルは端末側の権限を維持し、新規ファイルはPOSIXで0600です。スクリプトは必要なインタープリターで実行するか、端末側で実行権限を設定してください。

両端末がv0.6以降ならグローバル同期を使えます。v0.5とのLAN接続では従来のMCP登録のみを転送し、共有フォルダーでも旧版はグローバル履歴を無視します。
