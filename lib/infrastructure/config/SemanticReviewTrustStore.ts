import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
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
const HOST_CONFIG_FILE = 'config.json';
const HOST_AUTHORITY_KEY = 'semanticReviewTrust';

export interface SemanticReviewTrustEnrollmentAuthorizationV1 {
  readonly schemaVersion: 1;
  readonly state: 'enrollment-authorized';
  readonly authorizationId: string;
  readonly workspaceIdentityHash: string;
  readonly authorityHash: string;
}

interface SemanticReviewTrustEnrolledAuthorityV1 {
  readonly schemaVersion: 1;
  readonly state: 'enrolled';
  readonly authorizationId: string;
  readonly workspaceIdentityHash: string;
  readonly trustRootId: string;
  readonly publicKeyHash: string;
  readonly authorityHash: string;
}

type SemanticReviewTrustHostAuthorityV1 =
  | SemanticReviewTrustEnrollmentAuthorizationV1
  | SemanticReviewTrustEnrolledAuthorityV1;

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
 * 只能由宿主 setup / 明确的 operator re-enrollment 入口写入的首次登记授权。
 *
 * 普通 production runtime 不会自行创建这个门禁；授权一经消费就会被替换为带
 * public-key pin 的 enrolled authority，pair 全失不能把它恢复成首次安装状态。
 */
export function createSemanticReviewTrustEnrollmentAuthorization(input: {
  readonly dataRoot: string;
}): SemanticReviewTrustEnrollmentAuthorizationV1 {
  const semantic = {
    schemaVersion: 1 as const,
    state: 'enrollment-authorized' as const,
    authorizationId: randomUUID(),
    workspaceIdentityHash: createWorkspaceIdentityHash(input.dataRoot),
  };
  return Object.freeze({ ...semantic, authorityHash: hashCanonicalJson(semantic) });
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
  readonly #runtimeRoot: string;
  readonly #hostConfigPath: string;
  readonly #custodyRoot: string;
  readonly #privateKeyPath: string;
  readonly #registryPath: string;
  readonly #workspaceIdentityHash: string;

  constructor(input: { readonly dataRoot: string }) {
    if (!path.isAbsolute(input.dataRoot)) {
      throw new Error('STRICT_SEMANTIC_REVIEW_DATA_ROOT_INVALID');
    }
    this.#dataRoot = path.resolve(input.dataRoot);
    this.#runtimeRoot = path.join(this.#dataRoot, '.asd');
    this.#hostConfigPath = path.join(this.#runtimeRoot, HOST_CONFIG_FILE);
    this.#custodyRoot = path.join(this.#runtimeRoot, CUSTODY_DIRECTORY);
    this.#privateKeyPath = path.join(this.#custodyRoot, PRIVATE_KEY_FILE);
    this.#registryPath = path.join(this.#custodyRoot, POLICY_REGISTRY_FILE);
    this.#workspaceIdentityHash = createWorkspaceIdentityHash(this.#dataRoot);
  }

  async openCustody(input: {
    readonly evidenceStoreId: string;
    readonly evidenceStoreConfigHash: string;
    readonly reviewerModelLoadReceipt: SemanticDispositionReviewerModelLoadReceiptV1;
    readonly expectedPolicyHash?: string;
  }): Promise<SemanticReviewTrustPreparationV1> {
    const { authority, registryExists } = await this.#openCustodyState(input.expectedPolicyHash);
    const registry = await this.#readRegistry();
    assertRegistryReadState(registryExists, registry);
    const privateKey = await this.#loadOrCreatePrivateKey(registryExists);
    assertAuthorityPrivateKeyIfEnrolled(authority, privateKey);
    const policy = createIndependentTrustPolicy({
      evidenceStoreId: input.evidenceStoreId,
      evidenceStoreConfigHash: input.evidenceStoreConfigHash,
      reviewerModelLoadReceipt: input.reviewerModelLoadReceipt,
      privateKey,
      workspaceIdentityHash: this.#workspaceIdentityHash,
    });
    assertAuthorityPolicyIfEnrolled(authority, policy);
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
    const reused = await this.#reuseApprovedEnrollment({
      authority,
      existing,
      policy,
      privateKey,
    });
    if (reused) {
      return reused;
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
    await this.#commitEnrolledAuthority(authority, approved.policy);
    return Object.freeze({
      privateKey,
      policy: structuredClone(approved.policy),
      enrollmentHash: approved.enrollmentHash,
    });
  }

  async #openCustodyState(expectedPolicyHash?: string): Promise<{
    readonly authority: SemanticReviewTrustHostAuthorityV1;
    readonly registryExists: boolean;
  }> {
    await this.#prepareRuntimeRoot();
    const authority = (await this.#readHostConfig()).authority;
    const custodyExists = await pathEntryExists(this.#custodyRoot);
    if (!custodyExists && (authority.state === 'enrolled' || expectedPolicyHash)) {
      throw new Error(
        authority.state === 'enrolled'
          ? 'STRICT_SEMANTIC_REVIEW_TRUST_PAIR_MISSING'
          : 'STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_MISSING'
      );
    }
    await this.#prepareCustodyRoot(!custodyExists);
    const [registryExists, privateKeyExists] = await Promise.all([
      pathEntryExists(this.#registryPath),
      pathEntryExists(this.#privateKeyPath),
    ]);
    assertTrustPairState({
      authority,
      expectedPolicyHash,
      privateKeyExists,
      registryExists,
    });
    return { authority, registryExists };
  }

  async #reuseApprovedEnrollment(input: {
    readonly authority: SemanticReviewTrustHostAuthorityV1;
    readonly existing: SemanticReviewPolicyEnrollmentV1 | undefined;
    readonly policy: SemanticDispositionReviewTrustPolicyV3;
    readonly privateKey: KeyObject;
  }): Promise<SemanticReviewTrustPreparationV1 | null> {
    if (!input.existing) {
      return null;
    }
    assertEnrollment(input.existing);
    if (
      input.existing.status !== 'approved' ||
      input.existing.policy.policyHash !== input.policy.policyHash ||
      hashCanonicalJson(input.existing.policy) !== hashCanonicalJson(input.policy)
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_NOT_APPROVED');
    }
    await this.#commitEnrolledAuthority(input.authority, input.existing.policy);
    return Object.freeze({
      privateKey: input.privateKey,
      policy: structuredClone(input.existing.policy),
      enrollmentHash: input.existing.enrollmentHash,
    });
  }

  async readApprovedPolicy(input: {
    readonly policyHash: string;
    readonly enrollmentHash: string;
  }): Promise<SemanticDispositionReviewTrustPolicyV3> {
    await this.#prepareRuntimeRoot();
    const authority = (await this.#readHostConfig()).authority;
    if (authority.state !== 'enrolled') {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_NOT_ENROLLED');
    }
    if (!(await pathEntryExists(this.#custodyRoot))) {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_PAIR_MISSING');
    }
    await this.#prepareCustodyRoot(false);
    const [registryExists, privateKeyExists] = await Promise.all([
      pathEntryExists(this.#registryPath),
      pathEntryExists(this.#privateKeyPath),
    ]);
    if (!registryExists && !privateKeyExists) {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_PAIR_MISSING');
    }
    if (!registryExists) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_MISSING');
    }
    if (!privateKeyExists) {
      throw new Error('STRICT_SEMANTIC_REVIEW_SIGNING_KEY_MISSING');
    }
    const privateKey = await this.#loadOrCreatePrivateKey(true);
    assertAuthorityPrivateKey(authority, privateKey);
    const registry = await this.#readRegistry();
    if (!registry) {
      throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_MISSING');
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
    assertAuthorityPolicy(authority, enrollment.policy);
    return structuredClone(enrollment.policy);
  }

  async #prepareRuntimeRoot(): Promise<void> {
    await assertSecureDirectory(this.#dataRoot, false);
    await assertSecureDirectory(this.#runtimeRoot, false);
    const [realDataRoot, realRuntimeRoot] = await Promise.all([
      fsp.realpath(this.#dataRoot),
      fsp.realpath(this.#runtimeRoot),
    ]);
    if (realRuntimeRoot !== path.join(realDataRoot, '.asd')) {
      throw new Error('STRICT_SEMANTIC_REVIEW_CUSTODY_PATH_INVALID');
    }
  }

  async #prepareCustodyRoot(create: boolean): Promise<void> {
    await this.#prepareRuntimeRoot();
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

  async #readHostConfig(): Promise<{
    readonly document: Record<string, unknown>;
    readonly authority: SemanticReviewTrustHostAuthorityV1;
    readonly fileMode: number;
  }> {
    let bytes: Buffer;
    try {
      // 这是 operator-owned 的 enrollment gate / public-key pin，不能接受其他主体可写。
      bytes = await readRegularFile(this.#hostConfigPath, 0o022);
    } catch (err: unknown) {
      if (readCode(err) === 'ENOENT') {
        throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_MISSING', { cause: err });
      }
      throw err;
    }
    let document: unknown;
    try {
      document = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (err: unknown) {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_INVALID', { cause: err });
    }
    if (!isRecord(document)) {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_INVALID');
    }
    const configStat = await fsp.lstat(this.#hostConfigPath);
    if (configStat.isSymbolicLink() || !configStat.isFile() || (configStat.mode & 0o022) !== 0) {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_INVALID');
    }
    const authority = assertHostAuthority(
      document[HOST_AUTHORITY_KEY],
      this.#workspaceIdentityHash
    );
    return {
      document: structuredClone(document),
      authority,
      fileMode: configStat.mode & 0o777,
    };
  }

  async #commitEnrolledAuthority(
    observedAuthority: SemanticReviewTrustHostAuthorityV1,
    policy: SemanticDispositionReviewTrustPolicyV3
  ): Promise<void> {
    if (observedAuthority.state === 'enrolled') {
      assertAuthorityPolicy(observedAuthority, policy);
      return;
    }
    const current = await this.#readHostConfig();
    if (current.authority.state === 'enrolled') {
      assertAuthorityPolicy(current.authority, policy);
      return;
    }
    if (
      current.authority.authorizationId !== observedAuthority.authorizationId ||
      current.authority.authorityHash !== observedAuthority.authorityHash
    ) {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_CHANGED');
    }
    const semantic = {
      schemaVersion: 1 as const,
      state: 'enrolled' as const,
      authorizationId: current.authority.authorizationId,
      workspaceIdentityHash: this.#workspaceIdentityHash,
      trustRootId: policy.trustRootId,
      publicKeyHash: policy.publicKeyHash,
    };
    const enrolled = Object.freeze({
      ...semantic,
      authorityHash: hashCanonicalJson(semantic),
    }) satisfies SemanticReviewTrustEnrolledAuthorityV1;
    await writeJsonAtomically(
      this.#hostConfigPath,
      { ...current.document, [HOST_AUTHORITY_KEY]: enrolled },
      this.#runtimeRoot,
      true,
      current.fileMode
    );
    const readback = (await this.#readHostConfig()).authority;
    if (readback.state !== 'enrolled') {
      throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_READBACK_MISSING');
    }
    assertAuthorityPolicy(readback, policy);
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
    await writeJsonAtomically(this.#registryPath, registry, this.#custodyRoot, false, 0o644);
  }
}

function createWorkspaceIdentityHash(dataRoot: string): string {
  if (!path.isAbsolute(dataRoot)) {
    throw new Error('STRICT_SEMANTIC_REVIEW_DATA_ROOT_INVALID');
  }
  return hashCanonicalJson({
    kind: 'alembic-main-semantic-review-workspace-v1',
    dataRoot: path.resolve(dataRoot),
  });
}

function assertHostAuthority(
  value: unknown,
  expectedWorkspaceIdentityHash: string
): SemanticReviewTrustHostAuthorityV1 {
  if (!isRecord(value)) {
    throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_MISSING');
  }
  const { authorityHash, ...semantic } = value;
  if (
    value.schemaVersion !== 1 ||
    !['enrollment-authorized', 'enrolled'].includes(String(value.state)) ||
    typeof value.authorizationId !== 'string' ||
    value.authorizationId.length === 0 ||
    value.workspaceIdentityHash !== expectedWorkspaceIdentityHash ||
    typeof authorityHash !== 'string' ||
    authorityHash !== hashCanonicalJson(semantic)
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_INVALID');
  }
  if (value.state === 'enrollment-authorized') {
    return structuredClone(value) as unknown as SemanticReviewTrustEnrollmentAuthorizationV1;
  }
  if (
    typeof value.trustRootId !== 'string' ||
    value.trustRootId.length === 0 ||
    typeof value.publicKeyHash !== 'string' ||
    value.publicKeyHash.length === 0
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_INVALID');
  }
  return structuredClone(value) as unknown as SemanticReviewTrustEnrolledAuthorityV1;
}

function assertTrustPairState(input: {
  readonly authority: SemanticReviewTrustHostAuthorityV1;
  readonly expectedPolicyHash?: string;
  readonly privateKeyExists: boolean;
  readonly registryExists: boolean;
}): void {
  // pair 自身不能证明“从未登记”。只有 setup 写入、且尚未消费的 host authority
  // 才能授权首次生成；enrolled authority 下整对缺失必须在任何 artifact 写入前失败。
  if (!input.registryExists && !input.privateKeyExists && input.authority.state === 'enrolled') {
    throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_PAIR_MISSING');
  }
  if (!input.registryExists && input.privateKeyExists) {
    throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_MISSING');
  }
  if (input.registryExists && !input.privateKeyExists) {
    throw new Error('STRICT_SEMANTIC_REVIEW_SIGNING_KEY_MISSING');
  }
  if (!input.registryExists && !input.privateKeyExists && input.expectedPolicyHash) {
    throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_MISSING');
  }
}

function assertRegistryReadState(
  registryExists: boolean,
  registry: SemanticReviewPolicyRegistryV1 | null
): void {
  if (registryExists && !registry) {
    throw new Error('STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_MISSING');
  }
  if (!registryExists && registry) {
    throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_STATE_CHANGED');
  }
}

function assertAuthorityPrivateKeyIfEnrolled(
  authority: SemanticReviewTrustHostAuthorityV1,
  privateKey: KeyObject
): void {
  if (authority.state === 'enrolled') {
    assertAuthorityPrivateKey(authority, privateKey);
  }
}

function assertAuthorityPolicyIfEnrolled(
  authority: SemanticReviewTrustHostAuthorityV1,
  policy: SemanticDispositionReviewTrustPolicyV3
): void {
  if (authority.state === 'enrolled') {
    assertAuthorityPolicy(authority, policy);
  }
}

function assertAuthorityPrivateKey(
  authority: SemanticReviewTrustEnrolledAuthorityV1,
  privateKey: KeyObject
): void {
  const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (hashBytes(publicKeyDer) !== authority.publicKeyHash) {
    throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_ROOT_REPLACED');
  }
}

function assertAuthorityPolicy(
  authority: SemanticReviewTrustEnrolledAuthorityV1,
  policy: SemanticDispositionReviewTrustPolicyV3
): void {
  if (
    authority.trustRootId !== policy.trustRootId ||
    authority.publicKeyHash !== policy.publicKeyHash
  ) {
    throw new Error('STRICT_SEMANTIC_REVIEW_TRUST_ROOT_REPLACED');
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

async function writeJsonAtomically(
  filePath: string,
  value: unknown,
  directoryPath: string,
  pretty: boolean,
  mode: number
): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  try {
    const handle = await fsp.open(tempPath, 'wx', mode);
    try {
      const serialized = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
      await handle.writeFile(`${serialized}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tempPath, filePath);
    renamed = true;
    await syncDirectory(directoryPath);
  } finally {
    if (!renamed) {
      await fsp.rm(tempPath, { force: true });
    }
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
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022) !== 0) {
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
