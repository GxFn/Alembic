import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  assertSemanticDispositionReviewTrustPolicyV3,
  type SemanticDispositionReviewerModelLoadReceiptV1,
  type SemanticDispositionReviewTrustPolicyV3,
} from '@alembic/core/production';
import { hashBytes, hashCanonicalJson } from '@alembic/core/project-context-foundation';

const CUSTODY_DIRECTORY = 'semantic-review-trust';
const PRIVATE_KEY_FILE = 'signing-key.pk8';
const POLICY_REGISTRY_FILE = 'approved-policies.json';

interface SemanticReviewPolicyEnrollmentV1 {
  readonly schemaVersion: 1;
  readonly status: 'approved' | 'revoked';
  readonly enrollmentKey: string;
  readonly policy: SemanticDispositionReviewTrustPolicyV3;
  readonly enrollmentHash: string;
}

interface SemanticReviewPolicyRegistryV1 {
  readonly schemaVersion: 1;
  readonly enrollments: readonly SemanticReviewPolicyEnrollmentV1[];
  readonly registryHash: string;
}

export interface SemanticReviewTrustPreparationV1 {
  readonly privateKey: KeyObject;
  readonly policy: SemanticDispositionReviewTrustPolicyV3;
  readonly enrollmentHash: string;
}

/**
 * Main 宿主的稳定签名 custody 与公开 policy registry。
 *
 * 它复用 workspace 既有 `.asd` runtime root；这里只保存 PKCS#8 私钥和可公开的
 * enrollment，不承载 review 进度、attestation 或另一套 journal。task/checkpoint 只能
 * 带回已批准 policyHash，不能要求生成、替换或撤销 key/policy。
 */
export class SemanticReviewTrustStore {
  readonly #dataRoot: string;
  readonly #custodyRoot: string;
  readonly #privateKeyPath: string;
  readonly #registryPath: string;
  readonly #workspaceIdentityHash: string;

  constructor(input: { readonly dataRoot: string }) {
    if (!path.isAbsolute(input.dataRoot)) {
      throw new Error('STRICT_SEMANTIC_REVIEW_DATA_ROOT_INVALID');
    }
    this.#dataRoot = path.resolve(input.dataRoot);
    this.#custodyRoot = path.join(this.#dataRoot, '.asd', CUSTODY_DIRECTORY);
    this.#privateKeyPath = path.join(this.#custodyRoot, PRIVATE_KEY_FILE);
    this.#registryPath = path.join(this.#custodyRoot, POLICY_REGISTRY_FILE);
    this.#workspaceIdentityHash = hashCanonicalJson({
      kind: 'alembic-main-semantic-review-workspace-v1',
      dataRoot: this.#dataRoot,
    });
  }

  async openCustody(input: {
    readonly evidenceStoreId: string;
    readonly evidenceStoreConfigHash: string;
    readonly reviewerModelLoadReceipt: SemanticDispositionReviewerModelLoadReceiptV1;
    readonly expectedPolicyHash?: string;
  }): Promise<SemanticReviewTrustPreparationV1> {
    await this.#prepareCustodyRoot(true);
    const [registryExists, privateKeyExists] = await Promise.all([
      pathEntryExists(this.#registryPath),
      pathEntryExists(this.#privateKeyPath),
    ]);
    // 只有 key/registry 同时不存在才是首次 bootstrap。已有 key 却丢失公开 enrollment
    // 是持久状态损坏，绝不能借下一次 task 调用重新自授权。
    if (!registryExists && privateKeyExists) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_MISSING');
    }
    if (!registryExists && input.expectedPolicyHash) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_MISSING');
    }
    const registry = await this.#readRegistry();
    const privateKey = await this.#loadOrCreatePrivateKey(registry !== null);
    const policy = createIndependentTrustPolicy({
      evidenceStoreId: input.evidenceStoreId,
      evidenceStoreConfigHash: input.evidenceStoreConfigHash,
      reviewerModelLoadReceipt: input.reviewerModelLoadReceipt,
      privateKey,
      workspaceIdentityHash: this.#workspaceIdentityHash,
    });
    if (input.expectedPolicyHash && input.expectedPolicyHash !== policy.policyHash) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_ROTATION_FORBIDDEN');
    }
    const enrollmentKey = hashCanonicalJson({
      evidenceStoreId: policy.evidenceStoreId,
      evidenceStoreConfigHash: policy.evidenceStoreConfigHash,
      reviewerModelLoadReceiptHash: policy.reviewerModelLoadReceiptHash,
      publicKeyHash: policy.publicKeyHash,
    });
    const existing = registry?.enrollments.find(
      (candidate) => candidate.enrollmentKey === enrollmentKey
    );
    if (existing) {
      assertEnrollment(existing);
      if (
        existing.status !== 'approved' ||
        existing.policy.policyHash !== policy.policyHash ||
        hashCanonicalJson(existing.policy) !== hashCanonicalJson(policy)
      ) {
        throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_NOT_APPROVED');
      }
      return Object.freeze({
        privateKey,
        policy: structuredClone(existing.policy),
        enrollmentHash: existing.enrollmentHash,
      });
    }
    if (input.expectedPolicyHash) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_MISSING');
    }
    const enrollment = createEnrollment(enrollmentKey, policy);
    await this.#writeRegistry({
      schemaVersion: 1,
      enrollments: [...(registry?.enrollments ?? []), enrollment].sort((left, right) =>
        left.enrollmentKey.localeCompare(right.enrollmentKey)
      ),
    });
    const reloaded = await this.#readRegistry();
    const approved = reloaded?.enrollments.find(
      (candidate) => candidate.enrollmentKey === enrollmentKey
    );
    if (!approved) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_READBACK_MISSING');
    }
    assertEnrollment(approved);
    if (
      approved.status !== 'approved' ||
      approved.policy.policyHash !== policy.policyHash ||
      hashCanonicalJson(approved.policy) !== hashCanonicalJson(policy)
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_READBACK_MISMATCH');
    }
    return Object.freeze({
      privateKey,
      policy: structuredClone(approved.policy),
      enrollmentHash: approved.enrollmentHash,
    });
  }

  async readApprovedPolicy(input: {
    readonly policyHash: string;
    readonly enrollmentHash: string;
  }): Promise<SemanticDispositionReviewTrustPolicyV3> {
    await this.#prepareCustodyRoot(false);
    const registry = await this.#readRegistry();
    if (!registry) {
      // finalized recovery 只读取 public enrollment；但如果私钥仍在而 registry 消失，
      // 仍须与新 session 打开时使用同一个“持久状态损坏”诊断，不能降级成未注册。
      const privateKeyExists = await pathEntryExists(this.#privateKeyPath);
      throw new Error(
        privateKeyExists
          ? 'STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_MISSING'
          : 'STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_MISSING'
      );
    }
    const enrollment = registry.enrollments.find(
      (candidate) => candidate.policy.policyHash === input.policyHash
    );
    if (!enrollment) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_MISSING');
    }
    assertEnrollment(enrollment);
    if (enrollment.status !== 'approved' || enrollment.enrollmentHash !== input.enrollmentHash) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_NOT_APPROVED');
    }
    return structuredClone(enrollment.policy);
  }

  async #prepareCustodyRoot(create: boolean): Promise<void> {
    await assertSecureDirectory(this.#dataRoot, false);
    const asdRoot = path.join(this.#dataRoot, '.asd');
    await assertSecureDirectory(asdRoot, create);
    await assertSecureDirectory(this.#custodyRoot, create);

    const [realDataRoot, realCustodyRoot] = await Promise.all([
      fsp.realpath(this.#dataRoot),
      fsp.realpath(this.#custodyRoot),
    ]);
    const expectedCustodyRoot = path.join(realDataRoot, '.asd', CUSTODY_DIRECTORY);
    const relative = path.relative(realDataRoot, realCustodyRoot);
    if (
      realCustodyRoot !== expectedCustodyRoot ||
      relative.startsWith(`..${path.sep}`) ||
      relative === '..' ||
      path.isAbsolute(relative)
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_CUSTODY_PATH_INVALID');
    }
  }

  async #loadOrCreatePrivateKey(registryExists: boolean): Promise<KeyObject> {
    let keyBytes: Buffer;
    try {
      keyBytes = await readRegularFile(this.#privateKeyPath, 0o077);
    } catch (err: unknown) {
      if (readCode(err) !== 'ENOENT') {
        throw err;
      }
      if (registryExists) {
        throw new Error('STRICT_SEMANTIC_REVIEW_SIGNING_KEY_MISSING');
      }
      const { privateKey } = generateKeyPairSync('ed25519');
      const generated = privateKey.export({ format: 'der', type: 'pkcs8' });
      try {
        const handle = await fsp.open(this.#privateKeyPath, 'wx', 0o600);
        try {
          await handle.writeFile(generated);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(this.#custodyRoot);
      } catch (err: unknown) {
        if (readCode(err) !== 'EEXIST') {
          throw err;
        }
      }
      keyBytes = await readRegularFile(this.#privateKeyPath, 0o077);
    }
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: keyBytes, format: 'der', type: 'pkcs8' });
    } catch (err: unknown) {
      throw new Error('STRICT_SEMANTIC_REVIEW_SIGNING_KEY_INVALID', { cause: err });
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('STRICT_SEMANTIC_REVIEW_SIGNING_KEY_TYPE_INVALID');
    }
    return privateKey;
  }

  async #readRegistry(): Promise<SemanticReviewPolicyRegistryV1 | null> {
    let bytes: Buffer;
    try {
      // public policy 可以被读取，但不能允许 group/other 改写已经独立批准的 enrollment。
      bytes = await readRegularFile(this.#registryPath, 0o022);
    } catch (err: unknown) {
      if (readCode(err) === 'ENOENT') {
        return null;
      }
      throw err;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (err: unknown) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_INVALID', { cause: err });
    }
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.enrollments)) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_INVALID');
    }
    const registry = value as unknown as SemanticReviewPolicyRegistryV1;
    const { registryHash, ...semantic } = registry;
    if (
      registryHash !== hashCanonicalJson(semantic) ||
      new Set(registry.enrollments.map((row) => row.enrollmentKey)).size !==
        registry.enrollments.length
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_INVALID');
    }
    for (const enrollment of registry.enrollments) {
      assertEnrollment(enrollment);
    }
    return structuredClone(registry);
  }

  async #writeRegistry(input: Omit<SemanticReviewPolicyRegistryV1, 'registryHash'>): Promise<void> {
    const registry = {
      ...input,
      registryHash: hashCanonicalJson(input),
    } satisfies SemanticReviewPolicyRegistryV1;
    const tempPath = `${this.#registryPath}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fsp.open(tempPath, 'wx', 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(registry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tempPath, this.#registryPath);
    await syncDirectory(this.#custodyRoot);
  }
}

function createIndependentTrustPolicy(input: {
  readonly evidenceStoreId: string;
  readonly evidenceStoreConfigHash: string;
  readonly reviewerModelLoadReceipt: SemanticDispositionReviewerModelLoadReceiptV1;
  readonly privateKey: KeyObject;
  readonly workspaceIdentityHash: string;
}): SemanticDispositionReviewTrustPolicyV3 {
  const publicKeyDer = createPublicKey(input.privateKey).export({
    format: 'der',
    type: 'spki',
  });
  const publicKeyHash = hashBytes(publicKeyDer);
  const semantic = {
    schemaVersion: 3 as const,
    trustRootId: `alembic-main-semantic-review:${input.workspaceIdentityHash.slice(7, 31)}`,
    keyId: `ed25519:${publicKeyHash.slice(7, 31)}`,
    signatureAlgorithm: 'Ed25519' as const,
    publicKeySpkiDerBase64: publicKeyDer.toString('base64'),
    publicKeyHash,
    reviewerModelLoadReceiptHash: input.reviewerModelLoadReceipt.loadReceiptHash,
    evidenceStoreId: input.evidenceStoreId,
    evidenceStoreConfigHash: input.evidenceStoreConfigHash,
  };
  const policy = Object.freeze({
    ...semantic,
    policyHash: hashCanonicalJson(semantic),
  });
  assertSemanticDispositionReviewTrustPolicyV3(policy);
  return policy;
}

function createEnrollment(
  enrollmentKey: string,
  policy: SemanticDispositionReviewTrustPolicyV3
): SemanticReviewPolicyEnrollmentV1 {
  const semantic = {
    schemaVersion: 1 as const,
    status: 'approved' as const,
    enrollmentKey,
    policy,
  };
  return Object.freeze({ ...semantic, enrollmentHash: hashCanonicalJson(semantic) });
}

function assertEnrollment(enrollment: SemanticReviewPolicyEnrollmentV1): void {
  assertSemanticDispositionReviewTrustPolicyV3(enrollment.policy);
  const { enrollmentHash, ...semantic } = enrollment;
  if (
    enrollment.schemaVersion !== 1 ||
    !['approved', 'revoked'].includes(enrollment.status) ||
    enrollment.enrollmentKey !==
      hashCanonicalJson({
        evidenceStoreId: enrollment.policy.evidenceStoreId,
        evidenceStoreConfigHash: enrollment.policy.evidenceStoreConfigHash,
        reviewerModelLoadReceiptHash: enrollment.policy.reviewerModelLoadReceiptHash,
        publicKeyHash: enrollment.policy.publicKeyHash,
      }) ||
    enrollmentHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_INVALID');
  }
}

async function readRegularFile(filePath: string, forbiddenModeMask: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof fsp.open>>;
  try {
    // O_NOFOLLOW 把 leaf 换成 symlink 的竞态也封在读取边界，不依赖前置 lstat。
    handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err: unknown) {
    if (readCode(err) === 'ELOOP') {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_FILE_INVALID', { cause: err });
    }
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & forbiddenModeMask) !== 0) {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_FILE_INVALID');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fsp.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertSecureDirectory(directoryPath: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await fsp.mkdir(directoryPath, { mode: 0o700 });
    } catch (err: unknown) {
      if (readCode(err) !== 'EEXIST') {
        throw err;
      }
    }
  }
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(directoryPath);
  } catch (err: unknown) {
    if (readCode(err) === 'ENOENT') {
      throw new Error('STRICT_SEMANTIC_REVIEW_CUSTODY_PATH_INVALID', { cause: err });
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('STRICT_SEMANTIC_REVIEW_CUSTODY_PATH_INVALID');
  }
}

async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch (err: unknown) {
    if (readCode(err) === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCode(err: unknown): string | null {
  return err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
    ? err.code
    : null;
}
