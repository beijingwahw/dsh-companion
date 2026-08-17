/** 生成 256 位主密钥（首次初始化保险库时调用）。 */
export declare function generateMasterKey(): Uint8Array;
/**
 * 使用 AES-256-GCM 加密明文。
 * @param plaintext 明文字符串。
 * @param key 32 字节密钥。
 * @returns 自描述的 base64 载荷字符串。
 */
export declare function encryptAes256Gcm(plaintext: string, key: Uint8Array): string;
/**
 * 解密 encryptAes256Gcm 产出的载荷。
 * @param payload 载荷字符串。
 * @param key 32 字节密钥。
 * @returns 明文字符串。
 * @throws 载荷格式非法或认证标签校验失败时抛出。
 */
export declare function decryptAes256Gcm(payload: string, key: Uint8Array): string;
