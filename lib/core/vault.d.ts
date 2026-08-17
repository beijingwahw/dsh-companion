/**
 * 加密保险库：在 Harness 存储域内以 AES-256-GCM 加密保存敏感值（API Key）。
 *
 * 设计说明（安全模型，详见 README「安全与隐私」）：
 * - 主密钥在首次使用时随机生成，保存在同一存储域的 vault-meta 表；
 *   存储后端（json/sqlite）位于 Harness home 的插件沙箱内，不出本机。
 * - 敏感值永远以密文落盘（vault 表），读取时解密，绝不写入日志。
 * - 若部署同时启用了 credentials seam，成本模块会优先经
 *   `ctx.credentials` 解析 DEEPSEEK_API_KEY（值由凭据提供者持有）。
 */
import type { Domain } from '@deepseek-ai/dsh-storage';
/** 存储域内的加密键值保险库。 */
export declare class SecretVault {
    private readonly meta;
    private readonly secrets;
    /**
     * 实例级主密钥 promise 缓存：并发的首次访问共享同一次生成/读取，
     * 避免 check-then-act 竞态下生成两把主密钥互相覆盖（密文永久无法解密）。
     */
    private keyPromise?;
    constructor(domain: Domain);
    /** 写入（或覆盖）一个加密秘密。 */
    setSecret(name: string, value: string): Promise<void>;
    /** 读取并解密一个秘密；不存在或解密失败返回 undefined。 */
    getSecret(name: string): Promise<string | undefined>;
    /** 秘密是否已配置。 */
    hasSecret(name: string): boolean;
    /** 删除一个秘密。 */
    deleteSecret(name: string): Promise<void>;
    /** 获取主密钥（memoized：全实例只生成/读取一次）。 */
    private masterKey;
    /** 实际执行主密钥的读取或首次生成（仅经 masterKey 的缓存调用）。 */
    private loadOrCreateMasterKey;
}
