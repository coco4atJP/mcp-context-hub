# Windows / macOSの共有フォルダー同期

共有フォルダーを用意せず同じLANでつなぐ場合は、[URL・QRペアリング](lan.md)を利用できます。以下はフォルダー方式の説明です。

Hubを各端末へインストールし、同じ内容が見えるフォルダーを指定します。専用の同期サーバー、Hubの待受ポート、追加アカウントは不要です。LANでは既存の共有フォルダー、LAN外では既に利用しているクラウド同期フォルダーを使えます。フォルダーの転送・マウント・アクセス権の管理は、その仕組みに任せます。

Hubは必要なツール要求が来た時に共有フォルダーを確認します。確認間隔は既定10秒です。Hubや同期用デーモンを常時起動する必要はありません。

## 共有するものと端末に残すもの

| 共有するもの | 各端末に残すもの |
|---|---|
| 選択したMCPのID・説明・タグ | ON/OFFと起動中プロセス |
| 公開HTTP URL、または起動テンプレートのID | 実行コマンド・引数・作業パス |
| ツール許可リスト・Skillの紐づけ | 環境変数・認証ヘッダー・秘密情報 |
| Skill本文・参照テキスト・スクリプト | 安全性設定・同期先パス・受信版の承認 |
| 登録変更・削除の履歴 | 応答キャッシュと会話履歴 |

stdioサーバーは実行環境が端末ごとに違うため、共有ファイルには起動テンプレートIDだけを書きます。例えば両方で `blender` というテンプレートを定義し、MacはMacの実行ファイル、WindowsはWindowsの実行ファイルに向けます。MCPの実行ファイルやBlender自体を同期・自動インストールする機能ではありません。

共有するSkillはHubのローカルキャッシュに配置されます。クライアントの自動検出対象にコピーしないので、同期したSkillの説明・本文が常時コンテキストへ入ることはありません。固定5ツールから必要な内容だけ取得します。

## 1. 同じ共有フォルダーへ接続

両端末で [セットアップ](../README.md#セットアップ) を実行します。Windowsも同じNode.jsパッケージです。PowerShellでは `Get-Command node` でNodeのパス、`npm root -g` でパッケージの場所を確認できます。

Macで、既に存在する共有フォルダーの絶対パスを指定します。

```sh
mcp-context-hub sync connect --folder "/Volumes/Shared/McpHub"
```

Windowsでは、同じ共有先のWindows側のパスを指定します。ドライブ文字のパスやUNCパスを利用できます。

```powershell
mcp-context-hub sync connect --folder "Z:\McpHub"
```

クラウド同期フォルダーでもコマンドは同じです。Hubが扱うファイルを両端末でローカルに利用可能な状態にしてください。接続先パスは共有しません。設定は次のMCP要求で反映します。

`connect` は `config.json` に `sync.folder` を設定し、共有先に `mcp-context-hub-v1/changes` を作ります。マウントされていない場所を誤って作らないよう、指定先フォルダー自体は存在する必要があります。**所有者のconfigと端末状態は共有フォルダーの外に置いてください。** config全体や `.agents.json` をクラウド同期する方式ではありません。

## 2. 配布するMCPを指定

既にHubへ登録している `blender` を共有する例です。

```sh
mcp-context-hub sync publish --server blender
```

`servers.blender` があれば、その設定とローカルSkill原本を読みます。Agent追加分も公開できます。その場合はAgentが選んだテンプレートIDを引き継ぎます。通常の追加操作だけでは共有先へ送信しません。

登録と公開はMCPを起動しません。送信元のON/OFFは維持されます。共有管理へ移ったサーバーのカタログでは `source: "sync"` と表示します。ローカルの原本を編集した後は再び `publish` してください。`config.json` の変更をCLIは毎回読み込み、起動済みHubは次のMCP要求で読み直します。

## 3. 受信端末の起動設定を結び付ける

受信するstdio MCPのテンプレートを、受信端末のconfigに定義します。次はWindowsの例です。パスは実際のものへ変更してください。

```json
{
  "version": 1,
  "sync": { "folder": "Z:\\McpHub" },
  "templates": {
    "blender": {
      "transport": "stdio",
      "command": "C:\\Tools\\blender-mcp.exe",
      "env": { "SERVICE_TOKEN": "${LOCAL_SERVICE_TOKEN}" },
      "allowedTools": ["get_scene_info", "execute_blender_code"]
    }
  },
  "servers": {}
}
```

上のツール名・コマンドは例です。インストールしたMCPの実際の定義を使ってください。設定変更は次のMCP要求で反映します。テンプレートがなければ `needs-local-setup` となり、実行を保留します。共有元のSkill原本のパスを用意する必要はありません。

別名のテンプレートを使う場合や、HTTP MCPへ端末固有の認証を付ける場合は `sync.bindings` を使います。

```json
{
  "sync": {
    "folder": "Z:\\McpHub",
    "bindings": { "blender": "my-blender", "docs": "my-authenticated-docs" }
  }
}
```

これは既存configの `sync` 部分の例です。`templates` に各IDの実際の起動定義を用意します。優先順位は **明示したbinding → 同じIDのローカルservers → 共有テンプレート／公開URL** です。ローカルの接続定義がある場合は、そのURL・コマンド・認証を維持します。共有URLの変更によってローカル認証情報が別の接続先へ送られることを防ぎます。ツール許可リストも、既定ではローカル側の許可範囲との共通部分になります。

HTTPのURL共有では認証ヘッダーを送りません。URLにはユーザー名・パスワード・クエリ・フラグメントを含められません。LAN内HTTP接続には、所有者のテンプレート・binding、または `agent.allowedHttpOrigins` を設定します。

## 4. 受信した版を確認して承認

```sh
mcp-context-hub sync status
mcp-context-hub sync inspect --server blender
mcp-context-hub sync approve --server blender --revision 表示された64桁のSHA256
```

`inspect` は配布内容全体をJSONで表示します。Skillも確認してから、その内容のハッシュを指定して承認します。確認後に版が変わった場合や競合している場合、承認を拒否します。新規受信サーバーは承認後も初期OFFです。エージェントが `hub_control enable` でONにすると、その後の利用時に起動します。既存サーバーの更新では、その端末で保存済みのON/OFFを維持します。

登録・Skillが更新されると再承認が必要です。受信済みサービスの未承認更新・競合・不完全な履歴を検出したHubは、その接続を閉じ、保管した結果を削除して利用を保留します。承認後は次のツール要求で利用可能になります。共有フォルダーがオフラインの場合は、最後に承認済みのローカルコピーを利用できます。実行中の外部処理を取り消す保証はありません。

信頼する共有フォルダーで版ごとの確認を省く場合、受信端末で明示的に設定します。

```sh
mcp-context-hub security set requireSyncApproval off
```

次のMCP要求から、競合しない完全な版を自動で取り込みます。フォルダーへの書き込み権限を持つ相手がSkill内容と接続情報を変更できる設定です。端末のテンプレート・認証・安全性設定は共有内容で変更できません。新規受信の初期OFFは維持します。

## エージェントから利用

```text
hub_control({"action":"help","options":{"action":"sync"}})
hub_control({"action":"sync","options":{"operation":"status"}})
hub_control({"action":"sync","options":{"operation":"pull"}})
```

`status` は短い一覧、`pull` は確認間隔を待たずに変更を確認します。`offset`・`limit` でページングします。受信が保留中なら `pending-approval`、`conflict`、`incomplete`、`needs-local-setup` が表示されます。

共有先への公開・削除も任せる場合は、所有者が送信元で `mcp-context-hub security set allowAgentPublish on` を設定します。次のMCP要求で反映します。

```text
hub_control({"action":"sync","server":"blender","options":{"operation":"publish"}})
hub_control({"action":"sync","server":"blender","options":{"operation":"remove"}})
```

承認・競合解決・同期先設定・安全性変更はMCPから提供しません。エージェントがCLIやconfigを扱う場合も、取得したSkillやツール結果に書かれた指示を所有者の許可とみなさないでください。

## 同時編集・削除・履歴

変更は内容ハッシュのファイル名で追記し、親となる版を記録します。端末間の時刻差やクラウド上の同じファイルへの同時書き込みに依存しません。別のMCPへの編集は独立して取り込めます。同じMCPへの同時編集は自動で上書きせず、競合として表示します。

```sh
mcp-context-hub sync inspect --server blender --revision 確認したい版
mcp-context-hub sync resolve --server blender --revision 採用する版
```

`resolve` は選んだ内容を採用し、全ての競合版を親とする新しい版を公開します。過去の既存版を選んで復元することもできます。他端末は新しい解決版を承認します。

共有登録の削除は `sync remove --server blender` です。削除も履歴として伝播します。この端末だけ利用を止める場合は通常の `disable` を使います。共有ファイルを手動で消しても登録削除とは扱わず、欠損・未到着として利用を保留します。クラウドの配信順序が前後した場合も、親版が揃うまで待ちます。

履歴は最大2,000版・合計64 MiB、1版2 MiBです。履歴やローカルキャッシュを自動で消去する機能はありません。上限に達したら履歴を保管して新しい共有フォルダーへ切り替え、必要な登録を改めて公開・承認してください。削除したSkillの以前の内容も過去版には残ります。

## Skillの転送範囲と信頼境界

標準の [Agent Skills構成](https://agentskills.io/specification) に合わせ、`SKILL.md` と `references/`・`scripts/`・`assets/` のUTF-8テキストを転送します。対象拡張子は `md, txt, json, yaml, yml, js, mjs, cjs, ts, py, sh, ps1, csv` です。その他のファイル・ドットファイル・秘密情報を示す一部の名前は対象外です。バイナリ画像・実行ファイル・依存パッケージは転送しません。

1ファイル256 KiB、1Skill 1 MiB・128ファイル、1サーバー30Skillsまでです。絶対パス・パストラバーサル・シンボリックリンク・Windowsの予約名・大文字小文字だけが違うファイル名・不正なfrontmatterは拒否します。スクリプトをHubが実行することはありません。

**Skill本文・説明・URLのパスに書かれた秘密情報を自動判別するものではありません。** 公開する原本には資格情報を含めないでください。同期フォルダーは平文で、アクセス制限や転送の暗号化は共有機構側の設定を使います。SHA256は内容の同一性を確認するもので、端末IDは送信者の認証や署名ではありません。読み取れる他ユーザーには配布内容が見えるため、共有先のメンバーを限定してください。

Hubが保証するのはMCP APIとデータ形式の境界です。同じOSユーザーとしてconfigやCLIを自由に操作できるプログラムを隔離するものではありません。

## GUIを使う

`mcp-context-hub gui` の「同期」から共有フォルダーを選択できます。受信版の「内容を見る」で接続先・許可ツール・Skillファイルを確認し、その版だけを承認します。競合時は採用する版を明示します。送信はサーバー詳細の「共有する」から行います。[GUIの操作手順](gui.md)
