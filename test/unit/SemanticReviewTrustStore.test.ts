import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SemanticDispositionReviewerModelLoadReceiptV1 } from '@alembic/core/production';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSemanticReviewTrustEnrollmentAuthorization,
  SemanticReviewTrustStore,
} from '../../lib/infrastructure/config/SemanticReviewTrustStore.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { force: true, recursive: true })));
});

describe('SemanticReviewTrustStore', () => {
  it('requires an explicit host enrollment authorization before creating custody', async () => {
    const dataRoot = await createDataRoot(false);
    await fsp.mkdir(path.join(dataRoot, '.asd'), { mode: 0o700 });
    await fsp.writeFile(path.join(dataRoot, '.asd/config.json'), '{"version":2}\n', {
      mode: 0o644,
    });

    await expect(prepare(dataRoot)).rejects.toThrow(
      'STRICT_SEMANTIC_REVIEW_TRUST_AUTHORITY_MISSING'
    );
    await expect(pathExists(custodyRoot(dataRoot))).resolves.toBe(false);
  });

  it('reopens the same Ed25519 custody and independently approved V3 policy', async () => {
    const dataRoot = await createDataRoot();
    const first = await prepare(dataRoot);
    const second = await prepare(dataRoot, first.policy.policyHash);

    expect(second.policy).toEqual(first.policy);
    expect(second.enrollmentHash).toBe(first.enrollmentHash);
    await expect(
      new SemanticReviewTrustStore({ dataRoot }).readApprovedPolicy({
        policyHash: first.policy.policyHash,
        enrollmentHash: first.enrollmentHash,
      })
    ).resolves.toEqual(first.policy);
    expect((await fsp.stat(path.join(custodyRoot(dataRoot), 'signing-key.pk8'))).mode & 0o777).toBe(
      0o600
    );
    expect(
      (await fsp.stat(path.join(custodyRoot(dataRoot), 'approved-policies.json'))).mode & 0o777
    ).toBe(0o644);
  });

  it('fails closed when an enrolled private key is missing or has unsafe permissions', async () => {
    const missingRoot = await createDataRoot();
    await prepare(missingRoot);
    await fsp.rm(path.join(custodyRoot(missingRoot), 'signing-key.pk8'));
    await expect(prepare(missingRoot)).rejects.toThrow(
      'STRICT_SEMANTIC_REVIEW_SIGNING_KEY_MISSING'
    );

    const modeRoot = await createDataRoot();
    await prepare(modeRoot);
    await fsp.chmod(path.join(custodyRoot(modeRoot), 'signing-key.pk8'), 0o644);
    await expect(prepare(modeRoot)).rejects.toThrow('STRICT_SEMANTIC_REVIEW_TRUST_FILE_INVALID');
  });

  it('does not self-authorize a replacement registry when the enrolled registry is missing', async () => {
    const dataRoot = await createDataRoot();
    await prepare(dataRoot);
    const keyPath = path.join(custodyRoot(dataRoot), 'signing-key.pk8');
    const registryPath = path.join(custodyRoot(dataRoot), 'approved-policies.json');
    const enrolledKey = await fsp.readFile(keyPath);
    await fsp.rm(registryPath);

    await expect(prepare(dataRoot)).rejects.toThrow(
      'STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_MISSING'
    );
    await expect(pathExists(registryPath)).resolves.toBe(false);
    await expect(fsp.readFile(keyPath)).resolves.toEqual(enrolledKey);
  });

  it('does not treat complete custody loss as first enrollment', async () => {
    const dataRoot = await createDataRoot();
    await prepare(dataRoot);
    await fsp.rm(custodyRoot(dataRoot), { recursive: true });

    await expect(prepare(dataRoot)).rejects.toThrow('STRICT_SEMANTIC_REVIEW_TRUST_PAIR_MISSING');
    await expect(pathExists(path.join(custodyRoot(dataRoot), 'signing-key.pk8'))).resolves.toBe(
      false
    );
    await expect(
      pathExists(path.join(custodyRoot(dataRoot), 'approved-policies.json'))
    ).resolves.toBe(false);
  });

  it('does not accept a self-consistent replacement pair after enrollment', async () => {
    const enrolledRoot = await createDataRoot();
    const enrolled = await prepare(enrolledRoot);
    const replacementRoot = await createDataRoot();
    await prepare(replacementRoot);
    const replacementKey = await fsp.readFile(
      path.join(custodyRoot(replacementRoot), 'signing-key.pk8')
    );
    const replacementRegistry = await fsp.readFile(
      path.join(custodyRoot(replacementRoot), 'approved-policies.json')
    );
    await fsp.writeFile(path.join(custodyRoot(enrolledRoot), 'signing-key.pk8'), replacementKey, {
      mode: 0o600,
    });
    await fsp.writeFile(
      path.join(custodyRoot(enrolledRoot), 'approved-policies.json'),
      replacementRegistry,
      { mode: 0o644 }
    );

    await expect(prepare(enrolledRoot)).rejects.toThrow(
      'STRICT_SEMANTIC_REVIEW_TRUST_ROOT_REPLACED'
    );
    await expect(
      fsp.readFile(path.join(custodyRoot(enrolledRoot), 'signing-key.pk8'))
    ).resolves.toEqual(replacementKey);
    await expect(
      fsp.readFile(path.join(custodyRoot(enrolledRoot), 'approved-policies.json'))
    ).resolves.toEqual(replacementRegistry);
    await expect(
      new SemanticReviewTrustStore({ dataRoot: enrolledRoot }).readApprovedPolicy({
        policyHash: enrolled.policy.policyHash,
        enrollmentHash: enrolled.enrollmentHash,
      })
    ).rejects.toThrow('STRICT_SEMANTIC_REVIEW_TRUST_ROOT_REPLACED');
  });

  it('does not bootstrap custody from a caller-supplied expected policy hash', async () => {
    const dataRoot = await createDataRoot();

    await expect(prepare(dataRoot, hashCanonicalJson('unapproved-policy'))).rejects.toThrow(
      'STRICT_SEMANTIC_REVIEW_POLICY_ENROLLMENT_MISSING'
    );
    await expect(pathExists(path.join(custodyRoot(dataRoot), 'signing-key.pk8'))).resolves.toBe(
      false
    );
    await expect(
      pathExists(path.join(custodyRoot(dataRoot), 'approved-policies.json'))
    ).resolves.toBe(false);
  });

  it.each([
    'data-root',
    '.asd',
    'semantic-review-trust',
  ] as const)('rejects a group/world-writable %s directory before reading or writing trust artifacts', async (writableComponent) => {
    const dataRoot = await createDataRoot();
    if (writableComponent !== 'data-root') {
      await fsp.mkdir(path.join(dataRoot, '.asd'), { mode: 0o700, recursive: true });
    }
    if (writableComponent === 'semantic-review-trust') {
      await fsp.mkdir(custodyRoot(dataRoot), { mode: 0o700 });
    }
    const writablePath =
      writableComponent === 'data-root'
        ? dataRoot
        : writableComponent === '.asd'
          ? path.join(dataRoot, '.asd')
          : custodyRoot(dataRoot);
    await fsp.chmod(writablePath, 0o777);
    expect((await fsp.stat(writablePath)).mode & 0o022).not.toBe(0);

    await expect(prepare(dataRoot)).rejects.toThrow('STRICT_SEMANTIC_REVIEW_CUSTODY_PATH_INVALID');
    await expect(pathExists(path.join(custodyRoot(dataRoot), 'signing-key.pk8'))).resolves.toBe(
      false
    );
    await expect(
      pathExists(path.join(custodyRoot(dataRoot), 'approved-policies.json'))
    ).resolves.toBe(false);
  });

  it('rejects a group- or other-writable approved policy registry', async () => {
    const dataRoot = await createDataRoot();
    const approved = await prepare(dataRoot);
    const registryPath = path.join(custodyRoot(dataRoot), 'approved-policies.json');
    await fsp.chmod(registryPath, 0o666);

    await expect(prepare(dataRoot, approved.policy.policyHash)).rejects.toThrow(
      'STRICT_SEMANTIC_REVIEW_TRUST_FILE_INVALID'
    );
  });

  it.each([
    'data-root',
    '.asd',
    'semantic-review-trust',
  ] as const)('rejects a symlinked %s custody parent before creating trust artifacts', async (symlinkedComponent) => {
    const outsideRoot = await createDataRoot();
    const dataRoot =
      symlinkedComponent === 'data-root'
        ? path.join(await createDataRoot(), 'configured-data-root')
        : await createDataRoot(symlinkedComponent !== '.asd');
    const outsideCustody =
      symlinkedComponent === 'data-root'
        ? path.join(outsideRoot, '.asd', 'semantic-review-trust')
        : symlinkedComponent === '.asd'
          ? path.join(outsideRoot, 'semantic-review-trust')
          : outsideRoot;
    if (symlinkedComponent === 'data-root') {
      await fsp.symlink(outsideRoot, dataRoot, 'dir');
    } else if (symlinkedComponent === '.asd') {
      await fsp.symlink(outsideRoot, path.join(dataRoot, '.asd'), 'dir');
    } else {
      await fsp.mkdir(path.join(dataRoot, '.asd'), { mode: 0o700, recursive: true });
      await fsp.symlink(outsideRoot, custodyRoot(dataRoot), 'dir');
    }

    await expect(prepare(dataRoot)).rejects.toThrow('STRICT_SEMANTIC_REVIEW_CUSTODY_PATH_INVALID');
    await expect(pathExists(path.join(outsideCustody, 'signing-key.pk8'))).resolves.toBe(false);
    await expect(pathExists(path.join(outsideCustody, 'approved-policies.json'))).resolves.toBe(
      false
    );
  });

  it('rejects policy rotation, registry tampering, and a validly rehashed revocation', async () => {
    const rotationRoot = await createDataRoot();
    await prepare(rotationRoot);
    await expect(prepare(rotationRoot, hashCanonicalJson('different-policy'))).rejects.toThrow(
      'STRICT_SEMANTIC_REVIEW_POLICY_ROTATION_FORBIDDEN'
    );

    const tamperRoot = await createDataRoot();
    await prepare(tamperRoot);
    const tamperPath = path.join(custodyRoot(tamperRoot), 'approved-policies.json');
    const tampered = JSON.parse(await fsp.readFile(tamperPath, 'utf8')) as {
      registryHash: string;
    };
    tampered.registryHash = hashCanonicalJson('tampered-registry');
    await fsp.writeFile(tamperPath, `${JSON.stringify(tampered)}\n`);
    await expect(prepare(tamperRoot)).rejects.toThrow(
      'STRICT_SEMANTIC_REVIEW_POLICY_REGISTRY_INVALID'
    );

    const revokedRoot = await createDataRoot();
    const approved = await prepare(revokedRoot);
    const registryPath = path.join(custodyRoot(revokedRoot), 'approved-policies.json');
    const registry = JSON.parse(await fsp.readFile(registryPath, 'utf8')) as {
      schemaVersion: 1;
      enrollments: Array<Record<string, unknown>>;
      registryHash: string;
    };
    const enrollment = registry.enrollments[0];
    if (!enrollment) {
      throw new Error('fixture enrollment missing');
    }
    enrollment.status = 'revoked';
    const { enrollmentHash: _oldEnrollmentHash, ...enrollmentSemantic } = enrollment;
    enrollment.enrollmentHash = hashCanonicalJson(enrollmentSemantic);
    const registrySemantic = {
      schemaVersion: registry.schemaVersion,
      enrollments: registry.enrollments,
    };
    registry.registryHash = hashCanonicalJson(registrySemantic);
    await fsp.writeFile(registryPath, `${JSON.stringify(registry)}\n`);
    await expect(
      new SemanticReviewTrustStore({ dataRoot: revokedRoot }).readApprovedPolicy({
        policyHash: approved.policy.policyHash,
        enrollmentHash: String(enrollment.enrollmentHash),
      })
    ).rejects.toThrow('STRICT_SEMANTIC_REVIEW_POLICY_NOT_APPROVED');
  });
});

async function createDataRoot(authorizeEnrollment = true): Promise<string> {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'alembic-semantic-trust-'));
  roots.push(dataRoot);
  if (authorizeEnrollment) {
    await fsp.mkdir(path.join(dataRoot, '.asd'), { mode: 0o700 });
    await fsp.writeFile(
      path.join(dataRoot, '.asd/config.json'),
      `${JSON.stringify({
        version: 2,
        semanticReviewTrust: createSemanticReviewTrustEnrollmentAuthorization({ dataRoot }),
      })}\n`,
      { mode: 0o644 }
    );
  }
  return dataRoot;
}

function custodyRoot(dataRoot: string): string {
  return path.join(dataRoot, '.asd', 'semantic-review-trust');
}

function modelLoadReceipt(): SemanticDispositionReviewerModelLoadReceiptV1 {
  const semantic = {
    schemaVersion: 1 as const,
    providerId: 'fixture',
    modelId: 'fixture-reviewer',
    modelVersion: 'fixture-model-v1',
    methodId: 'semantic-disposition-review',
    methodVersion: 'frozen-evidence',
    runtimeConfigHash: hashCanonicalJson('runtime-config'),
    credentialLocationSymbol: 'env:FIXTURE_ONLY',
  };
  return Object.freeze({ ...semantic, loadReceiptHash: hashCanonicalJson(semantic) });
}

function prepare(dataRoot: string, expectedPolicyHash?: string) {
  return new SemanticReviewTrustStore({ dataRoot }).openCustody({
    evidenceStoreId: 'fixture-ledger',
    evidenceStoreConfigHash: hashCanonicalJson('fixture-ledger-config'),
    reviewerModelLoadReceipt: modelLoadReceipt(),
    ...(expectedPolicyHash ? { expectedPolicyHash } : {}),
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
