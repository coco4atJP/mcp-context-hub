# 端末ごとの安全性設定

所有者が `config.json` の `security`、またはローカルCLIで変更します。省略時は下記の初期値です。安全性設定は他端末へ同期しません。切り替えはHubの再起動後に反映します。

```sh
mcp-context-hub security show
mcp-context-hub security set allowAgentPublish on
mcp-context-hub security set requireSyncApproval off
mcp-context-hub security reset
```

`on` はその名前の機能を有効にし、`off` は無効にします。例えば `blockPrivateHttp off` はブロックを外し、`allowStdio off` はstdio接続自体を止めます。`reset` は全9項目を初期値へ戻します。

| スイッチ | 初期値 | 動作 |
|---|---|---|
| `allowStdio` | ON | ローカルstdio MCPを起動できる |
| `allowHttp` | ON | HTTP MCPへ接続できる |
| `allowAgentRegistration` | ON | AgentがURL・許可済みテンプレートを新規登録できる |
| `allowAgentPublish` | OFF | Agentが共有フォルダーへMCP・Skillを公開／共有削除できる |
| `requireSyncApproval` | ON | 受信した版ごとに所有者がハッシュを確認して承認する |
| `requireHttps` | ON | Agent追加・共有URLはHTTPS必須。所有者が許可したオリジンは除外 |
| `blockPrivateHttp` | ON | Agent追加・共有URLの非公開IP・特殊IPをDNS解決時にも拒否。所有者の接続定義・許可オリジンは除外 |
| `enforceToolAllowlist` | ON | ツール許可リストを一覧・実行・Skill紐づけで強制し、テンプレートの許可範囲拡大を拒否 |
| `inheritProcessEnv` | OFF | ONにするとHubの環境変数全体をstdio子プロセスへ渡す。OFFではSDKの基本環境＋明示した変数のみ |

安全範囲を広げる設定は、対象の端末でのみ変更してください。例えば `inheritProcessEnv on` はAPIトークンなども子プロセスへ渡し得ます。LANの1つのMCPだけを使う場合は、`agent.allowedHttpOrigins` への登録で接続先を限定できます。一般のHTTPと非公開IPの両方を自由に許可するには `requireHttps off` と `blockPrivateHttp off` が必要です。

既存の `agent.allowPublicHttp`・`agent.allowedHttpOrigins`・`agent.maxServers`、サーバー別の `allowAgentEnable`・`allowAgentRemove`・`allowedTools`・タイムアウトも併用できます。登録禁止の設定は新規登録を止めます。既存サービス全体の通信を止めるにはトランスポートのスイッチを使います。

MCPからは次の読み取りだけを提供します。

```text
hub_control({"action":"security"})
```

MCPの説明やSkill内の指示によってスイッチを変更することはできません。CLI・configは所有者の管理経路なので、エージェントがこれらを扱う場合も、所有者の依頼に従ってください。同一OSユーザーとしてファイルやシェルにアクセスできるプロセスに対するOSサンドボックスではありません。

共有データの形式検証・ハッシュ検証・パス制約、HTTPの別オリジン通信／リダイレクト拒否、応答サイズ制限は常に適用します。設定ファイルは置換前に検証し、他の設定項目を維持します。POSIXでは端末の状態ファイルを0600で作成します。Windowsのファイル保護は保存先のACLに従います（[Node.jsのファイルモード](https://nodejs.org/api/fs.html#file-modes)）。
