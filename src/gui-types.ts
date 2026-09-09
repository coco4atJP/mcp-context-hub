import type { Config } from './config.js';
import type { SyncManager } from './sync.js';
import type { LanStatus } from './lan.js';

export type GuiServer = { server: string; description: string; enabled: boolean; source: 'configured' | 'agent' | 'sync'; skillCount?: number; agentCanEnable?: boolean; locallyDefined?: boolean };
export type GuiState = {
  revision: string; configPath: string; platform: string;
  servers: GuiServer[];
  templates: { id: string; description: string; transport: string }[];
  skills: { id: string; description: string }[];
  security: Config['security'];
  sync: Awaited<ReturnType<SyncManager['status']>> & { folder?: string };
  lan?: LanStatus;
  serviceInstalled?: boolean;
};

export const securityLabels = {
  allowStdio: ['ローカルMCP', 'この端末でstdioサーバーを起動できます。'],
  allowHttp: ['HTTP接続', 'HTTP経由のMCPへ接続できます。'],
  allowAgentRegistration: ['Agentによる追加', 'URLや許可済みテンプレートの登録を任せます。'],
  allowAgentPublish: ['Agentによる共有', 'MCP登録とSkillの公開・共有削除を任せます。'],
  requireSyncApproval: ['受信する版を承認', '共有先から届く変更は、内容を確認して取り込みます。'],
  requireHttps: ['HTTPSを必須にする', 'Agentが追加するURLの平文HTTP接続を制限します。'],
  blockPrivateHttp: ['非公開IPを制限', 'Agentが追加するURLのLAN・ループバック接続を制限します。'],
  enforceToolAllowlist: ['ツール許可リスト', '許可したツールだけを利用できます。'],
  inheritProcessEnv: ['環境変数をすべて渡す', 'ONにすると、トークンなども子プロセスへ渡り得ます。'],
} as const;
