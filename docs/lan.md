# URL・QRでLANペアリング

v0.5以降では、共有フォルダーや外部アカウントを用意せず、WindowsとmacOSのHubを直接つなげられます。同期用のプロセスが各端末で動き、同じLANにいる間だけ接続します。MCPプロセスは従来どおり必要なときだけ起動します。

## 最初の1回

両端末にNode.js 22.12以上と[Hub](../README.md#セットアップ)をインストールします。リリースのパッケージを直接インストールすることもできます。

```sh
npm install --global https://github.com/coco4atJP/mcp-context-hub/releases/download/v0.6.0/nekon-mcp-context-hub-0.6.0.tgz
# 初めて設定する端末だけ実行（既存設定は上書きしません）
mcp-context-hub init
mcp-context-hub install-skill
mcp-context-hub lan install
mcp-context-hub gui
```

`lan install` はこのユーザーのログイン時の自動起動と、カスタムURIスキーム（`mcp-context-hub://`）の登録を行い、LAN同期を開始します。管理者権限や外部サーバーは不要です。GUIでは「同期 → 同期と自動起動の設定 → 自動起動とURLを登録」で登録できます。URL登録がなくても、GUIへのURL貼り付け・QR読み取り・CLIでペアリングできます。

macOSはユーザーLaunchAgentと `~/Applications/MCP Context Hub.app`、WindowsはユーザーのレジストリRunキーとURLプロトコル（URIスキーム）を使います。Windowsではログイン時にPowerShellからNodeを非表示で起動します。ブラウザを開きっぱなしにする必要はありません。Nodeの場所を変えた場合は登録し直してください。

URLで開く設定は `~/.config/mcp-context-hub/config.json` に固定しています。URLから設定パスやCLIフラグを渡すことはできません。`--config` や環境変数で選んだ別プロファイルには、GUIへのURL貼り付け、または `lan pair --config PATH` を使います。

## ペアリング

1. 片方の「同期」で **端末を追加** を押します。5分間・1回だけ有効なURLとQRが表示されます。
2. もう一方の端末でURLを開くか、「招待を受け取る」でURLを貼り付けます。同じ画面からカメラやQR画像でも読み込めます。ブラウザからアプリ起動の確認ダイアログが表示された場合は、許可してHubを開いてください。
3. **両画面に表示された6桁の番号が一致している**ことを確認し、それぞれ「番号が同じ・ペアリング」を押します。片方だけの確認では同期を始めません。
4. 登録済みの相手が一覧に入り、MCP登録と付随Skillを自動で転送します。通常は数秒、変更数が多い場合や再接続では長くかかることがあります。

QRコードをスマートフォンで読み取った場合は、表示されたURLを接続したいPCへ転送してください。スマートフォン用Hubアプリは含まれません。QRの生成・読み取りは端末内で行い、外部サービスに送信しません。

一度ペアリングすると、IPや待受ポートが変わってもmDNSで相手を探し直します。LANから切断されたり端末がスリープすると接続待ちになり、復帰すると自動で同期を再開します。新しい変更を交換するには両方の同期プロセスが同時に動いている必要があります。承認済みのローカルコピーは、相手がオフラインでも利用できます。

## 自動化する範囲

| 項目 | 動作 |
|---|---|
| 同期の転送 | ペアリング後は自動 |
| この端末で定義したMCP登録・付随Skillの編集と削除 | 既定で自動公開。GUIまたは `sync.autoPublish: false` で停止可能 |
| Agentが追加した登録 | 既存の `allowAgentPublish` に従い、Agentまたは所有者が `sync publish` を実行 |
| 受信版の適用 | 既定は確認後に承認。「安全性 → 受信する版を承認」をOFFにすると自動適用 |
| 新しいMCPのON/OFF | 初期OFF。端末ごとに操作 |
| コマンド・起動パス・認証情報・安全性設定 | 転送せず、端末に保持 |

自動公開はSkill原本も読みます。共有するSkill本文に秘密情報を含めないでください。自動公開をOFFにすると、サーバー詳細の「共有する」またはCLIで選んだ登録だけを配布できます。新しく接続した端末に既存の設定がある場合、受信した版で自動上書きされることはなく、それ以降に行われた原本の編集を検出します。同時編集は競合として確認を求めます。

同期されるのは登録情報とSkillです。BlenderやMCPの実行プログラム、依存パッケージは自動インストールされません。stdio接続は、受信側の同名テンプレートまたはローカル接続に結び付けます。初回に `needs-local-setup` が出たら、[端末ごとの起動設定](sync.md#3-受信端末の起動設定を結び付ける)を用意してください。認証が必要なHTTPにも端末側の設定を使います。

## CLI

```sh
mcp-context-hub lan start                   # LANをONにして常駐開始
mcp-context-hub lan invite                  # 招待URLを発行
mcp-context-hub lan pair --url 'mcp-context-hub://pair#…'
mcp-context-hub lan status                  # 両端末の番号とsessionを確認
mcp-context-hub lan confirm --session ID    # 両端末で実行
mcp-context-hub sync status                 # 受信版を確認
mcp-context-hub sync inspect --server blender
mcp-context-hub sync approve --server blender --revision SHA256

mcp-context-hub lan cancel                  # 招待・確認中の接続を取り消す
mcp-context-hub lan unpair --peer SHA256     # この相手からの今後の通信を拒否
mcp-context-hub lan disable                 # LAN同期をOFF
mcp-context-hub lan stop                    # GUIを含む常駐プロセスを終了
mcp-context-hub lan uninstall               # 次回ログインの自動起動とURL登録を解除
```

アンインストール（`lan uninstall`）を実行しても、現在実行中のプロセスは終了しません。両方を止める場合は `lan uninstall` のあと `lan stop` を実行します。ペアリング解除も、既に相手へ渡したデータや履歴を遠隔消去する操作ではありません。

フォルダー同期は引き続き `sync connect --folder PATH` で使えます。LANとフォルダーは切り替え式で、履歴を分けています。方式を切り替えても、既存の履歴が自動で移行されることはありません。LANのスイッチをOFFにすると、以前設定したフォルダーがあればその同期へ戻ります。

## 接続できないとき

- 両方でLAN同期をONにし、同じWi-Fiまたは有線LANへ接続します。ゲストWi-Fiの端末間隔離があると接続できません。
- 現在は同一サブネット内のプライベートIPv4／リンクローカルIPv4による直接通信に対応しています。IPv6のみのLAN、VPN、別VLANを越える接続は対象外です。
- OSがローカルネットワークや受信接続の許可を求める場合は、使うLANに限定して許可してください。HubはOSのファイアウォールを変更しません。WindowsのネットワークプロファイルとNodeのプライベートネットワーク許可を確認します。
- 自動再検出にはmDNS（UDP 5353）、同期にはHubが起動時に選ぶTCPポートを使います。招待URLには最初の接続先も含まれるため、mDNSが使えなくても同じIP・ポートなら接続できます。
- 名前が同じ端末でも証明書で区別します。証明書を削除・再発行した端末には再ペアリングが必要です。証明書の有効期間は5年です。
- GUIの既定ポートはconfigのパスから選ぶ45000–59999のループバックポートです。別ソフトとの競合時は `gui --port PORT` で起動できます。

## 保存と信頼境界

`config.json.lan-data` に共有履歴、`.lan-peers.json` に端末の秘密鍵とペア、`.lan-sources.json` に原本の変更検出情報を保存します。`.gui-session.json` はローカル管理用の認証情報です。**これらのファイルやconfig全体を共有フォルダーへ置いたり、他端末へコピーしないでください。** POSIXでは状態ファイルを0600で作成し、WindowsではユーザープロファイルのACLを利用します。端末内のデータはOSの暗号化設定に従います。

通信はTLS 1.3、端末証明書のSHA-256固定、両側の秘密鍵の所持確認を使います。Web用の認証局やOSの信頼ストアへの追加は不要です。招待は5分・1回限り、さらに両端末で確認するまでは履歴を公開しません。TLSのCA検証を使わない代わりに、アプリケーションデータの送信前に登録済みの証明書と照合し、一致しない場合は接続を拒否します。

mDNSには端末の識別子とポートだけを載せ、招待秘密やSkillは載せません。管理画面はループバック限定のままです。LANの待受口はペアリングと検証済み履歴の転送だけを受け付け、MCPツール呼び出し・任意コマンド・所有者設定の変更は提供しません。既存の安全性スイッチをOFFにしても、この認証・暗号化・LAN限定は解除しません。

ペアは最大20台、1フレーム3 MiB、履歴は2,000版・64 MiB、1版2 MiBです。受信内容のハッシュ・形式・パス・Skill構造を再検証します。以前のSkill内容は履歴にも残り、接続した相手はその履歴を再配布できます。ペアリングは相手へのデータ共有を許可する操作で、OSユーザーや共有済み内容からのプロンプトインジェクションを隔離するサンドボックスではありません。

実装の基盤: [Node.js TLS](https://nodejs.org/api/tls.html)、[multicast-dns](https://github.com/mafintosh/multicast-dns)、[macOS LaunchAgent](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。

## グローバルSkills・設定

v0.6以降では同じペアリングで `~/.agents` の選択済みファイルも共有できます。両端末の「同期」→「グローバルSkills・設定」で対象とON/OFFを設定します。[設定手順と適用ルール](global-agents.md)。v0.5の相手には従来のMCP登録だけを転送します。
