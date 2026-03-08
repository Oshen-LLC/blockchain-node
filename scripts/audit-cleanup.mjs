import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';

dotenv.config();

const projectRoot = '/Users/abdulkadir/Desktop/blockchain-node';
const apiBaseUrl = (process.env.CLEANUP_API_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4000}`).replace(/\/+$/, '');
const operationsDbPath = process.env.OPERATIONS_DB_PATH || path.join(projectRoot, 'data', 'operations.db');
const outputArgIndex = process.argv.findIndex((arg) => arg === '--out');
const outputPath = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : '';
const applyChanges = process.argv.includes('--apply');
const testPrefixes = ['ZZ-TEST-', 'CERT-VAL-', 'CERT-TEST-', 'CERT-AUTH-', 'CERT-PHASE', 'CERT-CODEX-'];
const testEmailFragments = ['@example.edu', 'validation'];
const validationInstitutionPattern = /validation|codex/i;

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function computeCertificateHash(certificate) {
  const canonicalPayload = JSON.stringify({
    id: certificate.id,
    studentId: certificate.studentId,
    studentName: certificate.studentName,
    degree: certificate.degree,
    university: certificate.university,
    graduationDate: certificate.graduationDate,
  });
  return crypto.createHash('sha256').update(canonicalPayload).digest('hex');
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isPlaceholderHash(value) {
  return value.startsWith('hash_') || !isSha256(value);
}

function isTestCertificateId(id) {
  return testPrefixes.some((prefix) => id.startsWith(prefix));
}

function isValidationInstitution(name) {
  return validationInstitutionPattern.test(name);
}

function isValidationEmail(email) {
  const normalized = email.toLowerCase();
  return testEmailFragments.some((fragment) => normalized.includes(fragment));
}

function makeWhereClause(column, values) {
  if (!values.length) {
    return { clause: '1 = 0', params: [] };
  }
  return {
    clause: `${column} IN (${values.map(() => '?').join(', ')})`,
    params: values,
  };
}

function deleteByIds(db, table, column, values) {
  if (!values.length) return 0;
  const { clause, params } = makeWhereClause(column, values);
  const result = db.prepare(`DELETE FROM ${table} WHERE ${clause}`).run(...params);
  return Number(result.changes || 0);
}

async function login() {
  const email = process.env.CLEANUP_EMAIL || process.env.SUPER_ADMIN_EMAIL || 'superadmin@moe.gov.so';
  const password = process.env.CLEANUP_PASSWORD || process.env.SUPER_ADMIN_PASSWORD || 'Admin123!';
  const role = process.env.CLEANUP_ROLE || 'super_admin';

  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Login failed (${response.status}): ${message}`);
  }

  return await response.json();
}

async function fetchCertificates(token) {
  const response = await fetch(`${apiBaseUrl}/api/certificates`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to fetch certificates (${response.status}): ${message}`);
  }
  return await response.json();
}

function queryRows(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

async function main() {
  const report = {
    checkedAt: new Date().toISOString(),
    apiBaseUrl,
    operationsDbPath,
    applyChanges,
    ledger: {
      unavailable: false,
      totalCertificates: 0,
      placeholderHashes: [],
      hashMismatches: [],
      testCertificates: [],
    },
    offChain: {
      available: false,
      validationInstitutions: [],
      validationUsers: [],
      issuanceEvents: [],
      verificationEvents: [],
      fraudCases: [],
      auditLogs: [],
      deleted: null,
    },
    recommendations: [],
  };

  let certificates = [];
  try {
    const auth = await login();
    certificates = await fetchCertificates(auth.token);
    report.ledger.totalCertificates = certificates.length;
    report.ledger.placeholderHashes = certificates
      .filter((certificate) => isPlaceholderHash(asTrimmedString(certificate.hash || '')))
      .map((certificate) => ({ id: certificate.id, hash: certificate.hash, university: certificate.university }));
    report.ledger.hashMismatches = certificates
      .filter((certificate) => {
        const hash = asTrimmedString(certificate.hash || '');
        return isSha256(hash) && hash !== computeCertificateHash(certificate);
      })
      .map((certificate) => ({
        id: certificate.id,
        storedHash: certificate.hash,
        recomputedHash: computeCertificateHash(certificate),
        university: certificate.university,
      }));
    report.ledger.testCertificates = certificates
      .filter((certificate) => isTestCertificateId(asTrimmedString(certificate.id)))
      .map((certificate) => ({ id: certificate.id, hash: certificate.hash, university: certificate.university }));
  } catch (error) {
    report.ledger.unavailable = true;
    report.recommendations.push(`Bridge/ledger scan unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (existsSync(operationsDbPath)) {
    const db = new DatabaseSync(operationsDbPath);
    report.offChain.available = true;

    const testCertificateIds = [
      ...new Set([
        ...report.ledger.testCertificates.map((certificate) => certificate.id),
        ...report.ledger.placeholderHashes.map((certificate) => certificate.id),
        ...report.ledger.hashMismatches.map((certificate) => certificate.id),
      ]),
    ];

    report.offChain.validationInstitutions = queryRows(
      db,
      `SELECT id, name, code, status, contactEmail FROM institutions WHERE lower(name) LIKE '%validation%' OR lower(name) LIKE '%codex%' OR lower(COALESCE(contactEmail, '')) LIKE '%@example.edu%'`,
    );
    const institutionIds = report.offChain.validationInstitutions.map((institution) => institution.id);

    report.offChain.validationUsers = queryRows(
      db,
      `SELECT id, name, email, role, status, institutionId FROM users WHERE lower(email) LIKE '%@example.edu%' OR lower(name) LIKE '%integration%' OR lower(name) LIKE '%validation%'`,
    );
    const userIds = report.offChain.validationUsers.map((user) => user.id);

    const issueWhere = makeWhereClause('certificateId', testCertificateIds);
    report.offChain.issuanceEvents = issueWhere.params.length
      ? queryRows(db, `SELECT id, certificateId, issuerUserId, institutionId, issuedAt FROM certificate_issuance_events WHERE ${issueWhere.clause}`, ...issueWhere.params)
      : [];
    report.offChain.verificationEvents = issueWhere.params.length
      ? queryRows(db, `SELECT id, certificateId, verifierUserId, result, verifiedAt FROM verification_events WHERE ${issueWhere.clause}`, ...issueWhere.params)
      : [];
    report.offChain.fraudCases = issueWhere.params.length
      ? queryRows(db, `SELECT id, certificateId, status, institutionId, issuerUserId FROM fraud_cases WHERE ${issueWhere.clause}`, ...issueWhere.params)
      : [];

    const auditIds = [...new Set([...testCertificateIds, ...institutionIds, ...userIds])];
    const auditWhere = makeWhereClause('entityId', auditIds);
    report.offChain.auditLogs = auditWhere.params.length
      ? queryRows(db, `SELECT id, action, entityType, entityId, createdAt FROM audit_logs WHERE ${auditWhere.clause}`, ...auditWhere.params)
      : [];

    if (applyChanges) {
      db.exec('BEGIN');
      try {
        const deleted = {
          auditLogs: deleteByIds(db, 'audit_logs', 'id', report.offChain.auditLogs.map((row) => row.id)),
          fraudCases: deleteByIds(db, 'fraud_cases', 'id', report.offChain.fraudCases.map((row) => row.id)),
          verificationEvents: deleteByIds(db, 'verification_events', 'id', report.offChain.verificationEvents.map((row) => row.id)),
          issuanceEvents: deleteByIds(db, 'certificate_issuance_events', 'id', report.offChain.issuanceEvents.map((row) => row.id)),
          users: deleteByIds(db, 'users', 'id', userIds),
          institutions: deleteByIds(db, 'institutions', 'id', institutionIds),
        };
        db.exec('COMMIT');
        report.offChain.deleted = deleted;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  if (report.ledger.placeholderHashes.length > 0) {
    report.recommendations.push('Reissue or revoke ledger certificates with placeholder hashes. Chaincode currently exposes no delete/update path for in-place repair.');
  }
  if (report.ledger.hashMismatches.length > 0) {
    report.recommendations.push('Investigate certificates whose stored ledger hash no longer matches the canonical certificate payload.');
  }
  if (report.ledger.testCertificates.length > 0) {
    report.recommendations.push('Validation/test certificate IDs remain on the ledger. Treat these as non-production data until a formal revocation flow is added.');
  }
  if (report.offChain.available && !applyChanges && (report.offChain.validationInstitutions.length || report.offChain.validationUsers.length || report.offChain.auditLogs.length)) {
    report.recommendations.push('Run `npm run audit:cleanup:apply` to remove off-chain validation data from SQLite after reviewing this report.');
  }

  const json = JSON.stringify(report, null, 2);
  if (outputPath) {
    const absoluteOutputPath = path.isAbsolute(outputPath) ? outputPath : path.join(projectRoot, outputPath);
    await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, json, 'utf8');
  }
  console.log(json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
