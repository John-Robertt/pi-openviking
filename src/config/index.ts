/**
 * Configuration & Credentials：装配阶段使用的纯解析能力。
 * 当前配置面只有 observation 请求；endpoint、凭证引用与超时随其消费者进入。
 */
export interface ExtensionConfig {
  /** 观察证据输出文件；为 null 时扩展不产生任何观察副作用。 */
  observation: { file: string } | null;
}

export function resolveConfig(env: NodeJS.ProcessEnv): ExtensionConfig {
  const file = env.PI_OPENVIKING_OBSERVE?.trim();
  return { observation: file ? { file } : null };
}
