import * as grpc from '@grpc/grpc-js';
import { connect, type Contract, type Identity, type Signer, signers } from '@hyperledger/fabric-gateway';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import type { JwtPayload, SignOptions } from 'jsonwebtoken';

dotenv.config();

function normalizePeerEndpoint(value: string): string {
    if (value.startsWith('localhost:')) {
        return `127.0.0.1:${value.slice('localhost:'.length)}`;
    }
    return value;
}

function parseAllowedOrigins(value: string | undefined): string[] {
    return (value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

const strictEnv = (process.env.NODE_ENV?.trim().toLowerCase() || '') === 'production'
    || (process.env.REQUIRE_STRICT_ENV?.trim().toLowerCase() || '') === 'true';
const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGIN);

const app = express();
app.use(express.json());
app.use(cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    exposedHeaders: ['content-disposition', 'content-type'],
}));
app.use((_req, res, next) => {
    res.setHeader('Access-Control-Expose-Headers', 'content-disposition, content-type');
    next();
});

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '127.0.0.1';
const channelName = process.env.CHANNEL_NAME || 'education-channel';
const chaincodeName = process.env.CHAINCODE_NAME || 'certificate-chaincode';
const mspId = process.env.MSP_ID || 'MogadishuUniversityMSP';
const certPath = process.env.CERT_PATH!;
const keyPath = process.env.KEY_PATH!;
const tlsCertPath = process.env.TLS_CERT_PATH!;
const peerEndpoint = normalizePeerEndpoint(process.env.PEER_ENDPOINT || '127.0.0.1:7051');
const peerHostAlias = process.env.PEER_HOST_ALIAS || 'peer0.mogadishu.university.so';
const jwtSecret = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET || 'ndts-dev-secret-change-me';
const jwtIssuer = 'ndts-blockchain-node';
const jwtAudience = 'ndts-web-app';
const gatewayBaseUrl = (process.env.GATEWAY_API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const operationsDbPath = process.env.OPERATIONS_DB_PATH || path.join(process.cwd(), 'data', 'operations.db');
const seedDevData = (process.env.SEED_DEV_DATA?.trim().toLowerCase() || 'true') === 'true';
const reportDefaultDays = Number(process.env.REPORT_DEFAULT_DAYS || 30);
const bridgeLedgerMode = (process.env.BRIDGE_LEDGER_MODE || process.env.LEDGER_MODE || 'fabric').trim().toLowerCase();
const fabricEnabled = bridgeLedgerMode === 'fabric';
const execFileAsync = promisify(execFile);

function requireEnv(name: string, value: string | undefined): string {
    const trimmed = value?.trim();
    if (!trimmed) {
        throw new Error(`${name} is required`);
    }
    return trimmed;
}

async function validateStartupEnvironment(): Promise<void> {
    if (strictEnv) {
        if (!process.env.GATEWAY_API_BASE_URL?.trim()) {
            throw new Error('GATEWAY_API_BASE_URL is required in production');
        }
        if (!process.env.CORS_ORIGIN?.trim()) {
            throw new Error('CORS_ORIGIN is required in production');
        }
        if (!process.env.JWT_SECRET?.trim() && !process.env.AUTH_JWT_SECRET?.trim()) {
            throw new Error('JWT_SECRET or AUTH_JWT_SECRET is required in production');
        }
        if (jwtSecret === 'ndts-dev-secret-change-me') {
            throw new Error('JWT_SECRET must not use the development default in production');
        }
    }

    if (!gatewayBaseUrl) {
        throw new Error('GATEWAY_API_BASE_URL is required');
    }

    if (fabricEnabled) {
        requireEnv('MSP_ID', process.env.MSP_ID || mspId);
        requireEnv('CERT_PATH', process.env.CERT_PATH);
        requireEnv('KEY_PATH', process.env.KEY_PATH);
        requireEnv('TLS_CERT_PATH', process.env.TLS_CERT_PATH);
        requireEnv('PEER_ENDPOINT', process.env.PEER_ENDPOINT || peerEndpoint);
        requireEnv('CHANNEL_NAME', process.env.CHANNEL_NAME || channelName);
        requireEnv('CHAINCODE_NAME', process.env.CHAINCODE_NAME || chaincodeName);
        await Promise.all([
            fs.access(certPath),
            fs.access(keyPath),
            fs.access(tlsCertPath),
        ]);
    }
}

type IssueCertificateInput = {
    id: string;
    studentId: string;
    studentName: string;
    degree: string;
    university: string;
    graduationDate: string;
};

type LedgerCertificate = {
    id: string;
    studentId: string;
    studentName: string;
    degree: string;
    university: string;
    graduationDate: string;
    hash: string;
    isRevoked: boolean;
};

type AppRole =
    | 'student'
    | 'teacher'
    | 'school_admin'
    | 'ministry_admin'
    | 'super_admin'
    | 'certificate_verifier';

type UserStatus = 'active' | 'suspended';
type InstitutionStatus = 'active' | 'suspended';
type VerificationResult = 'valid' | 'invalid' | 'invalid_hash' | 'revoked' | 'not_found' | 'pending_anchor' | 'error';
type FraudCaseStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';
type NetworkHealth = 'healthy' | 'degraded' | 'down' | 'unknown';
type InstitutionType = 'university' | 'college' | 'ministry';
type CourseStatus = 'active' | 'archived';
type EnrollmentStatus = 'active' | 'completed' | 'dropped';

type AuthTokenPayload = JwtPayload & {
    sub: string;
    email: string;
    user_id?: string;
    role: AppRole;
    name: string;
    status: UserStatus;
    institutionId?: string;
    institution_id?: string;
    studentId?: string;
    student_id?: string;
    gatewayToken?: string;
};

type AuthenticatedRequest = Request & {
    user?: AppUser;
    gatewayToken?: string | null;
};

type AppUser = {
    id: string;
    name: string;
    email: string;
    role: AppRole;
    status: UserStatus;
    institutionId: string | null;
    institutionName: string | null;
    studentId: string | null;
    createdAt: string;
    updatedAt: string;
};

type UserRecord = AppUser & {
    passwordHash: string;
};

type Institution = {
    id: string;
    name: string;
    code: string;
    type: InstitutionType;
    status: InstitutionStatus;
    contactEmail: string | null;
    userCount: number;
    certificateCount: number;
    createdAt: string;
    updatedAt: string;
};

type InstitutionSettings = {
    institutionId: string;
    general: {
        schoolName: string;
        schoolCode: string;
        establishedYear: string;
        address: string;
        phone: string;
        email: string;
        website: string;
    };
    academic: {
        semesterSystem: string;
        gradingScale: string;
        minGPA: string;
        maxCredits: string;
        attendanceRequirement: string;
        lateSubmissionPolicy: string;
    };
    certificate: {
        certificateTemplate: string;
        blockchainEnabled: boolean;
        autoVerification: boolean;
        signatureRequired: boolean;
        watermarkEnabled: boolean;
        expiryPeriod: string;
    };
    notifications: {
        emailEnabled: boolean;
        smsEnabled: boolean;
        pushEnabled: boolean;
        certificateIssued: boolean;
        courseEnrollment: boolean;
        gradePosted: boolean;
        systemMaintenance: boolean;
    };
    createdAt: string;
    updatedAt: string;
};

type VerificationEvent = {
    id: string;
    certificateId: string;
    requestedHash: string;
    result: VerificationResult;
    reason: string;
    verifiedAt: string;
    verifierUserId: string;
    verifierName: string | null;
    certificateStudentId: string | null;
    certificateStudentName: string | null;
    certificateInstitution: string | null;
    certificateSnapshot: LedgerCertificate | null;
};

type GatewayPublicVerifyResponse = {
    verified?: boolean;
    result?: string;
    verificationId?: string;
    verificationTimestamp?: string;
    institution?: string;
    status?: string;
    proofReference?: string;
    credential?: {
        credentialId?: string;
        certificateNumber?: string;
        title?: string;
        institutionName?: string;
        awardDate?: string;
        status?: string;
        verificationUrl?: string;
        hash?: string;
        versionNo?: number;
        proofReference?: string;
        qrToken?: string | null;
    } | null;
};

type GatewayAuthUserResponse = {
    id?: string;
    institutionId?: string | null;
    email?: string;
    fullName?: string;
    role?: string;
    status?: string;
};

type GatewayInstitutionSummary = {
    id?: string;
    name?: string;
    code?: string;
};

type FraudCase = {
    id: string;
    verificationEventId: string | null;
    certificateId: string;
    certificateHash: string | null;
    status: FraudCaseStatus;
    reason: string;
    notes: string;
    resolution: string;
    reporterUserId: string;
    reporterName: string | null;
    assigneeUserId: string | null;
    assigneeName: string | null;
    issuerUserId: string | null;
    issuerName: string | null;
    institutionId: string | null;
    institutionName: string | null;
    createdAt: string;
    updatedAt: string;
};

type AuditLog = {
    id: string;
    actorUserId: string | null;
    actorName: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
    createdAt: string;
};

type CertificateIssuanceEvent = {
    id: string;
    certificateId: string;
    hash: string;
    studentId: string;
    issuerUserId: string;
    issuerName: string | null;
    institutionId: string | null;
    institutionName: string | null;
    courseId: string | null;
    courseTitle: string | null;
    enrollmentId: string | null;
    issuedAt: string;
};

type TeacherCourse = {
    id: string;
    title: string;
    description: string;
    duration: string;
    totalLessons: number;
    status: CourseStatus;
    teacherUserId: string;
    teacherName: string | null;
    institutionId: string;
    institutionName: string | null;
    createdAt: string;
    updatedAt: string;
    enrolledStudents: number;
    activeStudents: number;
    completedStudents: number;
    averageProgress: number;
    certificatesIssued: number;
};

type TeacherEnrollment = {
    id: string;
    courseId: string;
    courseTitle: string;
    courseStatus: CourseStatus;
    studentUserId: string;
    studentId: string;
    studentName: string;
    studentEmail: string;
    progressPercent: number;
    completedLessons: number;
    totalLessons: number;
    finalGrade: string | null;
    status: EnrollmentStatus;
    certificateIssued: boolean;
    certificateId: string | null;
    reviewCredentialId: string | null;
    reviewSubmittedAt: string | null;
    institutionId: string | null;
    institutionName: string | null;
    createdAt: string;
    updatedAt: string;
};

type TeacherStudent = {
    studentUserId: string;
    studentId: string;
    name: string;
    email: string;
    institutionId: string | null;
    institutionName: string | null;
    assignedCourses: number;
    activeCourses: number;
    completedCourses: number;
    averageProgress: number;
    certificatesIssued: number;
    lastUpdated: string;
};

type TeacherCertificateQueueItem = {
    enrollmentId: string;
    courseId: string;
    courseTitle: string;
    studentUserId: string;
    studentId: string;
    studentName: string;
    studentEmail: string;
    progressPercent: number;
    completedLessons: number;
    totalLessons: number;
    finalGrade: string | null;
    institutionName: string | null;
    updatedAt: string;
    reviewCredentialId: string | null;
    reviewSubmittedAt: string | null;
};

type TeacherIssuedCertificate = {
    issuanceId: string;
    enrollmentId: string | null;
    courseId: string | null;
    courseTitle: string;
    certificateId: string;
    hash: string;
    studentId: string;
    studentName: string;
    studentEmail: string;
    graduationDate: string;
    issuedAt: string;
    university: string;
    status: string;
    verificationCount: number;
    latestVerificationAt: string | null;
    verificationUrl: string | null;
    proofReference: string | null;
    versionNo: number | null;
    qrToken: string | null;
};

type TeacherDashboardSummary = {
    totals: {
        students: number;
        activeCourses: number;
        completedEnrollments: number;
        eligibleCertificates: number;
        issuedCertificates: number;
        averageProgress: number;
    };
    recentStudents: TeacherStudent[];
    pendingCertificates: TeacherCertificateQueueItem[];
    courses: TeacherCourse[];
};

type TeacherAnalyticsSummary = {
    totals: {
        students: number;
        averageProgress: number;
        certificatesIssued: number;
        activeCourses: number;
    };
    monthlyActivity: Array<{
        month: string;
        issued: number;
        verified: number;
    }>;
    coursePerformance: Array<{
        courseId: string;
        courseTitle: string;
        students: number;
        avgProgress: number;
        completionRate: number;
        avgGrade: string;
    }>;
};

type NetworkServiceStatus = {
    id: string;
    name: string;
    kind: string;
    image: string;
    ports: string;
    isRunning: boolean;
    status: NetworkHealth;
    statusText: string;
};

type NetworkStatusPayload = {
    overallStatus: NetworkHealth;
    checkedAt: string;
    services: NetworkServiceStatus[];
    alerts: string[];
};

type MinistryDashboardSummary = {
    totals: {
        institutions: number;
        activeInstitutions: number;
        suspendedInstitutions: number;
        users: number;
        certificates: number;
        verificationToday: number;
        openFraudCases: number;
    };
    alerts: string[];
    recentAudits: AuditLog[];
    institutions: Institution[];
    networkStatus: NetworkHealth;
};

type VerifierDashboardSummary = {
    totals: {
        certificates: number;
        verificationsToday: number;
        validToday: number;
        invalidToday: number;
        openFraudCases: number;
    };
    recentVerifications: VerificationEvent[];
    suspiciousCases: FraudCase[];
    networkStatus: NetworkHealth;
};

type ReportSummary = {
    from: string;
    to: string;
    issuance: number;
    verifications: number;
    fraudCases: number;
    institutions: number;
    users: number;
    audits: number;
};

type ReportType = 'issuance' | 'verifications' | 'fraud-cases' | 'institutions' | 'users' | 'audits';
type ReportFormat = 'csv' | 'pdf';

type ReportDataset = {
    title: string;
    subtitle: string;
    headers: string[];
    rows: string[][];
};

const ROLE_SET = new Set<AppRole>([
    'student',
    'teacher',
    'school_admin',
    'ministry_admin',
    'super_admin',
    'certificate_verifier',
]);

const ISSUER_ROLES: AppRole[] = ['school_admin', 'super_admin'];
const ADMIN_ROLES: AppRole[] = ['super_admin'];
const FRAUD_MANAGER_ROLES: AppRole[] = ['certificate_verifier', 'super_admin'];
const SCHOOL_MANAGER_ROLES: AppRole[] = ['school_admin', 'super_admin'];
const REQUIRED_ISSUE_FIELDS: Array<keyof IssueCertificateInput> = [
    'id',
    'studentId',
    'studentName',
    'degree',
    'university',
    'graduationDate',
];
const VALID_USER_STATUSES: UserStatus[] = ['active', 'suspended'];
const VALID_INSTITUTION_STATUSES: InstitutionStatus[] = ['active', 'suspended'];
const VALID_FRAUD_STATUSES: FraudCaseStatus[] = ['open', 'investigating', 'resolved', 'dismissed'];
const VALID_COURSE_STATUSES: CourseStatus[] = ['active', 'archived'];
const VALID_ENROLLMENT_STATUSES: EnrollmentStatus[] = ['active', 'completed', 'dropped'];
const VALID_REPORT_TYPES: ReportType[] = ['issuance', 'verifications', 'fraud-cases', 'institutions', 'users', 'audits'];
const VALID_REPORT_FORMATS: ReportFormat[] = ['csv', 'pdf'];
const TODAY_PREFIX = new Date().toISOString().slice(0, 10);

function asTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function asOptionalTrimmedString(value: unknown): string | null {
    const normalized = asTrimmedString(value);
    return normalized || null;
}

function asBoolean(value: unknown): boolean {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function asInteger(value: unknown, fallback = 0): number {
    const numeric = asNumber(value);
    if (numeric == null) return fallback;
    return Math.trunc(numeric);
}

function clampInteger(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

function asArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => asTrimmedString(item)).filter(Boolean);
}

function normalizeRole(value: unknown): AppRole | null {
    const normalized = asTrimmedString(value).toLowerCase();
    if (normalized === 'institute_admin') return 'school_admin';
    if (normalized === 'verifier') return 'certificate_verifier';
    if (normalized === 'ministry_super_admin') return 'super_admin';
    return ROLE_SET.has(normalized as AppRole) ? (normalized as AppRole) : null;
}

function normalizeUserStatus(value: unknown): UserStatus | null {
    const normalized = asTrimmedString(value).toLowerCase() as UserStatus;
    return VALID_USER_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeInstitutionStatus(value: unknown): InstitutionStatus | null {
    const normalized = asTrimmedString(value).toLowerCase() as InstitutionStatus;
    return VALID_INSTITUTION_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeFraudStatus(value: unknown): FraudCaseStatus | null {
    const normalized = asTrimmedString(value).toLowerCase() as FraudCaseStatus;
    return VALID_FRAUD_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeCourseStatus(value: unknown): CourseStatus | null {
    const normalized = asTrimmedString(value).toLowerCase() as CourseStatus;
    return VALID_COURSE_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeEnrollmentStatus(value: unknown): EnrollmentStatus | null {
    const normalized = asTrimmedString(value).toLowerCase() as EnrollmentStatus;
    return VALID_ENROLLMENT_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeInstitutionType(value: unknown): InstitutionType {
    const normalized = asTrimmedString(value).toLowerCase();
    if (normalized === 'college') return 'college';
    if (normalized === 'ministry') return 'ministry';
    return 'university';
}

function normalizeReportType(value: unknown): ReportType {
    const normalized = asTrimmedString(value).toLowerCase() as ReportType;
    return VALID_REPORT_TYPES.includes(normalized) ? normalized : 'verifications';
}

function normalizeReportFormat(value: unknown): ReportFormat {
    const normalized = asTrimmedString(value).toLowerCase() as ReportFormat;
    return VALID_REPORT_FORMATS.includes(normalized) ? normalized : 'csv';
}

function nowIso(): string {
    return new Date().toISOString();
}

function createId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 32) || crypto.randomBytes(3).toString('hex');
}

function buildInstitutionCode(name: string): string {
    const compact = name
        .toUpperCase()
        .replace(/[^A-Z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
        .map((part) => part[0])
        .join('');
    return compact || crypto.randomBytes(2).toString('hex').toUpperCase();
}

function normalizeIssueInput(body: unknown): IssueCertificateInput {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
        id: asTrimmedString(record.id),
        studentId: asTrimmedString(record.studentId),
        studentName: asTrimmedString(record.studentName),
        degree: asTrimmedString(record.degree),
        university: asTrimmedString(record.university),
        graduationDate: asTrimmedString(record.graduationDate),
    };
}

function getMissingIssueFields(data: IssueCertificateInput): Array<keyof IssueCertificateInput> {
    return REQUIRED_ISSUE_FIELDS.filter((field) => !data[field]);
}

function computeCertificateHash(data: IssueCertificateInput): string {
    const canonicalPayload = JSON.stringify({
        id: data.id,
        studentId: data.studentId,
        studentName: data.studentName,
        degree: data.degree,
        university: data.university,
        graduationDate: data.graduationDate,
    });
    return crypto.createHash('sha256').update(canonicalPayload).digest('hex');
}

function extractErrorMessage(error: unknown): string {
    if (error == null) return 'Unknown error';

    const parts = new Set<string>();
    const pushPart = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) {
            parts.add(value.trim());
        }
    };

    if (error instanceof Error) {
        pushPart(error.message);
    }

    if (typeof error === 'object') {
        const err = error as Record<string, unknown>;
        const details = err.details;
        if (typeof details === 'string') {
            pushPart(details);
        } else if (Array.isArray(details)) {
            for (const detail of details) {
                if (typeof detail === 'string') {
                    pushPart(detail);
                } else if (detail && typeof detail === 'object') {
                    const detailRecord = detail as Record<string, unknown>;
                    pushPart(detailRecord.message);
                    pushPart(detailRecord.details);
                    pushPart(detailRecord.error);
                }
            }
        }

        const cause = err.cause;
        if (cause && typeof cause === 'object') {
            const causeRecord = cause as Record<string, unknown>;
            pushPart(causeRecord.message);
            pushPart(causeRecord.details);
            pushPart(causeRecord.error);
        } else {
            pushPart(cause);
        }
    }

    if (parts.size > 0) return Array.from(parts).join(' | ');
    return String(error);
}

function mapFabricErrorStatus(message: string): number {
    const normalized = message.toLowerCase();
    if (normalized.includes('already exists')) return 409;
    if (normalized.includes('does not exist') || normalized.includes('not found')) return 404;
    if (
        normalized.includes('unavailable') ||
        normalized.includes('deadline') ||
        normalized.includes('connect') ||
        normalized.includes('connection') ||
        normalized.includes('econnrefused') ||
        normalized.includes('failed to connect')
    ) {
        return 503;
    }
    return 500;
}

function mapRow<T>(row: unknown): T | null {
    return row ? (row as T) : null;
}

function isNotFoundMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('does not exist') || normalized.includes('not found');
}

function isConnectionError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
        normalized.includes('unavailable') ||
        normalized.includes('failed to connect') ||
        normalized.includes('connection') ||
        normalized.includes('econnrefused') ||
        normalized.includes('deadline')
    );
}

function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
    const [salt, hashed] = storedHash.split(':');
    if (!salt || !hashed) return false;
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hashed, 'hex'));
}

function parseJsonObject(value: string | null): Record<string, unknown> {
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

function parseCertificateSnapshot(value: string | null): LedgerCertificate | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as LedgerCertificate;
    } catch {
        return null;
    }
}

function serializeJson(value: unknown): string {
    return JSON.stringify(value ?? {});
}

function sanitizeUser(record: UserRecord): AppUser {
    const { passwordHash: _passwordHash, ...user } = record;
    return user;
}

function buildAuthPayload(decoded: JwtPayload): AuthTokenPayload | null {
    const role = normalizeRole((decoded as Record<string, unknown>).role);
    const sub = asTrimmedString(decoded.sub);
    const email = asTrimmedString((decoded as Record<string, unknown>).email);
    const name = asTrimmedString((decoded as Record<string, unknown>).name);
    const status = normalizeUserStatus((decoded as Record<string, unknown>).status);
    if (!role || !sub || !email || !name || !status) return null;

    const payload: AuthTokenPayload = {
        ...decoded,
        sub,
        email,
        role,
        name,
        status,
    };

    const institutionId =
        asOptionalTrimmedString((decoded as Record<string, unknown>).institutionId) ??
        asOptionalTrimmedString((decoded as Record<string, unknown>).institution_id);
    const studentId =
        asOptionalTrimmedString((decoded as Record<string, unknown>).studentId) ??
        asOptionalTrimmedString((decoded as Record<string, unknown>).student_id);
    const gatewayToken = asOptionalTrimmedString((decoded as Record<string, unknown>).gatewayToken);
    if (institutionId) payload.institutionId = institutionId;
    if (studentId) payload.studentId = studentId;
    if (institutionId) payload.institution_id = institutionId;
    if (studentId) payload.student_id = studentId;
    if (gatewayToken) payload.gatewayToken = gatewayToken;
    return payload;
}

function requireRoles(...allowedRoles: AppRole[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        const requester = (req as AuthenticatedRequest).user;
        if (!requester) {
            res.status(401).json({ error: 'Authentication required.' });
            return;
        }
        if (!allowedRoles.includes(requester.role)) {
            res.status(403).json({ error: 'Access denied for this role.' });
            return;
        }
        next();
    };
}

function canManageRole(requester: AppUser, targetRole: AppRole): boolean {
    if (requester.role === 'super_admin') return true;
    if (requester.role === 'school_admin') {
        return targetRole === 'teacher' || targetRole === 'student' || targetRole === 'certificate_verifier';
    }
    return false;
}

function clampText(value: string, max = 200): string {
    return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatDisplayDate(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) return value;
    return parsed.toISOString().replace('T', ' ').slice(0, 16);
}

async function ensureDatabaseReady(dbPath: string): Promise<DatabaseSync> {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS institutions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            code TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            contactEmail TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS institution_settings (
            institutionId TEXT PRIMARY KEY,
            general TEXT NOT NULL,
            academic TEXT NOT NULL,
            certificate TEXT NOT NULL,
            notifications TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (institutionId) REFERENCES institutions(id)
        );
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            passwordHash TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            institutionId TEXT,
            studentId TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (institutionId) REFERENCES institutions(id)
        );
        CREATE TABLE IF NOT EXISTS verification_events (
            id TEXT PRIMARY KEY,
            certificateId TEXT NOT NULL,
            requestedHash TEXT NOT NULL,
            result TEXT NOT NULL,
            reason TEXT NOT NULL,
            verifierUserId TEXT NOT NULL,
            certificateStudentId TEXT,
            certificateStudentName TEXT,
            certificateInstitution TEXT,
            certificateSnapshot TEXT,
            verifiedAt TEXT NOT NULL,
            FOREIGN KEY (verifierUserId) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS fraud_cases (
            id TEXT PRIMARY KEY,
            verificationEventId TEXT,
            certificateId TEXT NOT NULL,
            certificateHash TEXT,
            status TEXT NOT NULL,
            reason TEXT NOT NULL,
            notes TEXT NOT NULL,
            resolution TEXT NOT NULL,
            reporterUserId TEXT NOT NULL,
            assigneeUserId TEXT,
            issuerUserId TEXT,
            institutionId TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (verificationEventId) REFERENCES verification_events(id),
            FOREIGN KEY (reporterUserId) REFERENCES users(id),
            FOREIGN KEY (assigneeUserId) REFERENCES users(id),
            FOREIGN KEY (issuerUserId) REFERENCES users(id),
            FOREIGN KEY (institutionId) REFERENCES institutions(id)
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            actorUserId TEXT,
            action TEXT NOT NULL,
            entityType TEXT NOT NULL,
            entityId TEXT NOT NULL,
            details TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (actorUserId) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS certificate_issuance_events (
            id TEXT PRIMARY KEY,
            certificateId TEXT NOT NULL UNIQUE,
            hash TEXT NOT NULL,
            studentId TEXT NOT NULL,
            issuerUserId TEXT NOT NULL,
            institutionId TEXT,
            issuedAt TEXT NOT NULL,
            FOREIGN KEY (issuerUserId) REFERENCES users(id),
            FOREIGN KEY (institutionId) REFERENCES institutions(id)
        );
        CREATE TABLE IF NOT EXISTS courses (
            id TEXT PRIMARY KEY,
            teacherUserId TEXT NOT NULL,
            institutionId TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            duration TEXT NOT NULL,
            totalLessons INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            FOREIGN KEY (teacherUserId) REFERENCES users(id),
            FOREIGN KEY (institutionId) REFERENCES institutions(id)
        );
        CREATE TABLE IF NOT EXISTS course_enrollments (
            id TEXT PRIMARY KEY,
            courseId TEXT NOT NULL,
            studentUserId TEXT NOT NULL,
            progressPercent INTEGER NOT NULL DEFAULT 0,
            completedLessons INTEGER NOT NULL DEFAULT 0,
            totalLessons INTEGER NOT NULL DEFAULT 0,
            finalGrade TEXT,
            status TEXT NOT NULL,
            certificateIssued INTEGER NOT NULL DEFAULT 0,
            certificateId TEXT,
            reviewCredentialId TEXT,
            reviewSubmittedAt TEXT,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL,
            UNIQUE (courseId, studentUserId),
            FOREIGN KEY (courseId) REFERENCES courses(id),
            FOREIGN KEY (studentUserId) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
        CREATE INDEX IF NOT EXISTS idx_users_institution ON users(institutionId);
        CREATE INDEX IF NOT EXISTS idx_verifications_certificate ON verification_events(certificateId);
        CREATE INDEX IF NOT EXISTS idx_verifications_result ON verification_events(result);
        CREATE INDEX IF NOT EXISTS idx_fraud_status ON fraud_cases(status);
        CREATE INDEX IF NOT EXISTS idx_audit_createdAt ON audit_logs(createdAt);
        CREATE INDEX IF NOT EXISTS idx_courses_teacher ON courses(teacherUserId);
        CREATE INDEX IF NOT EXISTS idx_courses_institution ON courses(institutionId);
        CREATE INDEX IF NOT EXISTS idx_enrollments_course ON course_enrollments(courseId);
        CREATE INDEX IF NOT EXISTS idx_enrollments_student ON course_enrollments(studentUserId);
        CREATE INDEX IF NOT EXISTS idx_enrollments_status ON course_enrollments(status);
    `);
    ensureTableColumn(db, 'certificate_issuance_events', 'courseId', 'TEXT');
    ensureTableColumn(db, 'certificate_issuance_events', 'enrollmentId', 'TEXT');
    ensureTableColumn(db, 'course_enrollments', 'reviewCredentialId', 'TEXT');
    ensureTableColumn(db, 'course_enrollments', 'reviewSubmittedAt', 'TEXT');
    return db;
}

function ensureTableColumn(db: DatabaseSync, tableName: string, columnName: string, definition: string): void {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    const exists = rows.some((row) => row.name === columnName);
    if (!exists) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
}

function getInstitutionRecordById(db: DatabaseSync, id: string): Institution | null {
    const row = mapRow<Institution>(db.prepare(`
        SELECT
            i.id,
            i.name,
            i.code,
            i.type,
            i.status,
            i.contactEmail,
            i.createdAt,
            i.updatedAt,
            COALESCE((SELECT COUNT(*) FROM users u WHERE u.institutionId = i.id), 0) AS userCount,
            COALESCE((SELECT COUNT(*) FROM certificate_issuance_events c WHERE c.institutionId = i.id), 0) AS certificateCount
        FROM institutions i
        WHERE i.id = ?
    `).get(id));
    return row;
}

function getInstitutionRecordByName(db: DatabaseSync, name: string): Institution | null {
    const row = mapRow<Institution>(db.prepare(`
        SELECT
            i.id,
            i.name,
            i.code,
            i.type,
            i.status,
            i.contactEmail,
            i.createdAt,
            i.updatedAt,
            COALESCE((SELECT COUNT(*) FROM users u WHERE u.institutionId = i.id), 0) AS userCount,
            COALESCE((SELECT COUNT(*) FROM certificate_issuance_events c WHERE c.institutionId = i.id), 0) AS certificateCount
        FROM institutions i
        WHERE lower(i.name) = lower(?) OR lower(i.code) = lower(?)
        LIMIT 1
    `).get(name, name));
    return row;
}

function listInstitutions(db: DatabaseSync, options?: { includeSystem?: boolean; search?: string; status?: InstitutionStatus | null }): Institution[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];

    if (!options?.includeSystem) {
        conditions.push(`i.type != 'ministry'`);
    }
    if (options?.search) {
        conditions.push('(lower(i.name) LIKE ? OR lower(i.code) LIKE ?)');
        const needle = `%${options.search.toLowerCase()}%`;
        params.push(needle, needle);
    }
    if (options?.status) {
        conditions.push('i.status = ?');
        params.push(options.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const statement = db.prepare(`
        SELECT
            i.id,
            i.name,
            i.code,
            i.type,
            i.status,
            i.contactEmail,
            i.createdAt,
            i.updatedAt,
            COALESCE((SELECT COUNT(*) FROM users u WHERE u.institutionId = i.id), 0) AS userCount,
            COALESCE((SELECT COUNT(*) FROM certificate_issuance_events c WHERE c.institutionId = i.id), 0) AS certificateCount
        FROM institutions i
        ${whereClause}
        ORDER BY i.name COLLATE NOCASE ASC
    `);
    return statement.all(...params) as Institution[];
}

function getUserRecordById(db: DatabaseSync, id: string): UserRecord | null {
    const row = mapRow<UserRecord>(db.prepare(`
        SELECT
            u.id,
            u.name,
            u.email,
            u.passwordHash,
            u.role,
            u.status,
            u.institutionId,
            i.name AS institutionName,
            u.studentId,
            u.createdAt,
            u.updatedAt
        FROM users u
        LEFT JOIN institutions i ON i.id = u.institutionId
        WHERE u.id = ?
        LIMIT 1
    `).get(id));
    return row;
}

function getUserRecordByEmail(db: DatabaseSync, email: string): UserRecord | null {
    const row = mapRow<UserRecord>(db.prepare(`
        SELECT
            u.id,
            u.name,
            u.email,
            u.passwordHash,
            u.role,
            u.status,
            u.institutionId,
            i.name AS institutionName,
            u.studentId,
            u.createdAt,
            u.updatedAt
        FROM users u
        LEFT JOIN institutions i ON i.id = u.institutionId
        WHERE lower(u.email) = lower(?)
        LIMIT 1
    `).get(email));
    return row;
}

function listUsers(db: DatabaseSync, filters?: { role?: AppRole | null; institutionId?: string | null; status?: UserStatus | null; search?: string }): AppUser[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];

    if (filters?.role) {
        conditions.push('u.role = ?');
        params.push(filters.role);
    }
    if (filters?.institutionId) {
        conditions.push('u.institutionId = ?');
        params.push(filters.institutionId);
    }
    if (filters?.status) {
        conditions.push('u.status = ?');
        params.push(filters.status);
    }
    if (filters?.search) {
        conditions.push("(lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(COALESCE(u.studentId, '')) LIKE ?)");
        const needle = `%${filters.search.toLowerCase()}%`;
        params.push(needle, needle, needle);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const statement = db.prepare(`
        SELECT
            u.id,
            u.name,
            u.email,
            u.passwordHash,
            u.role,
            u.status,
            u.institutionId,
            i.name AS institutionName,
            u.studentId,
            u.createdAt,
            u.updatedAt
        FROM users u
        LEFT JOIN institutions i ON i.id = u.institutionId
        ${whereClause}
        ORDER BY u.createdAt DESC
    `);

    return (statement.all(...params) as UserRecord[]).map(sanitizeUser);
}

function insertAuditLog(db: DatabaseSync, input: {
    actorUserId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
}): void {
    db.prepare(`
        INSERT INTO audit_logs (id, actorUserId, action, entityType, entityId, details, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        createId('audit'),
        input.actorUserId,
        input.action,
        input.entityType,
        input.entityId,
        serializeJson(input.details ?? {}),
        nowIso(),
    );
}

function createInstitution(db: DatabaseSync, input: {
    name: string;
    code?: string | null;
    type?: InstitutionType;
    status?: InstitutionStatus;
    contactEmail?: string | null;
}): Institution {
    const timestamp = nowIso();
    const institution = {
        id: createId('inst'),
        name: input.name,
        code: asTrimmedString(input.code) || buildInstitutionCode(input.name),
        type: input.type ?? 'university',
        status: input.status ?? 'active',
        contactEmail: input.contactEmail ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
    };

    db.prepare(`
        INSERT INTO institutions (id, name, code, type, status, contactEmail, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        institution.id,
        institution.name,
        institution.code,
        institution.type,
        institution.status,
        institution.contactEmail,
        institution.createdAt,
        institution.updatedAt,
    );

    return getInstitutionRecordById(db, institution.id)!;
}

function buildDefaultInstitutionSettings(institution: Institution): InstitutionSettings {
    const timestamp = nowIso();
    return {
        institutionId: institution.id,
        general: {
            schoolName: institution.name,
            schoolCode: institution.code,
            establishedYear: '',
            address: '',
            phone: '',
            email: institution.contactEmail || '',
            website: '',
        },
        academic: {
            semesterSystem: 'semester',
            gradingScale: '4.0',
            minGPA: '2.0',
            maxCredits: '18',
            attendanceRequirement: '75',
            lateSubmissionPolicy: 'strict',
        },
        certificate: {
            certificateTemplate: 'modern',
            blockchainEnabled: true,
            autoVerification: true,
            signatureRequired: true,
            watermarkEnabled: true,
            expiryPeriod: 'lifetime',
        },
        notifications: {
            emailEnabled: true,
            smsEnabled: false,
            pushEnabled: true,
            certificateIssued: true,
            courseEnrollment: true,
            gradePosted: true,
            systemMaintenance: true,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

function parseInstitutionSettingsSection(value: string | null): Record<string, unknown> {
    return parseJsonObject(value);
}

function normalizeInstitutionSettings(institution: Institution, input: unknown, current?: InstitutionSettings | null): InstitutionSettings {
    const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const defaults = current ?? buildDefaultInstitutionSettings(institution);
    const general = (record.general && typeof record.general === 'object' ? record.general : {}) as Record<string, unknown>;
    const academic = (record.academic && typeof record.academic === 'object' ? record.academic : {}) as Record<string, unknown>;
    const certificate = (record.certificate && typeof record.certificate === 'object' ? record.certificate : {}) as Record<string, unknown>;
    const notifications = (record.notifications && typeof record.notifications === 'object' ? record.notifications : {}) as Record<string, unknown>;

    return {
        institutionId: institution.id,
        general: {
            schoolName: asTrimmedString(general.schoolName) || defaults.general.schoolName,
            schoolCode: asTrimmedString(general.schoolCode) || defaults.general.schoolCode,
            establishedYear: asTrimmedString(general.establishedYear) || defaults.general.establishedYear,
            address: asTrimmedString(general.address) || defaults.general.address,
            phone: asTrimmedString(general.phone) || defaults.general.phone,
            email: asTrimmedString(general.email) || defaults.general.email,
            website: asTrimmedString(general.website) || defaults.general.website,
        },
        academic: {
            semesterSystem: asTrimmedString(academic.semesterSystem) || defaults.academic.semesterSystem,
            gradingScale: asTrimmedString(academic.gradingScale) || defaults.academic.gradingScale,
            minGPA: asTrimmedString(academic.minGPA) || defaults.academic.minGPA,
            maxCredits: asTrimmedString(academic.maxCredits) || defaults.academic.maxCredits,
            attendanceRequirement: asTrimmedString(academic.attendanceRequirement) || defaults.academic.attendanceRequirement,
            lateSubmissionPolicy: asTrimmedString(academic.lateSubmissionPolicy) || defaults.academic.lateSubmissionPolicy,
        },
        certificate: {
            certificateTemplate: asTrimmedString(certificate.certificateTemplate) || defaults.certificate.certificateTemplate,
            blockchainEnabled: certificate.blockchainEnabled == null ? defaults.certificate.blockchainEnabled : asBoolean(certificate.blockchainEnabled),
            autoVerification: certificate.autoVerification == null ? defaults.certificate.autoVerification : asBoolean(certificate.autoVerification),
            signatureRequired: certificate.signatureRequired == null ? defaults.certificate.signatureRequired : asBoolean(certificate.signatureRequired),
            watermarkEnabled: certificate.watermarkEnabled == null ? defaults.certificate.watermarkEnabled : asBoolean(certificate.watermarkEnabled),
            expiryPeriod: asTrimmedString(certificate.expiryPeriod) || defaults.certificate.expiryPeriod,
        },
        notifications: {
            emailEnabled: notifications.emailEnabled == null ? defaults.notifications.emailEnabled : asBoolean(notifications.emailEnabled),
            smsEnabled: notifications.smsEnabled == null ? defaults.notifications.smsEnabled : asBoolean(notifications.smsEnabled),
            pushEnabled: notifications.pushEnabled == null ? defaults.notifications.pushEnabled : asBoolean(notifications.pushEnabled),
            certificateIssued: notifications.certificateIssued == null ? defaults.notifications.certificateIssued : asBoolean(notifications.certificateIssued),
            courseEnrollment: notifications.courseEnrollment == null ? defaults.notifications.courseEnrollment : asBoolean(notifications.courseEnrollment),
            gradePosted: notifications.gradePosted == null ? defaults.notifications.gradePosted : asBoolean(notifications.gradePosted),
            systemMaintenance: notifications.systemMaintenance == null ? defaults.notifications.systemMaintenance : asBoolean(notifications.systemMaintenance),
        },
        createdAt: current?.createdAt || defaults.createdAt,
        updatedAt: nowIso(),
    };
}

function getInstitutionSettings(db: DatabaseSync, institutionId: string): InstitutionSettings | null {
    const institution = getInstitutionRecordById(db, institutionId);
    if (!institution) return null;
    const row = mapRow<Record<string, unknown>>(db.prepare(`
        SELECT institutionId, general, academic, certificate, notifications, createdAt, updatedAt
        FROM institution_settings
        WHERE institutionId = ?
        LIMIT 1
    `).get(institutionId));
    if (!row) {
        return buildDefaultInstitutionSettings(institution);
    }

    const defaults = buildDefaultInstitutionSettings(institution);
    const merged = normalizeInstitutionSettings(institution, {
        general: {
            ...defaults.general,
            ...parseInstitutionSettingsSection(asOptionalTrimmedString(row.general)),
            schoolName: institution.name,
            schoolCode: institution.code,
            email: institution.contactEmail || defaults.general.email,
        },
        academic: {
            ...defaults.academic,
            ...parseInstitutionSettingsSection(asOptionalTrimmedString(row.academic)),
        },
        certificate: {
            ...defaults.certificate,
            ...parseInstitutionSettingsSection(asOptionalTrimmedString(row.certificate)),
        },
        notifications: {
            ...defaults.notifications,
            ...parseInstitutionSettingsSection(asOptionalTrimmedString(row.notifications)),
        },
    }, {
        ...defaults,
        createdAt: asTrimmedString(row.createdAt) || defaults.createdAt,
        updatedAt: asTrimmedString(row.updatedAt) || defaults.updatedAt,
    });
    merged.createdAt = asTrimmedString(row.createdAt) || defaults.createdAt;
    merged.updatedAt = asTrimmedString(row.updatedAt) || defaults.updatedAt;
    return merged;
}

function upsertInstitutionSettings(db: DatabaseSync, institutionId: string, settings: InstitutionSettings): InstitutionSettings {
    db.prepare(`
        INSERT INTO institution_settings (institutionId, general, academic, certificate, notifications, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(institutionId) DO UPDATE SET
            general = excluded.general,
            academic = excluded.academic,
            certificate = excluded.certificate,
            notifications = excluded.notifications,
            updatedAt = excluded.updatedAt
    `).run(
        institutionId,
        serializeJson(settings.general),
        serializeJson(settings.academic),
        serializeJson(settings.certificate),
        serializeJson(settings.notifications),
        settings.createdAt,
        settings.updatedAt,
    );
    return getInstitutionSettings(db, institutionId)!;
}

function ensureInstitution(db: DatabaseSync, input: {
    name: string;
    code?: string;
    type?: InstitutionType;
    status?: InstitutionStatus;
    contactEmail?: string | null;
}): Institution {
    const existing = getInstitutionRecordByName(db, input.code || input.name) || getInstitutionRecordByName(db, input.name);
    if (existing) return existing;
    return createInstitution(db, input);
}

function createUser(db: DatabaseSync, input: {
    name: string;
    email: string;
    password: string;
    role: AppRole;
    status?: UserStatus;
    institutionId?: string | null;
    studentId?: string | null;
}): AppUser {
    const timestamp = nowIso();
    const id = createId('user');
    const passwordHash = hashPassword(input.password);

    db.prepare(`
        INSERT INTO users (id, name, email, passwordHash, role, status, institutionId, studentId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        input.name,
        input.email,
        passwordHash,
        input.role,
        input.status ?? 'active',
        input.institutionId ?? null,
        input.studentId ?? null,
        timestamp,
        timestamp,
    );

    return sanitizeUser(getUserRecordById(db, id)!);
}

function ensureUser(db: DatabaseSync, input: {
    name: string;
    email: string;
    password: string;
    role: AppRole;
    institutionId?: string | null;
    studentId?: string | null;
}): AppUser {
    const existing = getUserRecordByEmail(db, input.email);
    if (existing) return sanitizeUser(existing);
    return createUser(db, input);
}

function createCourseRecord(db: DatabaseSync, input: {
    teacherUserId: string;
    institutionId: string;
    title: string;
    description?: string;
    duration?: string;
    totalLessons?: number;
    status?: CourseStatus;
}): TeacherCourse {
    const timestamp = nowIso();
    const id = createId('course');
    db.prepare(`
        INSERT INTO courses (id, teacherUserId, institutionId, title, description, duration, totalLessons, status, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        input.teacherUserId,
        input.institutionId,
        input.title,
        input.description ?? '',
        input.duration ?? '',
        Math.max(0, input.totalLessons ?? 0),
        input.status ?? 'active',
        timestamp,
        timestamp,
    );
    return getCourseById(db, id)!;
}

function findCourseForTeacherByTitle(db: DatabaseSync, teacherUserId: string, title: string): TeacherCourse | null {
    const row = mapRow<{ id?: string }>(db.prepare(`
        SELECT id
        FROM courses
        WHERE teacherUserId = ? AND lower(title) = lower(?)
        LIMIT 1
    `).get(teacherUserId, title));
    if (!row?.id) return null;
    return getCourseById(db, String(row.id));
}

function ensureCourseRecord(db: DatabaseSync, input: {
    teacherUserId: string;
    institutionId: string;
    title: string;
    description?: string;
    duration?: string;
    totalLessons?: number;
    status?: CourseStatus;
}): TeacherCourse {
    const existing = findCourseForTeacherByTitle(db, input.teacherUserId, input.title);
    if (existing) return existing;
    return createCourseRecord(db, input);
}

function createEnrollmentRecord(db: DatabaseSync, input: {
    courseId: string;
    studentUserId: string;
    progressPercent?: number;
    completedLessons?: number;
    totalLessons?: number;
    finalGrade?: string | null;
    status?: EnrollmentStatus;
    certificateIssued?: boolean;
    certificateId?: string | null;
    reviewCredentialId?: string | null;
    reviewSubmittedAt?: string | null;
}): TeacherEnrollment {
    const timestamp = nowIso();
    const id = createId('enroll');
    db.prepare(`
        INSERT INTO course_enrollments (
            id, courseId, studentUserId, progressPercent, completedLessons, totalLessons, finalGrade, status, certificateIssued, certificateId, reviewCredentialId, reviewSubmittedAt, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        input.courseId,
        input.studentUserId,
        clampInteger(input.progressPercent ?? 0, 0, 100),
        Math.max(0, input.completedLessons ?? 0),
        Math.max(0, input.totalLessons ?? 0),
        input.finalGrade ?? null,
        input.status ?? 'active',
        input.certificateIssued ? 1 : 0,
        input.certificateId ?? null,
        input.reviewCredentialId ?? null,
        input.reviewSubmittedAt ?? null,
        timestamp,
        timestamp,
    );
    return getEnrollmentById(db, id)!;
}

function findEnrollmentRecord(db: DatabaseSync, courseId: string, studentUserId: string): TeacherEnrollment | null {
    const row = mapRow<{ id?: string }>(db.prepare(`
        SELECT id
        FROM course_enrollments
        WHERE courseId = ? AND studentUserId = ?
        LIMIT 1
    `).get(courseId, studentUserId));
    if (!row?.id) return null;
    return getEnrollmentById(db, String(row.id));
}

function ensureEnrollmentRecord(db: DatabaseSync, input: {
    courseId: string;
    studentUserId: string;
    progressPercent?: number;
    completedLessons?: number;
    totalLessons?: number;
    finalGrade?: string | null;
    status?: EnrollmentStatus;
    certificateIssued?: boolean;
    certificateId?: string | null;
    reviewCredentialId?: string | null;
    reviewSubmittedAt?: string | null;
}): TeacherEnrollment {
    const existing = findEnrollmentRecord(db, input.courseId, input.studentUserId);
    if (existing) return existing;
    return createEnrollmentRecord(db, input);
}

async function seedOperationalData(db: DatabaseSync): Promise<void> {
    const ministry = ensureInstitution(db, {
        name: 'Ministry of Education',
        code: 'MOE',
        type: 'ministry',
        status: 'active',
        contactEmail: 'ministry@moe.gov.so',
    });
    const mogadishu = ensureInstitution(db, {
        name: 'Mogadishu University',
        code: 'MU',
        type: 'university',
        status: 'active',
        contactEmail: 'admin@mogadishu.edu.so',
    });
    const hargeisa = ensureInstitution(db, {
        name: 'Hargeisa University',
        code: 'HU',
        type: 'university',
        status: 'active',
        contactEmail: 'admin@hargeisa.edu.so',
    });

    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL?.trim() || 'superadmin@moe.gov.so';
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD?.trim() || 'Admin123!';
    const superAdminName = process.env.SUPER_ADMIN_NAME?.trim() || 'System Super Admin';

    ensureUser(db, {
        name: superAdminName,
        email: superAdminEmail,
        password: superAdminPassword,
        role: 'super_admin',
        institutionId: ministry.id,
    });

    if (!seedDevData) {
        return;
    }

    const ministryAdmin = ensureUser(db, {
        name: 'Mohamed Hassan',
        email: 'ministry@moe.gov.so',
        password: 'Ministry123!',
        role: 'ministry_admin',
        institutionId: ministry.id,
    });
    const verifier = ensureUser(db, {
        name: 'Amina Said',
        email: 'verifier@moe.gov.so',
        password: 'Verifier123!',
        role: 'certificate_verifier',
        institutionId: ministry.id,
    });
    const mogadishuAdmin = ensureUser(db, {
        name: 'Asha Abdullahi',
        email: 'admin@mogadishu.edu.so',
        password: 'School123!',
        role: 'school_admin',
        institutionId: mogadishu.id,
    });
    const mogadishuTeacher = ensureUser(db, {
        name: 'Ahmed Ali',
        email: 'teacher@mogadishu.edu.so',
        password: 'Teacher123!',
        role: 'teacher',
        institutionId: mogadishu.id,
    });
    const mogadishuStudentOne = ensureUser(db, {
        name: 'Hodan Yusuf',
        email: 'student104@mogadishu.edu.so',
        password: 'Student123!',
        role: 'student',
        institutionId: mogadishu.id,
        studentId: 'STU-104',
    });
    const hargeisaTeacher = ensureUser(db, {
        name: 'Abdi Noor',
        email: 'teacher@hargeisa.edu.so',
        password: 'Teacher123!',
        role: 'teacher',
        institutionId: hargeisa.id,
    });
    const mogadishuStudentTwo = ensureUser(db, {
        name: 'Amina Hassan',
        email: 'student105@mogadishu.edu.so',
        password: 'Student123!',
        role: 'student',
        institutionId: mogadishu.id,
        studentId: 'STU-105',
    });
    const mogadishuStudentThree = ensureUser(db, {
        name: 'Yusuf Ibrahim',
        email: 'student106@mogadishu.edu.so',
        password: 'Student123!',
        role: 'student',
        institutionId: mogadishu.id,
        studentId: 'STU-106',
    });
    const mogadishuStudentFour = ensureUser(db, {
        name: 'Fatima Abdi',
        email: 'student107@mogadishu.edu.so',
        password: 'Student123!',
        role: 'student',
        institutionId: mogadishu.id,
        studentId: 'STU-107',
    });
    const hargeisaStudent = ensureUser(db, {
        name: 'Khadar Farah',
        email: 'student201@hargeisa.edu.so',
        password: 'Student123!',
        role: 'student',
        institutionId: hargeisa.id,
        studentId: 'STU-201',
    });

    const webCourse = ensureCourseRecord(db, {
        teacherUserId: mogadishuTeacher.id,
        institutionId: mogadishu.id,
        title: 'Web Development Basics',
        description: 'HTML, CSS, JavaScript, and responsive interfaces.',
        duration: '8 weeks',
        totalLessons: 16,
    });
    const databaseCourse = ensureCourseRecord(db, {
        teacherUserId: mogadishuTeacher.id,
        institutionId: mogadishu.id,
        title: 'Database Management',
        description: 'Relational modeling, SQL, and transaction processing.',
        duration: '6 weeks',
        totalLessons: 12,
    });
    const analyticsCourse = ensureCourseRecord(db, {
        teacherUserId: mogadishuTeacher.id,
        institutionId: mogadishu.id,
        title: 'Learning Analytics',
        description: 'Practical academic analytics with reporting and dashboards.',
        duration: '10 weeks',
        totalLessons: 20,
    });
    const networkCourse = ensureCourseRecord(db, {
        teacherUserId: hargeisaTeacher.id,
        institutionId: hargeisa.id,
        title: 'Network Security',
        description: 'Secure network design and incident response fundamentals.',
        duration: '7 weeks',
        totalLessons: 14,
    });

    ensureEnrollmentRecord(db, {
        courseId: webCourse.id,
        studentUserId: mogadishuStudentOne.id,
        progressPercent: 100,
        completedLessons: 16,
        totalLessons: 16,
        finalGrade: 'A',
        status: 'completed',
    });
    ensureEnrollmentRecord(db, {
        courseId: webCourse.id,
        studentUserId: mogadishuStudentTwo.id,
        progressPercent: 88,
        completedLessons: 14,
        totalLessons: 16,
        finalGrade: null,
        status: 'active',
    });
    ensureEnrollmentRecord(db, {
        courseId: databaseCourse.id,
        studentUserId: mogadishuStudentThree.id,
        progressPercent: 100,
        completedLessons: 12,
        totalLessons: 12,
        finalGrade: 'B+',
        status: 'completed',
    });
    ensureEnrollmentRecord(db, {
        courseId: databaseCourse.id,
        studentUserId: mogadishuStudentFour.id,
        progressPercent: 54,
        completedLessons: 6,
        totalLessons: 12,
        finalGrade: null,
        status: 'active',
    });
    ensureEnrollmentRecord(db, {
        courseId: analyticsCourse.id,
        studentUserId: mogadishuStudentTwo.id,
        progressPercent: 72,
        completedLessons: 14,
        totalLessons: 20,
        finalGrade: null,
        status: 'active',
    });
    ensureEnrollmentRecord(db, {
        courseId: networkCourse.id,
        studentUserId: hargeisaStudent.id,
        progressPercent: 43,
        completedLessons: 6,
        totalLessons: 14,
        finalGrade: null,
        status: 'active',
    });

    void ministryAdmin;
    void verifier;
    void mogadishuAdmin;
}

function buildUserToken(user: AppUser, gatewayToken?: string | null): string {
    const tokenPayload: Record<string, string> = {
        sub: user.id,
        user_id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
        status: user.status,
    };
    if (user.institutionId) {
        tokenPayload.institutionId = user.institutionId;
        tokenPayload.institution_id = user.institutionId;
    }
    if (user.studentId) {
        tokenPayload.studentId = user.studentId;
        tokenPayload.student_id = user.studentId;
    }
    if (gatewayToken) tokenPayload.gatewayToken = gatewayToken;

    const signOptions: jwt.SignOptions = {
        issuer: jwtIssuer,
        audience: jwtAudience,
    };
    signOptions.expiresIn = (process.env.AUTH_JWT_EXPIRES_IN?.trim() || '12h') as NonNullable<SignOptions['expiresIn']>;
    return jwt.sign(tokenPayload, jwtSecret, signOptions);
}

function authenticate(db: DatabaseSync) {
    return (req: Request, res: Response, next: NextFunction) => {
        const authHeader = req.header('authorization') || '';
        if (!authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or invalid Authorization header.' });
            return;
        }

        const token = authHeader.slice(7).trim();
        if (!token) {
            res.status(401).json({ error: 'Missing bearer token.' });
            return;
        }

        try {
            const decoded = jwt.verify(token, jwtSecret, {
                issuer: jwtIssuer,
                audience: jwtAudience,
            });
            if (typeof decoded === 'string') {
                res.status(401).json({ error: 'Invalid token payload.' });
                return;
            }

            const payload = buildAuthPayload(decoded);
            if (!payload) {
                res.status(401).json({ error: 'Invalid token claims.' });
                return;
            }

            const userRecord = getUserRecordById(db, payload.sub);
            if (!userRecord) {
                res.status(401).json({ error: 'User account not found.' });
                return;
            }
            if (userRecord.status !== 'active') {
                res.status(403).json({ error: 'User account is suspended.' });
                return;
            }
            if (userRecord.institutionId) {
                const institution = getInstitutionRecordById(db, userRecord.institutionId);
                if (institution && institution.status !== 'active' && ISSUER_ROLES.includes(userRecord.role)) {
                    res.status(403).json({ error: 'Institution account is suspended.' });
                    return;
                }
            }

            (req as AuthenticatedRequest).user = sanitizeUser(userRecord);
            (req as AuthenticatedRequest).gatewayToken = payload.gatewayToken ?? null;
            next();
        } catch (_error) {
            res.status(401).json({ error: 'Invalid or expired token.' });
        }
    };
}

async function loginToGateway(input: { email: string; password: string }): Promise<string | null> {
    try {
        const response = await fetch(`${gatewayBaseUrl}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as { token?: string };
        return typeof payload.token === 'string' && payload.token.trim() ? payload.token.trim() : null;
    } catch {
        return null;
    }
}

async function gatewayJsonRequest(req: AuthenticatedRequest, pathName: string, init?: RequestInit): Promise<globalThis.Response> {
    const headers = new Headers(init?.headers || {});
    headers.set('accept', 'application/json');
    if (!headers.has('content-type') && init?.body) {
        headers.set('content-type', 'application/json');
    }
    if (req.gatewayToken) {
        headers.set('authorization', `Bearer ${req.gatewayToken}`);
    }
    return fetch(`${gatewayBaseUrl}${pathName}`, {
        ...init,
        headers,
    });
}

async function gatewayProxyRequest(pathName: string, init?: RequestInit): Promise<globalThis.Response> {
    const headers = new Headers(init?.headers || {});
    if (!headers.has('accept')) {
        headers.set('accept', 'application/json');
    }
    return fetch(`${gatewayBaseUrl}${pathName}`, {
        ...init,
        headers,
    });
}

async function resolveGatewayInstitutionId(db: DatabaseSync, req: AuthenticatedRequest, localInstitutionId: string): Promise<string> {
    const trimmedLocalId = localInstitutionId.trim();
    if (!trimmedLocalId || !req.gatewayToken) {
        return trimmedLocalId;
    }

    try {
        const meResponse = await gatewayJsonRequest(req, '/api/v1/me');
        if (meResponse.ok) {
            const me = await meResponse.json() as GatewayAuthUserResponse;
            const actorInstitutionId = asOptionalTrimmedString(me.institutionId);
            if (actorInstitutionId && req.user?.role === 'school_admin') {
                return actorInstitutionId;
            }
        }
    } catch {
        // fall back to institution list mapping
    }

    const localInstitution = getInstitutionRecordById(db, trimmedLocalId);
    if (!localInstitution) {
        return trimmedLocalId;
    }

    try {
        const response = await gatewayJsonRequest(req, '/api/v1/institutions');
        if (!response.ok) {
            return trimmedLocalId;
        }
        const payload = await response.json() as { items?: GatewayInstitutionSummary[] } | GatewayInstitutionSummary[];
        const items = Array.isArray(payload) ? payload : payload.items || [];
        const match = items.find((item) => {
            const itemId = asOptionalTrimmedString(item.id);
            const itemName = asOptionalTrimmedString(item.name);
            const itemCode = asOptionalTrimmedString(item.code);
            return itemId === trimmedLocalId
                || (itemName && itemName.toLowerCase() === localInstitution.name.toLowerCase())
                || (itemCode && itemCode.toLowerCase() === localInstitution.code.toLowerCase());
        });
        if (match?.id) {
            return match.id;
        }
        if (req.user?.role === 'school_admin' && items.length === 1 && items[0]?.id) {
            return String(items[0].id);
        }
    } catch {
        return trimmedLocalId;
    }

    return trimmedLocalId;
}

async function getGatewayCredentialById(req: AuthenticatedRequest, credentialId: string): Promise<Record<string, unknown> | null> {
    const trimmedId = credentialId.trim();
    if (!trimmedId || !req.gatewayToken) {
        return null;
    }

    try {
        const response = await gatewayJsonRequest(req, `/api/v1/credentials/${encodeURIComponent(trimmedId)}`);
        if (!response.ok) {
            return null;
        }
        return await response.json() as Record<string, unknown>;
    } catch {
        return null;
    }
}

async function readRawRequestBody(req: Request): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

async function maybeGatewayHealth(): Promise<boolean> {
    try {
        const response = await fetch(`${gatewayBaseUrl}/api/v1/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(4000),
        });
        return response.ok;
    } catch {
        return false;
    }
}

function mapGatewayVerificationResult(value: unknown): VerificationResult {
    const normalized = asTrimmedString(value).toLowerCase();
    switch (normalized) {
        case 'valid':
            return 'valid';
        case 'invalid_hash':
            return 'invalid_hash';
        case 'revoked':
            return 'revoked';
        case 'not_found':
            return 'not_found';
        case 'pending_anchor':
            return 'pending_anchor';
        case 'invalid':
            return 'invalid';
        default:
            return 'error';
    }
}

function safeLedgerCertificateFromGateway(payload: GatewayPublicVerifyResponse): LedgerCertificate | null {
    if (!payload.credential) return null;
    return {
        id: asTrimmedString(payload.credential.credentialId) || asTrimmedString(payload.credential.certificateNumber),
        studentId: '',
        studentName: '',
        degree: asTrimmedString(payload.credential.title),
        university: asTrimmedString(payload.credential.institutionName) || asTrimmedString(payload.institution),
        graduationDate: asTrimmedString(payload.credential.awardDate),
        hash: asTrimmedString(payload.credential.hash),
        isRevoked: mapGatewayVerificationResult(payload.result) === 'revoked',
    };
}

async function getAllCertificatesFromLedger(contract: Contract): Promise<LedgerCertificate[]> {
    const resultBytes = await contract.evaluateTransaction('GetAllCertificates');
    const resultJson = Buffer.from(resultBytes).toString();
    const parsed = JSON.parse(resultJson);
    return Array.isArray(parsed) ? (parsed as LedgerCertificate[]) : [];
}

function filterCertificatesForRequester(certificates: LedgerCertificate[], requester: AppUser): LedgerCertificate[] {
    if (requester.role === 'student') {
        return certificates.filter((certificate) => certificate.studentId === requester.studentId);
    }
    if ((requester.role === 'teacher' || requester.role === 'school_admin') && requester.institutionName) {
        return certificates.filter((certificate) => certificate.university === requester.institutionName);
    }
    return certificates;
}

function insertVerificationEvent(db: DatabaseSync, input: {
    certificateId: string;
    requestedHash: string;
    result: VerificationResult;
    reason: string;
    verifierUserId: string;
    certificate?: LedgerCertificate | null;
}): VerificationEvent {
    const id = createId('verify');
    const timestamp = nowIso();
    db.prepare(`
        INSERT INTO verification_events (
            id, certificateId, requestedHash, result, reason, verifierUserId,
            certificateStudentId, certificateStudentName, certificateInstitution, certificateSnapshot, verifiedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        input.certificateId,
        input.requestedHash,
        input.result,
        input.reason,
        input.verifierUserId,
        input.certificate?.studentId ?? null,
        input.certificate?.studentName ?? null,
        input.certificate?.university ?? null,
        input.certificate ? serializeJson(input.certificate) : null,
        timestamp,
    );
    return getVerificationEventById(db, id)!;
}

function getVerificationEventById(db: DatabaseSync, id: string): VerificationEvent | null {
    const row = mapRow<Record<string, unknown>>(db.prepare(`
        SELECT
            v.id,
            v.certificateId,
            v.requestedHash,
            v.result,
            v.reason,
            v.verifiedAt,
            v.verifierUserId,
            u.name AS verifierName,
            v.certificateStudentId,
            v.certificateStudentName,
            v.certificateInstitution,
            v.certificateSnapshot
        FROM verification_events v
        LEFT JOIN users u ON u.id = v.verifierUserId
        WHERE v.id = ?
        LIMIT 1
    `).get(id));
    if (!row) return null;
    return {
        id: String(row.id),
        certificateId: String(row.certificateId),
        requestedHash: String(row.requestedHash),
        result: String(row.result) as VerificationResult,
        reason: String(row.reason),
        verifiedAt: String(row.verifiedAt),
        verifierUserId: String(row.verifierUserId),
        verifierName: asOptionalTrimmedString(row.verifierName),
        certificateStudentId: asOptionalTrimmedString(row.certificateStudentId),
        certificateStudentName: asOptionalTrimmedString(row.certificateStudentName),
        certificateInstitution: asOptionalTrimmedString(row.certificateInstitution),
        certificateSnapshot: parseCertificateSnapshot(asOptionalTrimmedString(row.certificateSnapshot)),
    };
}

function listVerificationEvents(db: DatabaseSync, filters?: { result?: VerificationResult | null; search?: string; limit?: number }): VerificationEvent[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];

    if (filters?.result) {
        conditions.push('v.result = ?');
        params.push(filters.result);
    }
    if (filters?.search) {
        conditions.push("(lower(v.certificateId) LIKE ? OR lower(COALESCE(v.certificateStudentName, '')) LIKE ? OR lower(COALESCE(v.certificateInstitution, '')) LIKE ?)");
        const needle = `%${filters.search.toLowerCase()}%`;
        params.push(needle, needle, needle);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters?.limit ? `LIMIT ${Math.max(1, Math.min(filters.limit, 200))}` : 'LIMIT 200';
    const rows = db.prepare(`
        SELECT
            v.id,
            v.certificateId,
            v.requestedHash,
            v.result,
            v.reason,
            v.verifiedAt,
            v.verifierUserId,
            u.name AS verifierName,
            v.certificateStudentId,
            v.certificateStudentName,
            v.certificateInstitution,
            v.certificateSnapshot
        FROM verification_events v
        LEFT JOIN users u ON u.id = v.verifierUserId
        ${whereClause}
        ORDER BY v.verifiedAt DESC
        ${limitClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => ({
        id: String(row.id),
        certificateId: String(row.certificateId),
        requestedHash: String(row.requestedHash),
        result: String(row.result) as VerificationResult,
        reason: String(row.reason),
        verifiedAt: String(row.verifiedAt),
        verifierUserId: String(row.verifierUserId),
        verifierName: asOptionalTrimmedString(row.verifierName),
        certificateStudentId: asOptionalTrimmedString(row.certificateStudentId),
        certificateStudentName: asOptionalTrimmedString(row.certificateStudentName),
        certificateInstitution: asOptionalTrimmedString(row.certificateInstitution),
        certificateSnapshot: parseCertificateSnapshot(asOptionalTrimmedString(row.certificateSnapshot)),
    }));
}

function getIssuanceEventByCertificateId(db: DatabaseSync, certificateId: string): CertificateIssuanceEvent | null {
    const row = mapRow<Record<string, unknown>>(db.prepare(`
        SELECT
            e.id,
            e.certificateId,
            e.hash,
            e.studentId,
            e.issuerUserId,
            u.name AS issuerName,
            e.institutionId,
            i.name AS institutionName,
            e.courseId,
            c.title AS courseTitle,
            e.enrollmentId,
            e.issuedAt
        FROM certificate_issuance_events e
        LEFT JOIN users u ON u.id = e.issuerUserId
        LEFT JOIN institutions i ON i.id = e.institutionId
        LEFT JOIN courses c ON c.id = e.courseId
        WHERE e.certificateId = ?
        LIMIT 1
    `).get(certificateId));
    if (!row) return null;
    return {
        id: String(row.id),
        certificateId: String(row.certificateId),
        hash: String(row.hash),
        studentId: String(row.studentId),
        issuerUserId: String(row.issuerUserId),
        issuerName: asOptionalTrimmedString(row.issuerName),
        institutionId: asOptionalTrimmedString(row.institutionId),
        institutionName: asOptionalTrimmedString(row.institutionName),
        courseId: asOptionalTrimmedString(row.courseId),
        courseTitle: asOptionalTrimmedString(row.courseTitle),
        enrollmentId: asOptionalTrimmedString(row.enrollmentId),
        issuedAt: String(row.issuedAt),
    };
}

function insertIssuanceEvent(db: DatabaseSync, input: {
    certificateId: string;
    hash: string;
    studentId: string;
    issuerUserId: string;
    institutionId: string | null;
    courseId?: string | null;
    enrollmentId?: string | null;
}): CertificateIssuanceEvent {
    const id = createId('issue');
    db.prepare(`
        INSERT INTO certificate_issuance_events (id, certificateId, hash, studentId, issuerUserId, institutionId, courseId, enrollmentId, issuedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        input.certificateId,
        input.hash,
        input.studentId,
        input.issuerUserId,
        input.institutionId,
        input.courseId ?? null,
        input.enrollmentId ?? null,
        nowIso(),
    );
    return getIssuanceEventByCertificateId(db, input.certificateId)!;
}

function roundMetric(value: number): number {
    return Number(value.toFixed(1));
}

function gradeToPoints(grade: string | null): number | null {
    if (!grade) return null;
    const normalized = grade.trim().toUpperCase();
    const mapping: Record<string, number> = {
        'A+': 4,
        A: 4,
        'A-': 3.7,
        'B+': 3.3,
        B: 3,
        'B-': 2.7,
        'C+': 2.3,
        C: 2,
        'C-': 1.7,
        'D+': 1.3,
        D: 1,
        F: 0,
    };
    return mapping[normalized] ?? null;
}

function pointsToGrade(value: number | null): string {
    if (value == null) return '-';
    if (value >= 3.85) return 'A';
    if (value >= 3.5) return 'A-';
    if (value >= 3.15) return 'B+';
    if (value >= 2.85) return 'B';
    if (value >= 2.5) return 'B-';
    if (value >= 2.15) return 'C+';
    if (value >= 1.85) return 'C';
    if (value >= 1.5) return 'C-';
    if (value >= 1.15) return 'D+';
    if (value >= 0.85) return 'D';
    return 'F';
}

function averageNumber(values: number[]): number {
    if (values.length === 0) return 0;
    return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function monthBucket(dateValue: string): string {
    const parsed = new Date(dateValue);
    if (Number.isNaN(parsed.valueOf())) return '';
    return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabelFromBucket(bucket: string): string {
    const [yearText, monthText] = bucket.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const parsed = new Date(Date.UTC(year, Math.max(0, month - 1), 1));
    return parsed.toLocaleString('en-US', { month: 'short' });
}

function recentMonthBuckets(count: number): string[] {
    const buckets: string[] = [];
    const cursor = new Date();
    cursor.setUTCDate(1);
    cursor.setUTCHours(0, 0, 0, 0);
    for (let index = count - 1; index >= 0; index -= 1) {
        const current = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - index, 1));
        buckets.push(`${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return buckets;
}

function mapTeacherCourseRow(row: Record<string, unknown>): TeacherCourse {
    return {
        id: String(row.id),
        title: String(row.title),
        description: String(row.description),
        duration: String(row.duration),
        totalLessons: asInteger(row.totalLessons, 0),
        status: String(row.status) as CourseStatus,
        teacherUserId: String(row.teacherUserId),
        teacherName: asOptionalTrimmedString(row.teacherName),
        institutionId: String(row.institutionId),
        institutionName: asOptionalTrimmedString(row.institutionName),
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
        enrolledStudents: asInteger(row.enrolledStudents, 0),
        activeStudents: asInteger(row.activeStudents, 0),
        completedStudents: asInteger(row.completedStudents, 0),
        averageProgress: roundMetric(asNumber(row.averageProgress) ?? 0),
        certificatesIssued: asInteger(row.certificatesIssued, 0),
    };
}

function getCourseById(db: DatabaseSync, id: string): TeacherCourse | null {
    const row = mapRow<Record<string, unknown>>(db.prepare(`
        SELECT
            c.id,
            c.title,
            c.description,
            c.duration,
            c.totalLessons,
            c.status,
            c.teacherUserId,
            teacher.name AS teacherName,
            c.institutionId,
            institution.name AS institutionName,
            c.createdAt,
            c.updatedAt,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id), 0) AS enrolledStudents,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.status = 'active'), 0) AS activeStudents,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.status = 'completed'), 0) AS completedStudents,
            COALESCE((SELECT AVG(e.progressPercent) FROM course_enrollments e WHERE e.courseId = c.id), 0) AS averageProgress,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.certificateIssued = 1), 0) AS certificatesIssued
        FROM courses c
        LEFT JOIN users teacher ON teacher.id = c.teacherUserId
        LEFT JOIN institutions institution ON institution.id = c.institutionId
        WHERE c.id = ?
        LIMIT 1
    `).get(id));
    return row ? mapTeacherCourseRow(row) : null;
}

function listCoursesByTeacher(db: DatabaseSync, teacherUserId: string, filters?: { status?: CourseStatus | null; search?: string | undefined }): TeacherCourse[] {
    const conditions = ['c.teacherUserId = ?'];
    const params: SQLInputValue[] = [teacherUserId];
    if (filters?.status) {
        conditions.push('c.status = ?');
        params.push(filters.status);
    }
    if (filters?.search) {
        const needle = `%${filters.search.toLowerCase()}%`;
        conditions.push('(lower(c.title) LIKE ? OR lower(c.description) LIKE ?)');
        params.push(needle, needle);
    }

    const rows = db.prepare(`
        SELECT
            c.id,
            c.title,
            c.description,
            c.duration,
            c.totalLessons,
            c.status,
            c.teacherUserId,
            teacher.name AS teacherName,
            c.institutionId,
            institution.name AS institutionName,
            c.createdAt,
            c.updatedAt,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id), 0) AS enrolledStudents,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.status = 'active'), 0) AS activeStudents,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.status = 'completed'), 0) AS completedStudents,
            COALESCE((SELECT AVG(e.progressPercent) FROM course_enrollments e WHERE e.courseId = c.id), 0) AS averageProgress,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.certificateIssued = 1), 0) AS certificatesIssued
        FROM courses c
        LEFT JOIN users teacher ON teacher.id = c.teacherUserId
        LEFT JOIN institutions institution ON institution.id = c.institutionId
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.updatedAt DESC, c.title COLLATE NOCASE ASC
    `).all(...params) as Record<string, unknown>[];

    return rows.map(mapTeacherCourseRow);
}

function listCoursesByInstitution(db: DatabaseSync, institutionId: string, filters?: { status?: CourseStatus | null; search?: string | undefined }): TeacherCourse[] {
    const conditions = ['c.institutionId = ?'];
    const params: SQLInputValue[] = [institutionId];
    if (filters?.status) {
        conditions.push('c.status = ?');
        params.push(filters.status);
    }
    if (filters?.search) {
        const needle = `%${filters.search.toLowerCase()}%`;
        conditions.push("(lower(c.title) LIKE ? OR lower(c.description) LIKE ? OR lower(COALESCE(teacher.name, '')) LIKE ?)");
        params.push(needle, needle, needle);
    }

    const rows = db.prepare(`
        SELECT
            c.id,
            c.title,
            c.description,
            c.duration,
            c.totalLessons,
            c.status,
            c.teacherUserId,
            teacher.name AS teacherName,
            c.institutionId,
            institution.name AS institutionName,
            c.createdAt,
            c.updatedAt,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id), 0) AS enrolledStudents,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.status = 'active'), 0) AS activeStudents,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.status = 'completed'), 0) AS completedStudents,
            COALESCE((SELECT AVG(e.progressPercent) FROM course_enrollments e WHERE e.courseId = c.id), 0) AS averageProgress,
            COALESCE((SELECT COUNT(*) FROM course_enrollments e WHERE e.courseId = c.id AND e.certificateIssued = 1), 0) AS certificatesIssued
        FROM courses c
        LEFT JOIN users teacher ON teacher.id = c.teacherUserId
        LEFT JOIN institutions institution ON institution.id = c.institutionId
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.updatedAt DESC, c.title COLLATE NOCASE ASC
    `).all(...params) as Record<string, unknown>[];

    return rows.map(mapTeacherCourseRow);
}

function mapTeacherEnrollmentRow(row: Record<string, unknown>): TeacherEnrollment {
    return {
        id: String(row.id),
        courseId: String(row.courseId),
        courseTitle: String(row.courseTitle),
        courseStatus: String(row.courseStatus) as CourseStatus,
        studentUserId: String(row.studentUserId),
        studentId: asOptionalTrimmedString(row.studentId) || '',
        studentName: String(row.studentName),
        studentEmail: String(row.studentEmail),
        progressPercent: clampInteger(asInteger(row.progressPercent, 0), 0, 100),
        completedLessons: Math.max(0, asInteger(row.completedLessons, 0)),
        totalLessons: Math.max(0, asInteger(row.totalLessons, 0)),
        finalGrade: asOptionalTrimmedString(row.finalGrade),
        status: String(row.status) as EnrollmentStatus,
        certificateIssued: asInteger(row.certificateIssued, 0) === 1,
        certificateId: asOptionalTrimmedString(row.certificateId),
        reviewCredentialId: asOptionalTrimmedString(row.reviewCredentialId),
        reviewSubmittedAt: asOptionalTrimmedString(row.reviewSubmittedAt),
        institutionId: asOptionalTrimmedString(row.institutionId),
        institutionName: asOptionalTrimmedString(row.institutionName),
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
    };
}

function getEnrollmentById(db: DatabaseSync, id: string): TeacherEnrollment | null {
    const row = mapRow<Record<string, unknown>>(db.prepare(`
        SELECT
            e.id,
            e.courseId,
            c.title AS courseTitle,
            c.status AS courseStatus,
            e.studentUserId,
            student.studentId,
            student.name AS studentName,
            student.email AS studentEmail,
            e.progressPercent,
            e.completedLessons,
            e.totalLessons,
            e.finalGrade,
            e.status,
            e.certificateIssued,
            e.certificateId,
            e.reviewCredentialId,
            e.reviewSubmittedAt,
            c.institutionId,
            institution.name AS institutionName,
            e.createdAt,
            e.updatedAt
        FROM course_enrollments e
        INNER JOIN courses c ON c.id = e.courseId
        INNER JOIN users student ON student.id = e.studentUserId
        LEFT JOIN institutions institution ON institution.id = c.institutionId
        WHERE e.id = ?
        LIMIT 1
    `).get(id));
    return row ? mapTeacherEnrollmentRow(row) : null;
}

function listTeacherEnrollments(db: DatabaseSync, options: {
    teacherUserId: string;
    courseId?: string | undefined;
    status?: EnrollmentStatus | null;
    search?: string | undefined;
}): TeacherEnrollment[] {
    const conditions = ['c.teacherUserId = ?'];
    const params: SQLInputValue[] = [options.teacherUserId];
    if (options.courseId) {
        conditions.push('c.id = ?');
        params.push(options.courseId);
    }
    if (options.status) {
        conditions.push('e.status = ?');
        params.push(options.status);
    }
    if (options.search) {
        const needle = `%${options.search.toLowerCase()}%`;
        conditions.push("(lower(student.name) LIKE ? OR lower(student.email) LIKE ? OR lower(COALESCE(student.studentId, '')) LIKE ? OR lower(c.title) LIKE ?)");
        params.push(needle, needle, needle, needle);
    }

    const rows = db.prepare(`
        SELECT
            e.id,
            e.courseId,
            c.title AS courseTitle,
            c.status AS courseStatus,
            e.studentUserId,
            student.studentId,
            student.name AS studentName,
            student.email AS studentEmail,
            e.progressPercent,
            e.completedLessons,
            e.totalLessons,
            e.finalGrade,
            e.status,
            e.certificateIssued,
            e.certificateId,
            e.reviewCredentialId,
            e.reviewSubmittedAt,
            c.institutionId,
            institution.name AS institutionName,
            e.createdAt,
            e.updatedAt
        FROM course_enrollments e
        INNER JOIN courses c ON c.id = e.courseId
        INNER JOIN users student ON student.id = e.studentUserId
        LEFT JOIN institutions institution ON institution.id = c.institutionId
        WHERE ${conditions.join(' AND ')}
        ORDER BY e.updatedAt DESC, student.name COLLATE NOCASE ASC
    `).all(...params) as Record<string, unknown>[];

    return rows.map(mapTeacherEnrollmentRow);
}

function listTeacherStudents(db: DatabaseSync, teacherUserId: string, search?: string): TeacherStudent[] {
    const enrollments = listTeacherEnrollments(db, { teacherUserId, search });
    const studentMap = new Map<string, {
        studentUserId: string;
        studentId: string;
        name: string;
        email: string;
        institutionId: string | null;
        institutionName: string | null;
        courseIds: Set<string>;
        activeCourses: number;
        completedCourses: number;
        progressValues: number[];
        certificatesIssued: number;
        lastUpdated: string;
    }>();

    for (const enrollment of enrollments) {
        const current = studentMap.get(enrollment.studentUserId) ?? {
            studentUserId: enrollment.studentUserId,
            studentId: enrollment.studentId,
            name: enrollment.studentName,
            email: enrollment.studentEmail,
            institutionId: enrollment.institutionId,
            institutionName: enrollment.institutionName,
            courseIds: new Set<string>(),
            activeCourses: 0,
            completedCourses: 0,
            progressValues: [],
            certificatesIssued: 0,
            lastUpdated: enrollment.updatedAt,
        };
        current.courseIds.add(enrollment.courseId);
        if (enrollment.status === 'completed') {
            current.completedCourses += 1;
        } else if (enrollment.status === 'active') {
            current.activeCourses += 1;
        }
        current.progressValues.push(enrollment.progressPercent);
        if (enrollment.certificateIssued) {
            current.certificatesIssued += 1;
        }
        if (enrollment.updatedAt > current.lastUpdated) {
            current.lastUpdated = enrollment.updatedAt;
        }
        studentMap.set(enrollment.studentUserId, current);
    }

    return Array.from(studentMap.values())
        .map((student) => ({
            studentUserId: student.studentUserId,
            studentId: student.studentId,
            name: student.name,
            email: student.email,
            institutionId: student.institutionId,
            institutionName: student.institutionName,
            assignedCourses: student.courseIds.size,
            activeCourses: student.activeCourses,
            completedCourses: student.completedCourses,
            averageProgress: averageNumber(student.progressValues),
            certificatesIssued: student.certificatesIssued,
            lastUpdated: student.lastUpdated,
        }))
        .sort((left, right) => right.lastUpdated.localeCompare(left.lastUpdated));
}

function listEligibleTeacherCertificates(db: DatabaseSync, teacherUserId: string, search?: string): TeacherCertificateQueueItem[] {
    return listTeacherEnrollments(db, { teacherUserId, search })
        .filter((enrollment) => enrollment.status === 'completed' && !!enrollment.finalGrade && !enrollment.certificateIssued && !enrollment.reviewCredentialId)
        .map((enrollment) => ({
            enrollmentId: enrollment.id,
            courseId: enrollment.courseId,
            courseTitle: enrollment.courseTitle,
            studentUserId: enrollment.studentUserId,
            studentId: enrollment.studentId,
            studentName: enrollment.studentName,
            studentEmail: enrollment.studentEmail,
            progressPercent: enrollment.progressPercent,
            completedLessons: enrollment.completedLessons,
            totalLessons: enrollment.totalLessons,
            finalGrade: enrollment.finalGrade,
            institutionName: enrollment.institutionName,
            updatedAt: enrollment.updatedAt,
            reviewCredentialId: enrollment.reviewCredentialId,
            reviewSubmittedAt: enrollment.reviewSubmittedAt,
        }));
}

function listTeacherIssuanceEvents(db: DatabaseSync, teacherUserId: string): Array<CertificateIssuanceEvent & {
    studentName: string | null;
    studentEmail: string | null;
}> {
    const rows = db.prepare(`
        SELECT
            e.id,
            e.certificateId,
            e.hash,
            e.studentId,
            e.issuerUserId,
            issuer.name AS issuerName,
            e.institutionId,
            institution.name AS institutionName,
            e.courseId,
            c.title AS courseTitle,
            e.enrollmentId,
            e.issuedAt,
            student.name AS studentName,
            student.email AS studentEmail
        FROM certificate_issuance_events e
        LEFT JOIN users issuer ON issuer.id = e.issuerUserId
        LEFT JOIN institutions institution ON institution.id = e.institutionId
        LEFT JOIN courses c ON c.id = e.courseId
        LEFT JOIN course_enrollments ce ON ce.id = e.enrollmentId
        LEFT JOIN users student ON student.id = ce.studentUserId
        WHERE e.issuerUserId = ?
        ORDER BY e.issuedAt DESC
    `).all(teacherUserId) as Record<string, unknown>[];

    return rows.map((row) => ({
        id: String(row.id),
        certificateId: String(row.certificateId),
        hash: String(row.hash),
        studentId: String(row.studentId),
        issuerUserId: String(row.issuerUserId),
        issuerName: asOptionalTrimmedString(row.issuerName),
        institutionId: asOptionalTrimmedString(row.institutionId),
        institutionName: asOptionalTrimmedString(row.institutionName),
        courseId: asOptionalTrimmedString(row.courseId),
        courseTitle: asOptionalTrimmedString(row.courseTitle),
        enrollmentId: asOptionalTrimmedString(row.enrollmentId),
        issuedAt: String(row.issuedAt),
        studentName: asOptionalTrimmedString(row.studentName),
        studentEmail: asOptionalTrimmedString(row.studentEmail),
    }));
}

function buildTeacherDashboardSummary(db: DatabaseSync, teacher: AppUser): TeacherDashboardSummary {
    const courses = listCoursesByTeacher(db, teacher.id, { status: 'active' });
    const students = listTeacherStudents(db, teacher.id);
    const enrollments = listTeacherEnrollments(db, { teacherUserId: teacher.id });
    const eligibleCertificates = listEligibleTeacherCertificates(db, teacher.id);
    const issuedCertificates = listTeacherIssuanceEvents(db, teacher.id);

    return {
        totals: {
            students: students.length,
            activeCourses: courses.length,
            completedEnrollments: enrollments.filter((item) => item.status === 'completed').length,
            eligibleCertificates: eligibleCertificates.length,
            issuedCertificates: issuedCertificates.length,
            averageProgress: averageNumber(enrollments.map((item) => item.progressPercent)),
        },
        recentStudents: students.slice(0, 5),
        pendingCertificates: eligibleCertificates.slice(0, 5),
        courses: courses.slice(0, 4),
    };
}

async function listTeacherIssuedCertificates(db: DatabaseSync, contract: Contract, req: AuthenticatedRequest, teacher: AppUser): Promise<TeacherIssuedCertificate[]> {
    const issuanceEvents = listTeacherIssuanceEvents(db, teacher.id);
    const submittedEnrollments = listTeacherEnrollments(db, { teacherUserId: teacher.id }).filter((item) => !!item.reviewCredentialId);

    const certificateIds = new Set<string>([
        ...issuanceEvents.map((item) => item.certificateId),
        ...submittedEnrollments.map((item) => item.reviewCredentialId!).filter(Boolean),
    ]);

    const certificateMap = new Map(
        (await getAllCertificatesFromLedger(contract))
            .filter((certificate) => certificateIds.has(certificate.id))
            .map((certificate) => [certificate.id, certificate]),
    );
    const verificationMap = new Map<string, { count: number; latest: string | null }>();
    for (const event of listVerificationEvents(db, { limit: 500 })) {
        if (!certificateIds.has(event.certificateId)) continue;
        const current = verificationMap.get(event.certificateId) ?? { count: 0, latest: null };
        current.count += 1;
        if (!current.latest || event.verifiedAt > current.latest) {
            current.latest = event.verifiedAt;
        }
        verificationMap.set(event.certificateId, current);
    }

    const submittedItems: TeacherIssuedCertificate[] = [];
    for (const enrollment of submittedEnrollments) {
        const credentialId = enrollment.reviewCredentialId!;
        const credential = await getGatewayCredentialById(req, credentialId);
        if (!credential) {
            submittedItems.push({
                issuanceId: `review-${enrollment.id}`,
                enrollmentId: enrollment.id,
                courseId: enrollment.courseId,
                courseTitle: enrollment.courseTitle,
                certificateId: credentialId,
                hash: '',
                studentId: enrollment.studentId,
                studentName: enrollment.studentName,
                studentEmail: enrollment.studentEmail,
                graduationDate: enrollment.reviewSubmittedAt?.slice(0, 10) || enrollment.updatedAt.slice(0, 10),
                issuedAt: enrollment.reviewSubmittedAt || enrollment.updatedAt,
                university: enrollment.institutionName || teacher.institutionName || 'Unknown institution',
                status: 'pending_review',
                verificationCount: 0,
                latestVerificationAt: null,
                verificationUrl: null,
                proofReference: null,
                versionNo: null,
                qrToken: null,
            });
            continue;
        }

        const verification = verificationMap.get(credentialId);
        submittedItems.push({
            issuanceId: `review-${enrollment.id}`,
            enrollmentId: enrollment.id,
            courseId: enrollment.courseId,
            courseTitle: asOptionalTrimmedString(credential.title) || asOptionalTrimmedString(credential.programName) || enrollment.courseTitle,
            certificateId: asOptionalTrimmedString(credential.credentialId) || asOptionalTrimmedString(credential.id) || credentialId,
            hash: asOptionalTrimmedString(credential.hash) || '',
            studentId: asOptionalTrimmedString(credential.studentId) || enrollment.studentId,
            studentName: asOptionalTrimmedString(credential.studentName) || enrollment.studentName,
            studentEmail: enrollment.studentEmail,
            graduationDate: asOptionalTrimmedString(credential.awardDate) || enrollment.reviewSubmittedAt?.slice(0, 10) || enrollment.updatedAt.slice(0, 10),
            issuedAt: enrollment.reviewSubmittedAt || enrollment.updatedAt,
            university: asOptionalTrimmedString(credential.institution) || enrollment.institutionName || teacher.institutionName || 'Unknown institution',
            status: asOptionalTrimmedString(credential.status) || 'pending_review',
            verificationCount: verification?.count ?? 0,
            latestVerificationAt: verification?.latest ?? null,
            verificationUrl: asOptionalTrimmedString(credential.verificationUrl),
            proofReference: asOptionalTrimmedString(credential.proofReference),
            versionNo: asNumber(credential.versionNo),
            qrToken: asOptionalTrimmedString(credential.qrToken),
        });
    }

    const issuedItems = issuanceEvents.map((item) => {
        const certificate = certificateMap.get(item.certificateId);
        const verification = verificationMap.get(item.certificateId);
        return {
            issuanceId: item.id,
            enrollmentId: item.enrollmentId,
            courseId: item.courseId,
            courseTitle: item.courseTitle || certificate?.degree || 'Course',
            certificateId: item.certificateId,
            hash: item.hash,
            studentId: item.studentId,
            studentName: item.studentName || certificate?.studentName || 'Unknown student',
            studentEmail: item.studentEmail || '',
            graduationDate: certificate?.graduationDate || item.issuedAt.slice(0, 10),
            issuedAt: item.issuedAt,
            university: certificate?.university || item.institutionName || teacher.institutionName || 'Unknown institution',
            status: certificate?.isRevoked ? 'revoked' : 'anchored',
            verificationCount: verification?.count ?? 0,
            latestVerificationAt: verification?.latest ?? null,
            verificationUrl: null,
            proofReference: null,
            versionNo: null,
            qrToken: null,
        };
    });

    return [...submittedItems, ...issuedItems].sort((left, right) => right.issuedAt.localeCompare(left.issuedAt));
}

async function buildTeacherAnalyticsSummary(db: DatabaseSync, contract: Contract, req: AuthenticatedRequest, teacher: AppUser): Promise<TeacherAnalyticsSummary> {
    const courses = listCoursesByTeacher(db, teacher.id, { status: null });
    const enrollments = listTeacherEnrollments(db, { teacherUserId: teacher.id });
    const students = listTeacherStudents(db, teacher.id);
    const issuedCertificates = await listTeacherIssuedCertificates(db, contract, req, teacher);
    const certificateIdSet = new Set(issuedCertificates.map((item) => item.certificateId));
    const verificationEvents = listVerificationEvents(db, { limit: 500 }).filter((event) => certificateIdSet.has(event.certificateId));
    const buckets = recentMonthBuckets(6);

    const monthlyActivity = buckets.map((bucket) => ({
        month: monthLabelFromBucket(bucket),
        issued: issuedCertificates.filter((item) => monthBucket(item.issuedAt) === bucket).length,
        verified: verificationEvents.filter((item) => monthBucket(item.verifiedAt) === bucket).length,
    }));

    const coursePerformance = courses.map((course) => {
        const courseEnrollments = enrollments.filter((item) => item.courseId === course.id);
        const gradeValues = courseEnrollments.map((item) => gradeToPoints(item.finalGrade)).filter((value): value is number => value != null);
        const completionRate = courseEnrollments.length > 0
            ? roundMetric((courseEnrollments.filter((item) => item.status === 'completed').length / courseEnrollments.length) * 100)
            : 0;
        return {
            courseId: course.id,
            courseTitle: course.title,
            students: courseEnrollments.length,
            avgProgress: averageNumber(courseEnrollments.map((item) => item.progressPercent)),
            completionRate,
            avgGrade: pointsToGrade(gradeValues.length > 0 ? gradeValues.reduce((sum, value) => sum + value, 0) / gradeValues.length : null),
        };
    });

    return {
        totals: {
            students: students.length,
            averageProgress: averageNumber(enrollments.map((item) => item.progressPercent)),
            certificatesIssued: issuedCertificates.length,
            activeCourses: courses.filter((course) => course.status === 'active').length,
        },
        monthlyActivity,
        coursePerformance,
    };
}

function getFraudCaseById(db: DatabaseSync, id: string): FraudCase | null {
    const row = mapRow<Record<string, unknown>>(db.prepare(`
        SELECT
            f.id,
            f.verificationEventId,
            f.certificateId,
            f.certificateHash,
            f.status,
            f.reason,
            f.notes,
            f.resolution,
            f.reporterUserId,
            reporter.name AS reporterName,
            f.assigneeUserId,
            assignee.name AS assigneeName,
            f.issuerUserId,
            issuer.name AS issuerName,
            f.institutionId,
            institution.name AS institutionName,
            f.createdAt,
            f.updatedAt
        FROM fraud_cases f
        LEFT JOIN users reporter ON reporter.id = f.reporterUserId
        LEFT JOIN users assignee ON assignee.id = f.assigneeUserId
        LEFT JOIN users issuer ON issuer.id = f.issuerUserId
        LEFT JOIN institutions institution ON institution.id = f.institutionId
        WHERE f.id = ?
        LIMIT 1
    `).get(id));
    if (!row) return null;
    return {
        id: String(row.id),
        verificationEventId: asOptionalTrimmedString(row.verificationEventId),
        certificateId: String(row.certificateId),
        certificateHash: asOptionalTrimmedString(row.certificateHash),
        status: String(row.status) as FraudCaseStatus,
        reason: String(row.reason),
        notes: String(row.notes),
        resolution: String(row.resolution),
        reporterUserId: String(row.reporterUserId),
        reporterName: asOptionalTrimmedString(row.reporterName),
        assigneeUserId: asOptionalTrimmedString(row.assigneeUserId),
        assigneeName: asOptionalTrimmedString(row.assigneeName),
        issuerUserId: asOptionalTrimmedString(row.issuerUserId),
        issuerName: asOptionalTrimmedString(row.issuerName),
        institutionId: asOptionalTrimmedString(row.institutionId),
        institutionName: asOptionalTrimmedString(row.institutionName),
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
    };
}

function listFraudCases(db: DatabaseSync, filters?: { status?: FraudCaseStatus | null; search?: string; limit?: number }): FraudCase[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];

    if (filters?.status) {
        conditions.push('f.status = ?');
        params.push(filters.status);
    }
    if (filters?.search) {
        conditions.push("(lower(f.certificateId) LIKE ? OR lower(f.reason) LIKE ? OR lower(COALESCE(institution.name, '')) LIKE ?)");
        const needle = `%${filters.search.toLowerCase()}%`;
        params.push(needle, needle, needle);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters?.limit ? `LIMIT ${Math.max(1, Math.min(filters.limit, 200))}` : 'LIMIT 200';
    const rows = db.prepare(`
        SELECT
            f.id,
            f.verificationEventId,
            f.certificateId,
            f.certificateHash,
            f.status,
            f.reason,
            f.notes,
            f.resolution,
            f.reporterUserId,
            reporter.name AS reporterName,
            f.assigneeUserId,
            assignee.name AS assigneeName,
            f.issuerUserId,
            issuer.name AS issuerName,
            f.institutionId,
            institution.name AS institutionName,
            f.createdAt,
            f.updatedAt
        FROM fraud_cases f
        LEFT JOIN users reporter ON reporter.id = f.reporterUserId
        LEFT JOIN users assignee ON assignee.id = f.assigneeUserId
        LEFT JOIN users issuer ON issuer.id = f.issuerUserId
        LEFT JOIN institutions institution ON institution.id = f.institutionId
        ${whereClause}
        ORDER BY f.updatedAt DESC
        ${limitClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => ({
        id: String(row.id),
        verificationEventId: asOptionalTrimmedString(row.verificationEventId),
        certificateId: String(row.certificateId),
        certificateHash: asOptionalTrimmedString(row.certificateHash),
        status: String(row.status) as FraudCaseStatus,
        reason: String(row.reason),
        notes: String(row.notes),
        resolution: String(row.resolution),
        reporterUserId: String(row.reporterUserId),
        reporterName: asOptionalTrimmedString(row.reporterName),
        assigneeUserId: asOptionalTrimmedString(row.assigneeUserId),
        assigneeName: asOptionalTrimmedString(row.assigneeName),
        issuerUserId: asOptionalTrimmedString(row.issuerUserId),
        issuerName: asOptionalTrimmedString(row.issuerName),
        institutionId: asOptionalTrimmedString(row.institutionId),
        institutionName: asOptionalTrimmedString(row.institutionName),
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
    }));
}

function listAuditLogs(db: DatabaseSync, filters?: { action?: string; entityType?: string; search?: string; limit?: number }): AuditLog[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];

    if (filters?.action) {
        conditions.push('a.action = ?');
        params.push(filters.action);
    }
    if (filters?.entityType) {
        conditions.push('a.entityType = ?');
        params.push(filters.entityType);
    }
    if (filters?.search) {
        conditions.push("(lower(a.action) LIKE ? OR lower(a.entityId) LIKE ? OR lower(COALESCE(actor.name, '')) LIKE ?)");
        const needle = `%${filters.search.toLowerCase()}%`;
        params.push(needle, needle, needle);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filters?.limit ? `LIMIT ${Math.max(1, Math.min(filters.limit, 200))}` : 'LIMIT 200';
    const rows = db.prepare(`
        SELECT
            a.id,
            a.actorUserId,
            actor.name AS actorName,
            a.action,
            a.entityType,
            a.entityId,
            a.details,
            a.createdAt
        FROM audit_logs a
        LEFT JOIN users actor ON actor.id = a.actorUserId
        ${whereClause}
        ORDER BY a.createdAt DESC
        ${limitClause}
    `).all(...params) as Record<string, unknown>[];

    return rows.map((row) => ({
        id: String(row.id),
        actorUserId: asOptionalTrimmedString(row.actorUserId),
        actorName: asOptionalTrimmedString(row.actorName),
        action: String(row.action),
        entityType: String(row.entityType),
        entityId: String(row.entityId),
        details: parseJsonObject(asOptionalTrimmedString(row.details)),
        createdAt: String(row.createdAt),
    }));
}

function listInstitutionAuditLogs(db: DatabaseSync, institutionId: string, filters?: { action?: string; entityType?: string; search?: string; limit?: number }): AuditLog[] {
    const institutionUsers = listUsers(db, { institutionId });
    const userIds = new Set(institutionUsers.map((user) => user.id));
    const courseIds = new Set(listCoursesByInstitution(db, institutionId).map((course) => course.id));
    const issuanceRows = db.prepare(`
        SELECT certificateId
        FROM certificate_issuance_events
        WHERE institutionId = ?
    `).all(institutionId) as Array<{ certificateId?: string }>;
    const certificateIds = new Set(issuanceRows.map((row) => asOptionalTrimmedString(row.certificateId)).filter((value): value is string => !!value));
    const verificationRows = db.prepare(`
        SELECT id
        FROM verification_events
        WHERE certificateId IN (
            SELECT certificateId
            FROM certificate_issuance_events
            WHERE institutionId = ?
        )
    `).all(institutionId) as Array<{ id?: string }>;
    const verificationIds = new Set(verificationRows.map((row) => asOptionalTrimmedString(row.id)).filter((value): value is string => !!value));
    const fraudRows = db.prepare(`
        SELECT id
        FROM fraud_cases
        WHERE institutionId = ?
    `).all(institutionId) as Array<{ id?: string }>;
    const fraudCaseIds = new Set(fraudRows.map((row) => asOptionalTrimmedString(row.id)).filter((value): value is string => !!value));
    const audits = listAuditLogs(db, { ...filters, limit: Math.max(filters?.limit ?? 200, 1000) });

    return audits
        .filter((item) => {
            if (item.actorUserId && userIds.has(item.actorUserId)) return true;
            if (item.entityType === 'institution' && item.entityId === institutionId) return true;
            if (item.entityType === 'user' && userIds.has(item.entityId)) return true;
            if (item.entityType === 'course' && courseIds.has(item.entityId)) return true;
            if (item.entityType === 'certificate' && certificateIds.has(item.entityId)) return true;
            if (item.entityType === 'verification' && verificationIds.has(item.entityId)) return true;
            if (item.entityType === 'fraud_case' && fraudCaseIds.has(item.entityId)) return true;
            return false;
        })
        .slice(0, Math.max(1, Math.min(filters?.limit ?? 200, 200)));
}

async function collectNetworkStatus(contract?: Contract | null): Promise<NetworkStatusPayload> {
    const checkedAt = nowIso();
    const alerts: string[] = [];
    const services: NetworkServiceStatus[] = [];

    if (!contract) {
        const gatewayReachable = await maybeGatewayHealth();
        const status: NetworkHealth = gatewayReachable ? 'degraded' : 'down';
        const statusText = gatewayReachable
            ? 'Fabric connection disabled; bridge is running in gateway proxy mode.'
            : 'Fabric connection disabled and upstream gateway is unreachable.';
        if (!gatewayReachable) {
            alerts.push(statusText);
        }
        services.push({
            id: 'bridge-api',
            name: 'Bridge API / Fabric Gateway',
            kind: 'bridge',
            image: 'local-node-process',
            ports: String(port),
            isRunning: true,
            status,
            statusText,
        });
    } else {
        try {
            await contract.evaluateTransaction('GetAllCertificates');
            services.push({
                id: 'bridge-api',
                name: 'Bridge API / Fabric Gateway',
                kind: 'bridge',
                image: 'local-node-process',
                ports: String(port),
                isRunning: true,
                status: 'healthy',
                statusText: 'Connected to Fabric channel and chaincode.',
            });
        } catch (error) {
            const message = extractErrorMessage(error);
            alerts.push(`Bridge health degraded: ${message}`);
            services.push({
                id: 'bridge-api',
                name: 'Bridge API / Fabric Gateway',
                kind: 'bridge',
                image: 'local-node-process',
                ports: String(port),
                isRunning: true,
                status: isConnectionError(message) ? 'down' : 'degraded',
                statusText: message,
            });
        }
    }

    const expected = [
        { id: 'orderer.ministry.gov.so', name: 'Ministry Orderer', kind: 'orderer' },
        { id: 'peer0.mogadishu.university.so', name: 'Mogadishu Peer', kind: 'peer' },
        { id: 'peer0.hargeisa.university.so', name: 'Hargeisa Peer', kind: 'peer' },
        { id: 'certificate-chaincode', name: 'Certificate Chaincode', kind: 'chaincode' },
        { id: 'couchdb0', name: 'CouchDB 0', kind: 'database' },
        { id: 'couchdb1', name: 'CouchDB 1', kind: 'database' },
        { id: 'ca.mogadishu.university.so', name: 'Mogadishu CA', kind: 'certificate-authority' },
        { id: 'ca.hargeisa.university.so', name: 'Hargeisa CA', kind: 'certificate-authority' },
    ];

    try {
        const { stdout } = await execFileAsync(
            'docker',
            ['ps', '-a', '--format', '{{json .}}'],
            { timeout: 4000, maxBuffer: 1024 * 1024 },
        );
        const dockerRows = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { Names: string; Image: string; Status: string; Ports: string });
        const dockerMap = new Map(dockerRows.map((row) => [row.Names, row]));

        for (const item of expected) {
            const row = dockerMap.get(item.id);
            if (!row) {
                alerts.push(`${item.name} is missing from Docker.`);
                services.push({
                    id: item.id,
                    name: item.name,
                    kind: item.kind,
                    image: 'not-found',
                    ports: '',
                    isRunning: false,
                    status: 'down',
                    statusText: 'Container not found.',
                });
                continue;
            }

            const normalizedStatus = row.Status.toLowerCase();
            const isRunning = normalizedStatus.startsWith('up');
            const status: NetworkHealth = isRunning ? 'healthy' : 'down';
            if (!isRunning) {
                alerts.push(`${item.name} is not running: ${row.Status}`);
            }
            services.push({
                id: item.id,
                name: item.name,
                kind: item.kind,
                image: row.Image,
                ports: row.Ports,
                isRunning,
                status,
                statusText: row.Status,
            });
        }
    } catch (error) {
        const message = extractErrorMessage(error);
        alerts.push(`Docker status unavailable: ${message}`);
        for (const item of expected) {
            services.push({
                id: item.id,
                name: item.name,
                kind: item.kind,
                image: 'docker-unavailable',
                ports: '',
                isRunning: false,
                status: 'unknown',
                statusText: message,
            });
        }
    }

    const statuses = services.map((service) => service.status);
    const overallStatus: NetworkHealth = statuses.every((status) => status === 'healthy')
        ? 'healthy'
        : statuses.some((status) => status === 'down')
            ? 'down'
            : statuses.some((status) => status === 'degraded' || status === 'unknown')
                ? 'degraded'
                : 'unknown';

    return {
        overallStatus,
        checkedAt,
        services,
        alerts,
    };
}

function countValue(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
    const row = db.prepare(sql).get(...params) as { total?: number } | undefined;
    return Number(row?.total || 0);
}

async function buildMinistryDashboardSummary(db: DatabaseSync, contract?: Contract | null): Promise<MinistryDashboardSummary> {
    const institutions = listInstitutions(db, { includeSystem: false }).slice(0, 6);
    const audits = listAuditLogs(db, { limit: 8 });
    const networkStatus = await collectNetworkStatus(contract);
    const certificates = contract ? await getAllCertificatesFromLedger(contract) : [];
    const alerts = [...networkStatus.alerts];
    const suspendedInstitutions = listInstitutions(db, { includeSystem: false, status: 'suspended' });
    for (const institution of suspendedInstitutions) {
        alerts.push(`${institution.name} is suspended.`);
    }
    const openFraudCases = countValue(db, `SELECT COUNT(*) AS total FROM fraud_cases WHERE status IN ('open', 'investigating')`);
    if (openFraudCases > 0) {
        alerts.push(`${openFraudCases} fraud case(s) need review.`);
    }

    return {
        totals: {
            institutions: countValue(db, `SELECT COUNT(*) AS total FROM institutions WHERE type != 'ministry'`),
            activeInstitutions: countValue(db, `SELECT COUNT(*) AS total FROM institutions WHERE type != 'ministry' AND status = 'active'`),
            suspendedInstitutions: countValue(db, `SELECT COUNT(*) AS total FROM institutions WHERE type != 'ministry' AND status = 'suspended'`),
            users: countValue(db, `SELECT COUNT(*) AS total FROM users`),
            certificates: certificates.length,
            verificationToday: countValue(db, `SELECT COUNT(*) AS total FROM verification_events WHERE substr(verifiedAt, 1, 10) = ?`, TODAY_PREFIX),
            openFraudCases,
        },
        alerts: Array.from(new Set(alerts)).slice(0, 8),
        recentAudits: audits,
        institutions,
        networkStatus: networkStatus.overallStatus,
    };
}

async function buildVerifierDashboardSummary(db: DatabaseSync, contract?: Contract | null): Promise<VerifierDashboardSummary> {
    const certificates = contract ? await getAllCertificatesFromLedger(contract) : [];
    const recentVerifications = listVerificationEvents(db, { limit: 8 });
    const suspiciousCases = listFraudCases(db, { limit: 6 }).filter((item) => item.status === 'open' || item.status === 'investigating');
    const networkStatus = await collectNetworkStatus(contract);
    return {
        totals: {
            certificates: certificates.length,
            verificationsToday: countValue(db, `SELECT COUNT(*) AS total FROM verification_events WHERE substr(verifiedAt, 1, 10) = ?`, TODAY_PREFIX),
            validToday: countValue(db, `SELECT COUNT(*) AS total FROM verification_events WHERE substr(verifiedAt, 1, 10) = ? AND result = 'valid'`, TODAY_PREFIX),
            invalidToday: countValue(db, `SELECT COUNT(*) AS total FROM verification_events WHERE substr(verifiedAt, 1, 10) = ? AND result IN ('invalid', 'invalid_hash', 'revoked', 'not_found', 'pending_anchor')`, TODAY_PREFIX),
            openFraudCases: suspiciousCases.length,
        },
        recentVerifications,
        suspiciousCases,
        networkStatus: networkStatus.overallStatus,
    };
}

function buildReportSummary(db: DatabaseSync, from: string, to: string, institutionId?: string | null): ReportSummary {
    const scopedInstitutionId = institutionId ?? null;
    const institutions = scopedInstitutionId
        ? (getInstitutionRecordById(db, scopedInstitutionId) ? 1 : 0)
        : countValue(db, `SELECT COUNT(*) AS total FROM institutions WHERE type != 'ministry'`);
    const users = scopedInstitutionId
        ? countValue(db, `SELECT COUNT(*) AS total FROM users WHERE institutionId = ?`, scopedInstitutionId)
        : countValue(db, `SELECT COUNT(*) AS total FROM users`);
    const issuance = scopedInstitutionId
        ? countValue(db, `SELECT COUNT(*) AS total FROM certificate_issuance_events WHERE institutionId = ? AND issuedAt BETWEEN ? AND ?`, scopedInstitutionId, from, to)
        : countValue(db, `SELECT COUNT(*) AS total FROM certificate_issuance_events WHERE issuedAt BETWEEN ? AND ?`, from, to);
    const verifications = scopedInstitutionId
        ? countValue(db, `
            SELECT COUNT(*) AS total
            FROM verification_events v
            INNER JOIN certificate_issuance_events e ON e.certificateId = v.certificateId
            WHERE e.institutionId = ? AND v.verifiedAt BETWEEN ? AND ?
        `, scopedInstitutionId, from, to)
        : countValue(db, `SELECT COUNT(*) AS total FROM verification_events WHERE verifiedAt BETWEEN ? AND ?`, from, to);
    const fraudCases = scopedInstitutionId
        ? countValue(db, `SELECT COUNT(*) AS total FROM fraud_cases WHERE institutionId = ? AND updatedAt BETWEEN ? AND ?`, scopedInstitutionId, from, to)
        : countValue(db, `SELECT COUNT(*) AS total FROM fraud_cases WHERE updatedAt BETWEEN ? AND ?`, from, to);
    const audits = scopedInstitutionId
        ? listInstitutionAuditLogs(db, scopedInstitutionId, { limit: 1000 }).filter((item) => item.createdAt >= from && item.createdAt <= to).length
        : countValue(db, `SELECT COUNT(*) AS total FROM audit_logs WHERE createdAt BETWEEN ? AND ?`, from, to);

    return {
        from,
        to,
        issuance,
        verifications,
        fraudCases,
        institutions,
        users,
        audits,
    };
}

function normalizeDateRange(query: Request['query']): { from: string; to: string } {
    const to = asTrimmedString(query.to) || nowIso();
    const from = asTrimmedString(query.from) || new Date(Date.now() - reportDefaultDays * 86400000).toISOString();
    return { from, to };
}

function escapeCsvCell(value: string): string {
    const normalized = value.replace(/\r?\n/g, ' ');
    return /[",]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

function datasetToCsv(dataset: ReportDataset): string {
    const lines = [dataset.headers.map(escapeCsvCell).join(',')];
    for (const row of dataset.rows) {
        lines.push(row.map((cell) => escapeCsvCell(cell)).join(','));
    }
    return lines.join('\n');
}

async function datasetToPdfBuffer(dataset: ReportDataset): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const left = doc.page.margins.left;
        const right = doc.page.width - doc.page.margins.right;
        const usableWidth = right - left;
        const top = doc.page.margins.top;
        const bottomLimit = doc.page.height - doc.page.margins.bottom;
        const columnWidth = usableWidth / dataset.headers.length;
        const headerHeight = 26;
        const rowHeight = 34;
        let y = top;

        const renderHeader = () => {
            doc.fillColor('#111827').font('Helvetica-Bold').fontSize(20).text(dataset.title, left, y, { width: usableWidth });
            y += 28;
            doc.fillColor('#6b7280').font('Helvetica').fontSize(10).text(dataset.subtitle, left, y, { width: usableWidth });
            y += 24;
            doc.save();
            doc.fillColor('#eff6ff').roundedRect(left, y, usableWidth, headerHeight, 6).fill();
            doc.restore();
            doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(9);
            dataset.headers.forEach((header, index) => {
                doc.text(header, left + index * columnWidth + 6, y + 8, {
                    width: columnWidth - 12,
                    ellipsis: true,
                });
            });
            y += headerHeight + 8;
        };

        renderHeader();

        doc.font('Helvetica').fontSize(9).fillColor('#111827');
        for (const row of dataset.rows) {
            if (y + rowHeight > bottomLimit) {
                doc.addPage({ layout: 'landscape' });
                y = top;
                renderHeader();
                doc.font('Helvetica').fontSize(9).fillColor('#111827');
            }
            doc.roundedRect(left, y, usableWidth, rowHeight, 4).strokeColor('#e5e7eb').stroke();
            row.forEach((cell, index) => {
                doc.text(clampText(cell, 60), left + index * columnWidth + 6, y + 8, {
                    width: columnWidth - 12,
                    height: rowHeight - 12,
                    ellipsis: true,
                });
            });
            y += rowHeight + 6;
        }

        doc.end();
    });
}

function queryReportDataset(db: DatabaseSync, type: ReportType, from: string, to: string, institutionId?: string | null): ReportDataset {
    const scopedInstitutionId = institutionId ?? null;
    switch (type) {
        case 'issuance': {
            const rows = db.prepare(`
                SELECT
                    e.certificateId,
                    e.studentId,
                    u.name AS issuerName,
                    i.name AS institutionName,
                    e.hash,
                    e.issuedAt
                FROM certificate_issuance_events e
                LEFT JOIN users u ON u.id = e.issuerUserId
                LEFT JOIN institutions i ON i.id = e.institutionId
                WHERE e.issuedAt BETWEEN ? AND ?
                  AND (? IS NULL OR e.institutionId = ?)
                ORDER BY e.issuedAt DESC
            `).all(from, to, scopedInstitutionId, scopedInstitutionId) as Record<string, unknown>[];
            return {
                title: 'Certificate Issuance Report',
                subtitle: `Issued certificates from ${from} to ${to}`,
                headers: ['Certificate', 'Student', 'Issuer', 'Institution', 'Hash', 'Issued At'],
                rows: rows.map((row) => [
                    String(row.certificateId),
                    String(row.studentId),
                    asTrimmedString(row.issuerName) || 'Unknown',
                    asTrimmedString(row.institutionName) || 'Unknown',
                    String(row.hash),
                    formatDisplayDate(String(row.issuedAt)),
                ]),
            };
        }
        case 'fraud-cases': {
            const rows = db.prepare(`
                SELECT
                    f.id,
                    f.certificateId,
                    f.status,
                    f.reason,
                    institution.name AS institutionName,
                    reporter.name AS reporterName,
                    f.updatedAt
                FROM fraud_cases f
                LEFT JOIN institutions institution ON institution.id = f.institutionId
                LEFT JOIN users reporter ON reporter.id = f.reporterUserId
                WHERE f.updatedAt BETWEEN ? AND ?
                  AND (? IS NULL OR f.institutionId = ?)
                ORDER BY f.updatedAt DESC
            `).all(from, to, scopedInstitutionId, scopedInstitutionId) as Record<string, unknown>[];
            return {
                title: 'Fraud Case Report',
                subtitle: `Fraud cases from ${from} to ${to}`,
                headers: ['Case', 'Certificate', 'Status', 'Reason', 'Institution', 'Reporter', 'Updated'],
                rows: rows.map((row) => [
                    String(row.id),
                    String(row.certificateId),
                    String(row.status),
                    String(row.reason),
                    asTrimmedString(row.institutionName) || 'Unknown',
                    asTrimmedString(row.reporterName) || 'Unknown',
                    formatDisplayDate(String(row.updatedAt)),
                ]),
            };
        }
        case 'institutions': {
            const rows = scopedInstitutionId
                ? listInstitutions(db, { includeSystem: false }).filter((row) => row.id === scopedInstitutionId)
                : listInstitutions(db, { includeSystem: false });
            return {
                title: 'Institution Report',
                subtitle: scopedInstitutionId ? 'Institution overview' : 'Managed education institutions',
                headers: ['Institution', 'Code', 'Type', 'Status', 'Users', 'Certificates', 'Updated'],
                rows: rows.map((row) => [
                    row.name,
                    row.code,
                    row.type,
                    row.status,
                    String(row.userCount),
                    String(row.certificateCount),
                    formatDisplayDate(row.updatedAt),
                ]),
            };
        }
        case 'users': {
            const rows = listUsers(db, scopedInstitutionId ? { institutionId: scopedInstitutionId } : undefined);
            return {
                title: 'User Account Report',
                subtitle: 'Platform accounts and statuses',
                headers: ['Name', 'Email', 'Role', 'Status', 'Institution', 'Student ID', 'Updated'],
                rows: rows.map((row) => [
                    row.name,
                    row.email,
                    row.role,
                    row.status,
                    row.institutionName || 'System',
                    row.studentId || '-',
                    formatDisplayDate(row.updatedAt),
                ]),
            };
        }
        case 'audits': {
            const rows = (scopedInstitutionId
                ? listInstitutionAuditLogs(db, scopedInstitutionId, { limit: 1000 })
                : listAuditLogs(db, { limit: 500 }))
                .filter((row) => row.createdAt >= from && row.createdAt <= to);
            return {
                title: 'Audit Log Report',
                subtitle: `Audit events from ${from} to ${to}`,
                headers: ['When', 'Actor', 'Action', 'Entity', 'ID', 'Details'],
                rows: rows.map((row) => [
                    formatDisplayDate(row.createdAt),
                    row.actorName || 'System',
                    row.action,
                    row.entityType,
                    row.entityId,
                    clampText(JSON.stringify(row.details), 80),
                ]),
            };
        }
        case 'verifications':
        default: {
            const rows = db.prepare(`
                SELECT
                    v.certificateId,
                    v.result,
                    v.reason,
                    verifier.name AS verifierName,
                    v.certificateStudentName,
                    v.certificateInstitution,
                    v.verifiedAt
                FROM verification_events v
                LEFT JOIN users verifier ON verifier.id = v.verifierUserId
                WHERE v.verifiedAt BETWEEN ? AND ?
                  AND (
                    ? IS NULL OR v.certificateId IN (
                        SELECT certificateId
                        FROM certificate_issuance_events
                        WHERE institutionId = ?
                    )
                  )
                ORDER BY v.verifiedAt DESC
            `).all(from, to, scopedInstitutionId, scopedInstitutionId) as Record<string, unknown>[];
            return {
                title: 'Verification Activity Report',
                subtitle: `Verification activity from ${from} to ${to}`,
                headers: ['Certificate', 'Result', 'Reason', 'Verifier', 'Student', 'Institution', 'Verified At'],
                rows: rows.map((row) => [
                    String(row.certificateId),
                    String(row.result),
                    String(row.reason),
                    asTrimmedString(row.verifierName) || 'Unknown',
                    asTrimmedString(row.certificateStudentName) || 'Unknown',
                    asTrimmedString(row.certificateInstitution) || 'Unknown',
                    formatDisplayDate(String(row.verifiedAt)),
                ]),
            };
        }
    }
}

function reportFilename(type: ReportType, format: ReportFormat): string {
    const extension = format === 'pdf' ? 'pdf' : 'csv';
    return `${type}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

function normalizeCreateInstitutionInput(body: unknown): {
    name: string;
    code: string | null;
    type: InstitutionType;
    contactEmail: string | null;
} {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
        name: asTrimmedString(record.name),
        code: asOptionalTrimmedString(record.code),
        type: normalizeInstitutionType(record.type),
        contactEmail: asOptionalTrimmedString(record.contactEmail),
    };
}

function normalizeCreateUserInput(body: unknown): {
    name: string;
    email: string;
    password: string;
    role: AppRole | null;
    institutionId: string | null;
    studentId: string | null;
} {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
        name: asTrimmedString(record.name),
        email: asTrimmedString(record.email),
        password: asTrimmedString(record.password),
        role: normalizeRole(record.role),
        institutionId: asOptionalTrimmedString(record.institutionId),
        studentId: asOptionalTrimmedString(record.studentId),
    };
}

function normalizeCreateCourseInput(body: unknown): {
    title: string;
    description: string;
    duration: string;
    totalLessons: number;
} {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
        title: asTrimmedString(record.title),
        description: asTrimmedString(record.description),
        duration: asTrimmedString(record.duration),
        totalLessons: Math.max(0, asInteger(record.totalLessons, 0)),
    };
}

function normalizeUpdateCourseInput(body: unknown): {
    title: string | null;
    description: string | null;
    duration: string | null;
    totalLessons: number | null;
    status: CourseStatus | null;
} {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
        title: asOptionalTrimmedString(record.title),
        description: asOptionalTrimmedString(record.description),
        duration: asOptionalTrimmedString(record.duration),
        totalLessons: asNumber(record.totalLessons) == null ? null : Math.max(0, asInteger(record.totalLessons)),
        status: normalizeCourseStatus(record.status),
    };
}

function normalizeCreateEnrollmentInput(body: unknown): {
    studentUserId: string;
} {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
        studentUserId: asTrimmedString(record.studentUserId),
    };
}

function normalizeUpdateEnrollmentInput(body: unknown): {
    progressPercent: number | null;
    completedLessons: number | null;
    totalLessons: number | null;
    finalGrade: string | null;
    status: EnrollmentStatus | null;
} {
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
        progressPercent: asNumber(record.progressPercent) == null ? null : clampInteger(asInteger(record.progressPercent), 0, 100),
        completedLessons: asNumber(record.completedLessons) == null ? null : Math.max(0, asInteger(record.completedLessons)),
        totalLessons: asNumber(record.totalLessons) == null ? null : Math.max(0, asInteger(record.totalLessons)),
        finalGrade: asOptionalTrimmedString(record.finalGrade),
        status: normalizeEnrollmentStatus(record.status),
    };
}

function generatedCertificateId(): string {
    return `CERT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

async function issueCertificateRecord(db: DatabaseSync, contract: Contract, requester: AppUser, input: IssueCertificateInput, options?: {
    institutionId?: string | null;
    courseId?: string | null;
    enrollmentId?: string | null;
}): Promise<{ certificate: LedgerCertificate; issuance: CertificateIssuanceEvent }> {
    const institution = options?.institutionId
        ? getInstitutionRecordById(db, options.institutionId)
        : requester.institutionId
            ? getInstitutionRecordById(db, requester.institutionId)
            : getInstitutionRecordByName(db, input.university);
    if (institution && institution.status !== 'active') {
        throw new Error('Certificates cannot be issued for a suspended institution.');
    }

    const hash = computeCertificateHash(input);
    await contract.submitTransaction(
        'IssueCertificate',
        input.id,
        input.studentId,
        input.studentName,
        input.degree,
        input.university,
        input.graduationDate,
        hash,
    );

    const issuance = insertIssuanceEvent(db, {
        certificateId: input.id,
        hash,
        studentId: input.studentId,
        issuerUserId: requester.id,
        institutionId: institution?.id ?? requester.institutionId ?? null,
        courseId: options?.courseId ?? null,
        enrollmentId: options?.enrollmentId ?? null,
    });
    insertAuditLog(db, {
        actorUserId: requester.id,
        action: 'certificate.issue',
        entityType: 'certificate',
        entityId: input.id,
        details: {
            hash,
            institutionId: issuance.institutionId,
            studentId: input.studentId,
            courseId: issuance.courseId,
            enrollmentId: issuance.enrollmentId,
        },
    });

    return {
        certificate: {
            ...input,
            hash,
            isRevoked: false,
        },
        issuance,
    };
}

async function main() {
    await validateStartupEnvironment();
    const db = await ensureDatabaseReady(operationsDbPath);
    await seedOperationalData(db);
    let contract = null as unknown as Contract;

    if (fabricEnabled) {
        console.log('Connecting to Fabric network...');
        const client = await newGrpcConnection();
        const gateway = connect({
            client,
            identity: await newIdentity(),
            signer: await newSigner(),
            evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
            endorseOptions: () => ({ deadline: Date.now() + 15000 }),
            submitOptions: () => ({ deadline: Date.now() + 5000 }),
            commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
        });
        const network = gateway.getNetwork(channelName);
        contract = network.getContract(chaincodeName);
    } else {
        console.log(`Fabric connection disabled. Bridge running in ${bridgeLedgerMode} proxy mode.`);
    }

    try {
        const authMiddleware = authenticate(db);

        app.get('/health', async (_req, res) => {
            const gatewayReachable = await maybeGatewayHealth();
            if (!contract) {
                res.json({
                    status: gatewayReachable ? 'ok' : 'degraded',
                    channel: channelName,
                    chaincode: chaincodeName,
                    database: operationsDbPath,
                    gateway: gatewayBaseUrl,
                    gatewayReachable,
                    ledgerMode: bridgeLedgerMode,
                    fabricEnabled: false,
                    timestamp: nowIso(),
                });
                return;
            }
            try {
                await contract.evaluateTransaction('GetAllCertificates');
                res.json({
                    status: 'ok',
                    channel: channelName,
                    chaincode: chaincodeName,
                    database: operationsDbPath,
                    gateway: gatewayBaseUrl,
                    gatewayReachable,
                    ledgerMode: bridgeLedgerMode,
                    fabricEnabled: true,
                    timestamp: nowIso(),
                });
            } catch (error) {
                const message = extractErrorMessage(error);
                const statusCode = gatewayReachable ? 200 : mapFabricErrorStatus(message);
                res.status(statusCode).json({
                    status: gatewayReachable ? 'degraded' : 'error',
                    error: message,
                    channel: channelName,
                    chaincode: chaincodeName,
                    database: operationsDbPath,
                    gateway: gatewayBaseUrl,
                    gatewayReachable,
                    ledgerMode: bridgeLedgerMode,
                    fabricEnabled: true,
                    timestamp: nowIso(),
                });
            }
        });

        app.post('/api/v1/verify/hash', async (req, res) => {
            try {
                const response = await gatewayProxyRequest('/api/v1/verify/hash', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        credentialId: asOptionalTrimmedString(req.body?.credentialId),
                        hash: asTrimmedString(req.body?.hash),
                    }),
                });
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.get('/api/v1/verify/:qrToken', async (req, res) => {
            const qrToken = asTrimmedString(req.params.qrToken);
            if (!qrToken) {
                res.status(400).json({ error: 'QR token is required.' });
                return;
            }
            try {
                const response = await gatewayProxyRequest(`/api/v1/verify/${encodeURIComponent(qrToken)}`);
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.post('/api/v1/verify/upload-pdf', async (req, res) => {
            try {
                const body = await readRawRequestBody(req);
                const contentType = typeof req.headers['content-type'] === 'string'
                    ? req.headers['content-type']
                    : 'application/pdf';
                const response = await gatewayProxyRequest('/api/v1/verify/upload-pdf', {
                    method: 'POST',
                    headers: { 'content-type': contentType },
                    body: new Uint8Array(body),
                });
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.post('/auth/login', async (req, res) => {
            const email = asTrimmedString(req.body?.email);
            const password = asTrimmedString(req.body?.password);
            const role = normalizeRole(req.body?.role);
            const studentId = asOptionalTrimmedString(req.body?.studentId);

            if (!email || !password) {
                res.status(400).json({ error: 'email and password are required.' });
                return;
            }

            const userRecord = getUserRecordByEmail(db, email);
            if (!userRecord || !verifyPassword(password, userRecord.passwordHash)) {
                res.status(401).json({ error: 'Invalid email or password.' });
                return;
            }
            if (role && userRecord.role !== role) {
                res.status(403).json({ error: `This account is registered as ${userRecord.role}.` });
                return;
            }
            if (userRecord.role === 'student' && userRecord.studentId && studentId !== userRecord.studentId) {
                res.status(403).json({ error: 'Student ID does not match this account.' });
                return;
            }
            if (userRecord.status !== 'active') {
                res.status(403).json({ error: 'This user account is suspended.' });
                return;
            }
            if (userRecord.institutionId) {
                const institution = getInstitutionRecordById(db, userRecord.institutionId);
                if (institution && institution.status !== 'active' && ISSUER_ROLES.includes(userRecord.role)) {
                    res.status(403).json({ error: 'Your institution is suspended.' });
                    return;
                }
            }

            insertAuditLog(db, {
                actorUserId: userRecord.id,
                action: 'auth.login',
                entityType: 'user',
                entityId: userRecord.id,
                details: { email: userRecord.email, role: userRecord.role },
            });

            const user = sanitizeUser(userRecord);
            const gatewayToken = await loginToGateway({ email, password });
            res.json({
                token: buildUserToken(user, gatewayToken),
                user,
            });
        });

        app.get('/auth/me', authMiddleware, async (req, res) => {
            res.json({ user: (req as AuthenticatedRequest).user });
        });

        app.get('/api/v1/me/credentials', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for privacy-first credentials endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, '/api/v1/me/credentials');
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.get('/api/v1/me/credentials/:id', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const credentialId = asTrimmedString(req.params.id);
            if (!credentialId) {
                res.status(400).json({ error: 'Credential id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for privacy-first credential endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/me/credentials/${encodeURIComponent(credentialId)}`);
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.get('/api/v1/me/credentials/:id/pdf', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const credentialId = asTrimmedString(req.params.id);
            if (!credentialId) {
                res.status(400).json({ error: 'Credential id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for privacy-first PDF endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/me/credentials/${encodeURIComponent(credentialId)}/pdf`, {
                    headers: { accept: 'application/pdf' },
                });
                if (!response.ok) {
                    const payload = await response.json().catch(() => ({ error: 'Failed to download credential PDF.' }));
                    res.status(response.status).json(payload);
                    return;
                }

                const arrayBuffer = await response.arrayBuffer();
                res.setHeader('content-type', response.headers.get('content-type') || 'application/pdf');
                res.setHeader('content-disposition', response.headers.get('content-disposition') || 'attachment; filename="credential.pdf"');
                res.send(Buffer.from(arrayBuffer));
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.get('/api/v1/institutions/:id/credentials', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const institutionId = asTrimmedString(req.params.id);
            if (!institutionId) {
                res.status(400).json({ error: 'Institution id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for institution credentials endpoint.' });
                return;
            }

            try {
                const gatewayInstitutionId = await resolveGatewayInstitutionId(db, authenticatedRequest, institutionId);
                const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/institutions/${encodeURIComponent(gatewayInstitutionId)}/credentials`);
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.post('/api/v1/credentials', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for credentials endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, '/api/v1/credentials', {
                    method: 'POST',
                    body: JSON.stringify(req.body ?? {}),
                });
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.get('/api/v1/credentials/:id', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const credentialId = asTrimmedString(req.params.id);
            if (!credentialId) {
                res.status(400).json({ error: 'Credential id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for credential endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/credentials/${encodeURIComponent(credentialId)}`);
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.get('/api/v1/credentials/:id/ledger-status', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const credentialId = asTrimmedString(req.params.id);
            if (!credentialId) {
                res.status(400).json({ error: 'Credential id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for ledger status endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(
                    authenticatedRequest,
                    `/api/v1/credentials/${encodeURIComponent(credentialId)}/ledger-status`,
                );
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.post('/api/v1/credentials/:id/issue', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const credentialId = asTrimmedString(req.params.id);
            if (!credentialId) {
                res.status(400).json({ error: 'Credential id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for credential issue endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/credentials/${encodeURIComponent(credentialId)}/issue`, {
                    method: 'POST',
                });
                const payload = await response.json();
                if (response.ok) {
                    const requester = authenticatedRequest.user;
                    const projection = payload?.credential && typeof payload.credential === 'object'
                        ? payload.credential as Record<string, unknown>
                        : null;
                    const issuedCertificateId = asTrimmedString(projection?.credentialId) || credentialId;
                    const issuedHash = asTrimmedString(projection?.hash);
                    const existingIssuance = getIssuanceEventByCertificateId(db, issuedCertificateId);

                    if (issuedHash && !existingIssuance) {
                        try {
                            const detailResponse = await gatewayJsonRequest(authenticatedRequest, `/api/v1/credentials/${encodeURIComponent(issuedCertificateId)}`);
                            const detailPayload = await detailResponse.json();
                            const studentId = asTrimmedString(detailPayload?.studentId);
                            if (requester && studentId) {
                                insertIssuanceEvent(db, {
                                    certificateId: issuedCertificateId,
                                    hash: issuedHash,
                                    studentId,
                                    issuerUserId: requester.id,
                                    institutionId: requester.institutionId ?? null,
                                });
                            }
                        } catch (error) {
                            console.warn('Failed to persist local issuance event for canonical credential issue:', extractErrorMessage(error));
                        }
                    }
                }
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.post('/api/v1/credentials/:id/revoke', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const credentialId = asTrimmedString(req.params.id);
            if (!credentialId) {
                res.status(400).json({ error: 'Credential id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for credential revoke endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/credentials/${encodeURIComponent(credentialId)}/revoke`, {
                    method: 'POST',
                    body: JSON.stringify(req.body ?? {}),
                });
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.post('/api/v1/credentials/:id/reissue', authMiddleware, async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const credentialId = asTrimmedString(req.params.id);
            if (!credentialId) {
                res.status(400).json({ error: 'Credential id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for credential reissue endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/credentials/${encodeURIComponent(credentialId)}/reissue`, {
                    method: 'POST',
                    body: JSON.stringify(req.body ?? {}),
                });
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.get('/api/v1/tx/pending', authMiddleware, requireRoles('super_admin'), async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for transaction queue endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, '/api/v1/tx/pending');
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.post('/api/v1/tx/:id/reconcile', authMiddleware, requireRoles('super_admin'), async (req, res) => {
            const authenticatedRequest = req as AuthenticatedRequest;
            const txId = asTrimmedString(req.params.id);
            if (!txId) {
                res.status(400).json({ error: 'Transaction id is required.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for transaction reconcile endpoint.' });
                return;
            }

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/tx/${encodeURIComponent(txId)}/reconcile`, {
                    method: 'POST',
                });
                const payload = await response.json();
                res.status(response.status).json(payload);
            } catch (error) {
                res.status(502).json({ error: extractErrorMessage(error) || 'Failed to reach gateway.' });
            }
        });

        app.get(['/api/dashboard/ministry/summary', '/api/v1/dashboard/ministry/summary'], authMiddleware, requireRoles('ministry_admin', 'super_admin'), async (_req, res) => {
            const summary = await buildMinistryDashboardSummary(db, contract);
            res.json(summary);
        });

        app.get(['/api/dashboard/verifier/summary', '/api/v1/dashboard/verifier/summary'], authMiddleware, requireRoles('certificate_verifier', 'super_admin'), async (_req, res) => {
            const summary = await buildVerifierDashboardSummary(db, contract);
            res.json(summary);
        });

        app.get(['/api/institutions', '/api/v1/institutions'], authMiddleware, requireRoles('ministry_admin', 'super_admin', 'school_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const includeSystem = asBoolean(req.query.includeSystem);
            const search = asTrimmedString(req.query.search);
            const status = normalizeInstitutionStatus(req.query.status);
            let institutions = listInstitutions(db, { includeSystem, search, status });
            if (requester.role === 'school_admin' && requester.institutionId) {
                institutions = institutions.filter((item) => item.id === requester.institutionId);
            }
            res.json(institutions);
        });

        app.post(['/api/institutions', '/api/v1/institutions'], authMiddleware, requireRoles('super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const input = normalizeCreateInstitutionInput(req.body);
            if (!input.name) {
                res.status(400).json({ error: 'name is required.' });
                return;
            }
            if (getInstitutionRecordByName(db, input.name) || (input.code && getInstitutionRecordByName(db, input.code))) {
                res.status(409).json({ error: 'Institution already exists.' });
                return;
            }

            const institution = createInstitution(db, input);
            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'institution.create',
                entityType: 'institution',
                entityId: institution.id,
                details: { name: institution.name, code: institution.code, type: institution.type },
            });
            res.status(201).json(institution);
        });

        app.patch(['/api/institutions/:id', '/api/v1/institutions/:id'], authMiddleware, requireRoles('super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const institution = getInstitutionRecordById(db, asTrimmedString(req.params.id));
            if (!institution) {
                res.status(404).json({ error: 'Institution not found.' });
                return;
            }

            const name = asTrimmedString(req.body?.name) || institution.name;
            const code = asTrimmedString(req.body?.code) || institution.code;
            const status = normalizeInstitutionStatus(req.body?.status) || institution.status;
            const type = normalizeInstitutionType(req.body?.type || institution.type);
            const contactEmail = asOptionalTrimmedString(req.body?.contactEmail) ?? institution.contactEmail;
            const updatedAt = nowIso();

            db.prepare(`
                UPDATE institutions
                SET name = ?, code = ?, status = ?, type = ?, contactEmail = ?, updatedAt = ?
                WHERE id = ?
            `).run(name, code, status, type, contactEmail, updatedAt, institution.id);

            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'institution.update',
                entityType: 'institution',
                entityId: institution.id,
                details: { name, code, status, type },
            });

            res.json(getInstitutionRecordById(db, institution.id));
        });

        app.get('/api/v1/institutions/:id/settings', authMiddleware, requireRoles('school_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const institutionId = asTrimmedString(req.params.id);
            if (!institutionId) {
                res.status(400).json({ error: 'Institution id is required.' });
                return;
            }
            if (requester.role === 'school_admin' && requester.institutionId !== institutionId) {
                res.status(403).json({ error: 'Access denied: this institution is outside your scope.' });
                return;
            }
            const settings = getInstitutionSettings(db, institutionId);
            if (!settings) {
                res.status(404).json({ error: 'Institution not found.' });
                return;
            }
            res.json(settings);
        });

        app.patch('/api/v1/institutions/:id/settings', authMiddleware, requireRoles('school_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const institutionId = asTrimmedString(req.params.id);
            if (!institutionId) {
                res.status(400).json({ error: 'Institution id is required.' });
                return;
            }
            if (requester.role === 'school_admin' && requester.institutionId !== institutionId) {
                res.status(403).json({ error: 'Access denied: this institution is outside your scope.' });
                return;
            }
            const institution = getInstitutionRecordById(db, institutionId);
            if (!institution) {
                res.status(404).json({ error: 'Institution not found.' });
                return;
            }
            const current = getInstitutionSettings(db, institutionId);
            const next = normalizeInstitutionSettings(institution, req.body, current);
            if (!next.general.schoolName) {
                res.status(400).json({ error: 'general.schoolName is required.' });
                return;
            }
            if (!next.general.schoolCode) {
                res.status(400).json({ error: 'general.schoolCode is required.' });
                return;
            }

            const duplicateInstitution = getInstitutionRecordByName(db, next.general.schoolName);
            if (duplicateInstitution && duplicateInstitution.id !== institution.id) {
                res.status(409).json({ error: 'Another institution already uses this name or code.' });
                return;
            }
            const duplicateCode = mapRow<{ id: string }>(db.prepare(`
                SELECT id
                FROM institutions
                WHERE lower(code) = lower(?)
                  AND id != ?
                LIMIT 1
            `).get(next.general.schoolCode, institution.id));
            if (duplicateCode) {
                res.status(409).json({ error: 'Another institution already uses this code.' });
                return;
            }

            const updatedAt = nowIso();
            db.prepare(`
                UPDATE institutions
                SET name = ?, code = ?, contactEmail = ?, updatedAt = ?
                WHERE id = ?
            `).run(
                next.general.schoolName,
                next.general.schoolCode,
                next.general.email || null,
                updatedAt,
                institution.id,
            );

            const saved = upsertInstitutionSettings(db, institution.id, {
                ...next,
                general: {
                    ...next.general,
                    schoolName: next.general.schoolName,
                    schoolCode: next.general.schoolCode,
                    email: next.general.email,
                },
                updatedAt,
            });

            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'institution.settings.update',
                entityType: 'institution',
                entityId: institution.id,
                details: {
                    schoolName: saved.general.schoolName,
                    schoolCode: saved.general.schoolCode,
                },
            });

            res.json(saved);
        });

        app.get(['/api/users', '/api/v1/users'], authMiddleware, requireRoles('school_admin', 'ministry_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const role = normalizeRole(req.query.role);
            const status = normalizeUserStatus(req.query.status);
            const institutionIdQuery = asOptionalTrimmedString(req.query.institutionId);
            const search = asTrimmedString(req.query.search);
            const institutionId = requester.role === 'school_admin' ? requester.institutionId : institutionIdQuery;
            const users = listUsers(db, {
                role,
                status,
                institutionId,
                search,
            });
            res.json(users);
        });

        app.post(['/api/users', '/api/v1/users'], authMiddleware, requireRoles('school_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const input = normalizeCreateUserInput(req.body);
            if (!input.name || !input.email || !input.password || !input.role) {
                res.status(400).json({ error: 'name, email, password, and role are required.' });
                return;
            }
            if (!canManageRole(requester, input.role)) {
                res.status(403).json({ error: 'You cannot create this role.' });
                return;
            }
            if (getUserRecordByEmail(db, input.email)) {
                res.status(409).json({ error: 'A user with this email already exists.' });
                return;
            }

            let institutionId = input.institutionId;
            if (requester.role === 'school_admin') {
                institutionId = requester.institutionId;
            }
            if ((input.role === 'teacher' || input.role === 'school_admin' || input.role === 'student' || input.role === 'certificate_verifier') && !institutionId) {
                res.status(400).json({ error: 'institutionId is required for institution-scoped users.' });
                return;
            }
            if (input.role === 'student' && !input.studentId) {
                res.status(400).json({ error: 'studentId is required for students.' });
                return;
            }
            if (institutionId) {
                const institution = getInstitutionRecordById(db, institutionId);
                if (!institution) {
                    res.status(404).json({ error: 'Institution not found.' });
                    return;
                }
            }

            const user = createUser(db, {
                name: input.name,
                email: input.email,
                password: input.password,
                role: input.role,
                institutionId,
                studentId: input.studentId,
            });
            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'user.create',
                entityType: 'user',
                entityId: user.id,
                details: { email: user.email, role: user.role, institutionId: user.institutionId },
            });
            res.status(201).json(user);
        });

        app.patch(['/api/users/:id', '/api/v1/users/:id'], authMiddleware, requireRoles('school_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const userRecord = getUserRecordById(db, asTrimmedString(req.params.id));
            if (!userRecord) {
                res.status(404).json({ error: 'User not found.' });
                return;
            }
            if (requester.role === 'school_admin' && requester.institutionId !== userRecord.institutionId) {
                res.status(403).json({ error: 'You can only manage users in your institution.' });
                return;
            }
            if (!canManageRole(requester, userRecord.role) && requester.id !== userRecord.id) {
                res.status(403).json({ error: 'You cannot manage this user.' });
                return;
            }

            const name = asTrimmedString(req.body?.name) || userRecord.name;
            const status = normalizeUserStatus(req.body?.status) || userRecord.status;
            const institutionIdRaw = asOptionalTrimmedString(req.body?.institutionId);
            const institutionId = requester.role === 'school_admin' ? requester.institutionId : institutionIdRaw ?? userRecord.institutionId;
            const studentId = asOptionalTrimmedString(req.body?.studentId) ?? userRecord.studentId;
            const updatedAt = nowIso();

            if (institutionId) {
                const institution = getInstitutionRecordById(db, institutionId);
                if (!institution) {
                    res.status(404).json({ error: 'Institution not found.' });
                    return;
                }
            }

            db.prepare(`
                UPDATE users
                SET name = ?, status = ?, institutionId = ?, studentId = ?, updatedAt = ?
                WHERE id = ?
            `).run(name, status, institutionId, studentId, updatedAt, userRecord.id);

            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'user.update',
                entityType: 'user',
                entityId: userRecord.id,
                details: { name, status, institutionId, studentId },
            });
            res.json(sanitizeUser(getUserRecordById(db, userRecord.id)!));
        });

        app.post(['/api/users/:id/reset-password', '/api/v1/users/:id/reset-password'], authMiddleware, requireRoles('school_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const userRecord = getUserRecordById(db, asTrimmedString(req.params.id));
            if (!userRecord) {
                res.status(404).json({ error: 'User not found.' });
                return;
            }
            if (requester.role === 'school_admin' && requester.institutionId !== userRecord.institutionId) {
                res.status(403).json({ error: 'You can only manage users in your institution.' });
                return;
            }

            const newPassword = asTrimmedString(req.body?.newPassword) || crypto.randomBytes(6).toString('base64url');
            const passwordHash = hashPassword(newPassword);
            db.prepare('UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?').run(passwordHash, nowIso(), userRecord.id);
            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'user.reset-password',
                entityType: 'user',
                entityId: userRecord.id,
                details: { email: userRecord.email },
            });
            res.json({ userId: userRecord.id, temporaryPassword: newPassword });
        });

        app.get('/api/v1/institutions/:id/courses', authMiddleware, requireRoles('school_admin', 'ministry_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const institutionId = asTrimmedString(req.params.id);
            if (!institutionId) {
                res.status(400).json({ error: 'Institution id is required.' });
                return;
            }
            if (requester.role === 'school_admin' && requester.institutionId !== institutionId) {
                res.status(403).json({ error: 'Access denied: this institution is outside your scope.' });
                return;
            }
            const institution = getInstitutionRecordById(db, institutionId);
            if (!institution) {
                res.status(404).json({ error: 'Institution not found.' });
                return;
            }

            const status = normalizeCourseStatus(req.query.status);
            const search = asTrimmedString(req.query.search);
            res.json(listCoursesByInstitution(db, institutionId, { status, search }));
        });

        app.post('/api/v1/institutions/:id/courses', authMiddleware, requireRoles('school_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const institutionId = requester.role === 'school_admin'
                ? requester.institutionId
                : asTrimmedString(req.params.id);
            if (!institutionId) {
                res.status(400).json({ error: 'Institution id is required.' });
                return;
            }
            if (requester.role === 'school_admin' && requester.institutionId !== institutionId) {
                res.status(403).json({ error: 'Access denied: this institution is outside your scope.' });
                return;
            }
            const institution = getInstitutionRecordById(db, institutionId);
            if (!institution) {
                res.status(404).json({ error: 'Institution not found.' });
                return;
            }

            const input = normalizeCreateCourseInput(req.body);
            const teacherUserId = asTrimmedString(req.body?.teacherUserId);
            if (!input.title) {
                res.status(400).json({ error: 'title is required.' });
                return;
            }
            if (!teacherUserId) {
                res.status(400).json({ error: 'teacherUserId is required.' });
                return;
            }

            const teacher = getUserRecordById(db, teacherUserId);
            if (!teacher || teacher.role !== 'teacher') {
                res.status(404).json({ error: 'Teacher not found.' });
                return;
            }
            if (teacher.institutionId !== institutionId) {
                res.status(403).json({ error: 'Teacher belongs to a different institution.' });
                return;
            }
            const duplicate = findCourseForTeacherByTitle(db, teacherUserId, input.title);
            if (duplicate) {
                res.status(409).json({ error: 'A course with this title already exists for the selected teacher.' });
                return;
            }

            const course = createCourseRecord(db, {
                teacherUserId,
                institutionId,
                title: input.title,
                description: input.description,
                duration: input.duration,
                totalLessons: input.totalLessons,
            });
            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'institution.course.create',
                entityType: 'course',
                entityId: course.id,
                details: { title: course.title, institutionId, teacherUserId },
            });
            res.status(201).json(course);
        });

        app.patch('/api/v1/courses/:id', authMiddleware, requireRoles('school_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const course = getCourseById(db, asTrimmedString(req.params.id));
            if (!course) {
                res.status(404).json({ error: 'Course not found.' });
                return;
            }
            if (requester.role === 'school_admin' && requester.institutionId !== course.institutionId) {
                res.status(403).json({ error: 'Access denied: this course is outside your institution.' });
                return;
            }

            const input = normalizeUpdateCourseInput(req.body);
            const nextTeacherUserId = asOptionalTrimmedString(req.body?.teacherUserId) ?? course.teacherUserId;
            const teacher = getUserRecordById(db, nextTeacherUserId);
            if (!teacher || teacher.role !== 'teacher') {
                res.status(404).json({ error: 'Teacher not found.' });
                return;
            }
            if (teacher.institutionId !== course.institutionId) {
                res.status(403).json({ error: 'Teacher belongs to a different institution.' });
                return;
            }

            const nextTitle = input.title ?? course.title;
            const nextDescription = input.description ?? course.description;
            const nextDuration = input.duration ?? course.duration;
            const nextTotalLessons = input.totalLessons ?? course.totalLessons;
            const nextStatus = input.status ?? course.status;
            const duplicate = findCourseForTeacherByTitle(db, nextTeacherUserId, nextTitle);
            if (duplicate && duplicate.id !== course.id) {
                res.status(409).json({ error: 'A course with this title already exists for the selected teacher.' });
                return;
            }

            db.prepare(`
                UPDATE courses
                SET title = ?, description = ?, duration = ?, totalLessons = ?, status = ?, teacherUserId = ?, updatedAt = ?
                WHERE id = ?
            `).run(
                nextTitle,
                nextDescription,
                nextDuration,
                nextTotalLessons,
                nextStatus,
                nextTeacherUserId,
                nowIso(),
                course.id,
            );

            insertAuditLog(db, {
                actorUserId: requester.id,
                action: nextStatus === 'archived' ? 'institution.course.archive' : 'institution.course.update',
                entityType: 'course',
                entityId: course.id,
                details: { title: nextTitle, status: nextStatus, teacherUserId: nextTeacherUserId },
            });
            res.json(getCourseById(db, course.id));
        });

        app.get('/api/teacher/dashboard/summary', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            res.json(buildTeacherDashboardSummary(db, requester));
        });

        app.get('/api/teacher/courses', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const status = normalizeCourseStatus(req.query.status);
            const search = asTrimmedString(req.query.search);
            res.json(listCoursesByTeacher(db, requester.id, { status, search }));
        });

        app.post('/api/teacher/courses', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            if (!requester.institutionId) {
                res.status(400).json({ error: 'Teacher account is missing institution assignment.' });
                return;
            }

            const input = normalizeCreateCourseInput(req.body);
            if (!input.title) {
                res.status(400).json({ error: 'title is required.' });
                return;
            }

            const duplicate = findCourseForTeacherByTitle(db, requester.id, input.title);
            if (duplicate) {
                res.status(409).json({ error: 'A course with this title already exists for the current teacher.' });
                return;
            }

            const course = createCourseRecord(db, {
                teacherUserId: requester.id,
                institutionId: requester.institutionId,
                title: input.title,
                description: input.description,
                duration: input.duration,
                totalLessons: input.totalLessons,
            });
            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'teacher.course.create',
                entityType: 'course',
                entityId: course.id,
                details: { title: course.title, totalLessons: course.totalLessons },
            });
            res.status(201).json(course);
        });

        app.patch('/api/teacher/courses/:id', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const course = getCourseById(db, asTrimmedString(req.params.id));
            if (!course || course.teacherUserId !== requester.id) {
                res.status(404).json({ error: 'Course not found.' });
                return;
            }

            const input = normalizeUpdateCourseInput(req.body);
            const nextTitle = input.title ?? course.title;
            const nextDescription = input.description ?? course.description;
            const nextDuration = input.duration ?? course.duration;
            const nextTotalLessons = input.totalLessons ?? course.totalLessons;
            const nextStatus = input.status ?? course.status;

            const duplicate = findCourseForTeacherByTitle(db, requester.id, nextTitle);
            if (duplicate && duplicate.id !== course.id) {
                res.status(409).json({ error: 'A course with this title already exists for the current teacher.' });
                return;
            }

            db.prepare(`
                UPDATE courses
                SET title = ?, description = ?, duration = ?, totalLessons = ?, status = ?, updatedAt = ?
                WHERE id = ?
            `).run(
                nextTitle,
                nextDescription,
                nextDuration,
                nextTotalLessons,
                nextStatus,
                nowIso(),
                course.id,
            );

            insertAuditLog(db, {
                actorUserId: requester.id,
                action: nextStatus === 'archived' ? 'teacher.course.archive' : 'teacher.course.update',
                entityType: 'course',
                entityId: course.id,
                details: { title: nextTitle, status: nextStatus, totalLessons: nextTotalLessons },
            });

            res.json(getCourseById(db, course.id));
        });

        app.get('/api/teacher/courses/:id/enrollments', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const course = getCourseById(db, asTrimmedString(req.params.id));
            if (!course || course.teacherUserId !== requester.id) {
                res.status(404).json({ error: 'Course not found.' });
                return;
            }

            const search = asTrimmedString(req.query.search);
            res.json(listTeacherEnrollments(db, { teacherUserId: requester.id, courseId: course.id, search }));
        });

        app.post('/api/teacher/courses/:id/enrollments', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const course = getCourseById(db, asTrimmedString(req.params.id));
            if (!course || course.teacherUserId !== requester.id) {
                res.status(404).json({ error: 'Course not found.' });
                return;
            }
            if (course.status !== 'active') {
                res.status(400).json({ error: 'Students can only be enrolled into active courses.' });
                return;
            }

            const input = normalizeCreateEnrollmentInput(req.body);
            if (!input.studentUserId) {
                res.status(400).json({ error: 'studentUserId is required.' });
                return;
            }

            const studentRecord = getUserRecordById(db, input.studentUserId);
            if (!studentRecord || studentRecord.role !== 'student') {
                res.status(404).json({ error: 'Student not found.' });
                return;
            }
            if (studentRecord.status !== 'active') {
                res.status(400).json({ error: 'Only active students can be enrolled.' });
                return;
            }
            if (studentRecord.institutionId !== course.institutionId) {
                res.status(403).json({ error: 'Student belongs to a different institution.' });
                return;
            }

            const existing = findEnrollmentRecord(db, course.id, studentRecord.id);
            if (existing) {
                res.status(409).json({ error: 'This student is already enrolled in the course.' });
                return;
            }

            const enrollment = createEnrollmentRecord(db, {
                courseId: course.id,
                studentUserId: studentRecord.id,
                progressPercent: 0,
                completedLessons: 0,
                totalLessons: course.totalLessons,
                status: 'active',
            });

            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'teacher.enrollment.create',
                entityType: 'course_enrollment',
                entityId: enrollment.id,
                details: { courseId: course.id, studentUserId: studentRecord.id },
            });

            res.status(201).json(enrollment);
        });

        app.patch('/api/teacher/enrollments/:id', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const enrollment = getEnrollmentById(db, asTrimmedString(req.params.id));
            if (!enrollment) {
                res.status(404).json({ error: 'Enrollment not found.' });
                return;
            }
            const course = getCourseById(db, enrollment.courseId);
            if (!course || course.teacherUserId !== requester.id) {
                res.status(404).json({ error: 'Enrollment not found.' });
                return;
            }

            const input = normalizeUpdateEnrollmentInput(req.body);
            let totalLessons = input.totalLessons ?? enrollment.totalLessons;
            let completedLessons = input.completedLessons ?? enrollment.completedLessons;
            let progressPercent = input.progressPercent ?? enrollment.progressPercent;
            let status = input.status ?? enrollment.status;
            const finalGrade = input.finalGrade ?? enrollment.finalGrade;

            if (totalLessons <= 0) {
                totalLessons = course.totalLessons > 0 ? course.totalLessons : Math.max(totalLessons, completedLessons);
            }
            completedLessons = clampInteger(completedLessons, 0, Math.max(totalLessons, completedLessons));
            progressPercent = clampInteger(progressPercent, 0, 100);

            if (status === 'completed') {
                progressPercent = 100;
                if (totalLessons > 0) {
                    completedLessons = totalLessons;
                }
            }

            db.prepare(`
                UPDATE course_enrollments
                SET progressPercent = ?, completedLessons = ?, totalLessons = ?, finalGrade = ?, status = ?, updatedAt = ?
                WHERE id = ?
            `).run(
                progressPercent,
                completedLessons,
                totalLessons,
                finalGrade,
                status,
                nowIso(),
                enrollment.id,
            );

            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'teacher.enrollment.update',
                entityType: 'course_enrollment',
                entityId: enrollment.id,
                details: { progressPercent, completedLessons, totalLessons, finalGrade, status },
            });

            res.json(getEnrollmentById(db, enrollment.id));
        });

        app.post('/api/teacher/enrollments/:id/issue-certificate', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const authenticatedRequest = req as AuthenticatedRequest;
            const enrollment = getEnrollmentById(db, asTrimmedString(req.params.id));
            if (!enrollment) {
                res.status(404).json({ error: 'Enrollment not found.' });
                return;
            }
            const course = getCourseById(db, enrollment.courseId);
            if (!course || course.teacherUserId !== requester.id) {
                res.status(404).json({ error: 'Enrollment not found.' });
                return;
            }
            if (enrollment.status !== 'completed') {
                res.status(400).json({ error: 'Only completed enrollments are eligible for certificate issuance.' });
                return;
            }
            if (!enrollment.finalGrade) {
                res.status(400).json({ error: 'A final grade is required before submitting a credential for review.' });
                return;
            }
            if (enrollment.certificateIssued || enrollment.certificateId) {
                res.status(409).json({ error: 'A certificate has already been issued for this enrollment.' });
                return;
            }
            if (enrollment.reviewCredentialId) {
                res.status(409).json({ error: 'This enrollment has already been submitted to the institute review queue.' });
                return;
            }
            if (!authenticatedRequest.gatewayToken) {
                res.status(503).json({ error: 'Gateway token unavailable for credential review submission.' });
                return;
            }
            const institutionName = course.institutionName || requester.institutionName;
            if (!institutionName) {
                res.status(400).json({ error: 'Teacher institution could not be resolved.' });
                return;
            }

            const awardDate = asTrimmedString(req.body?.graduationDate) || new Date().toISOString().slice(0, 10);
            const credentialId = generatedCertificateId();

            try {
                const response = await gatewayJsonRequest(authenticatedRequest, '/api/v1/credentials', {
                    method: 'POST',
                    body: JSON.stringify({
                        id: credentialId,
                        institutionId: course.institutionId,
                        studentNumber: enrollment.studentId,
                        studentName: enrollment.studentName,
                        certificateNumber: credentialId,
                        title: course.title,
                        programName: course.title,
                        degree: course.title,
                        awardDate,
                        status: 'pending_review',
                    }),
                });
                const payload = await response.json().catch(() => ({ error: 'Failed to create credential review record.' }));
                if (!response.ok) {
                    res.status(response.status).json(payload);
                    return;
                }

                db.prepare(`
                    UPDATE course_enrollments
                    SET reviewCredentialId = ?, reviewSubmittedAt = ?, updatedAt = ?
                    WHERE id = ?
                `).run(
                    asOptionalTrimmedString((payload as Record<string, unknown>).credentialId) || asOptionalTrimmedString((payload as Record<string, unknown>).id) || credentialId,
                    nowIso(),
                    nowIso(),
                    enrollment.id,
                );

                insertAuditLog(db, {
                    actorUserId: requester.id,
                    action: 'teacher.enrollment.submit-review',
                    entityType: 'course_enrollment',
                    entityId: enrollment.id,
                    details: { courseId: course.id, credentialId, reviewStatus: 'pending_review' },
                });

                res.status(201).json({
                    enrollment: getEnrollmentById(db, enrollment.id),
                    certificate: payload,
                });
            } catch (error) {
                const message = extractErrorMessage(error);
                const status = message.includes('suspended institution') ? 403 : 502;
                res.status(status).json({ error: message });
            }
        });

        app.get('/api/teacher/students', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const search = asTrimmedString(req.query.search);
            res.json(listTeacherStudents(db, requester.id, search));
        });

        app.get('/api/teacher/student-directory', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            if (!requester.institutionId) {
                res.json([]);
                return;
            }
            const search = asTrimmedString(req.query.search);
            res.json(listUsers(db, {
                role: 'student',
                institutionId: requester.institutionId,
                status: 'active',
                search,
            }));
        });

        app.get('/api/teacher/certificates', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const search = asTrimmedString(req.query.search);
            const readyToIssue = listEligibleTeacherCertificates(db, requester.id, search);
            const issued = await listTeacherIssuedCertificates(db, contract, req as AuthenticatedRequest, requester);
            const filteredIssued = !search
                ? issued
                : issued.filter((item) => {
                    const needle = search.toLowerCase();
                    return item.studentName.toLowerCase().includes(needle)
                        || item.studentId.toLowerCase().includes(needle)
                        || item.courseTitle.toLowerCase().includes(needle)
                        || item.certificateId.toLowerCase().includes(needle);
                });
            res.json({
                readyToIssue,
                issued: filteredIssued,
            });
        });

        app.get('/api/teacher/analytics', authMiddleware, requireRoles('teacher'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            res.json(await buildTeacherAnalyticsSummary(db, contract, req as AuthenticatedRequest, requester));
        });

        app.post('/api/certificates', authMiddleware, requireRoles(...ISSUER_ROLES), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            if (requester.role === 'teacher') {
                res.status(403).json({ error: 'Teachers must submit credential-ready enrollments for institute review.' });
                return;
            }
            const input = normalizeIssueInput(req.body);
            const missingFields = getMissingIssueFields(input);
            if (missingFields.length > 0) {
                res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` });
                return;
            }

            const authenticatedRequest = req as AuthenticatedRequest;
            if (authenticatedRequest.gatewayToken) {
                try {
                    const response = await gatewayJsonRequest(authenticatedRequest, '/api/v1/issue', {
                        method: 'POST',
                        body: JSON.stringify(input),
                    });
                    const payload = await response.json();
                    if (response.ok) {
                        const hash = asTrimmedString((payload as Record<string, unknown>).hash) || computeCertificateHash(input);
                        res.status(201).json({
                            id: input.id,
                            studentId: input.studentId,
                            studentName: input.studentName,
                            degree: input.degree,
                            university: input.university,
                            graduationDate: input.graduationDate,
                            hash,
                            status: asTrimmedString((payload as Record<string, unknown>).status) || 'pending_anchor',
                        });
                        return;
                    }
                    res.status(response.status).json(payload);
                    return;
                } catch {
                    // fall through to legacy local issuance if gateway is unavailable
                }
            }

            try {
                const result = await issueCertificateRecord(db, contract, requester, input);
                res.status(201).json(result.certificate);
            } catch (error) {
                const message = extractErrorMessage(error);
                const status = message.includes('suspended institution') ? 403 : mapFabricErrorStatus(message);
                res.status(status).json({ error: message });
            }
        });

        app.get('/api/certificates/:id', authMiddleware, async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const certificateId = asTrimmedString(req.params.id);
            if (!certificateId) {
                res.status(400).json({ error: 'Certificate id is required.' });
                return;
            }

            const authenticatedRequest = req as AuthenticatedRequest;
            if (authenticatedRequest.gatewayToken) {
                try {
                    const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/certificates/${encodeURIComponent(certificateId)}`);
                    const payload = await response.json();
                    if (response.ok) {
                        const certificate = (payload as Record<string, unknown>).certificate ?? payload;
                        res.json(certificate);
                        return;
                    }
                    res.status(response.status).json(payload);
                    return;
                } catch {
                    // fall through to legacy local read if gateway is unavailable
                }
            }

            try {
                const resultBytes = await contract.evaluateTransaction('ReadCertificate', certificateId);
                const resultJson = Buffer.from(resultBytes).toString();
                const certificate = JSON.parse(resultJson) as LedgerCertificate;

                if (requester.role === 'student' && certificate.studentId !== requester.studentId) {
                    res.status(403).json({ error: 'Access denied: students can only access their own certificates.' });
                    return;
                }
                if ((requester.role === 'teacher' || requester.role === 'school_admin') && requester.institutionName && certificate.university !== requester.institutionName) {
                    res.status(403).json({ error: 'Access denied: this certificate belongs to another institution.' });
                    return;
                }
                if (requester.role === 'teacher') {
                    const issuance = getIssuanceEventByCertificateId(db, certificateId);
                    if (!issuance || issuance.issuerUserId !== requester.id) {
                        res.status(403).json({ error: 'Access denied: teachers can only access certificates issued from their own assigned enrollments.' });
                        return;
                    }
                }

                res.json(certificate);
            } catch (error) {
                const message = extractErrorMessage(error);
                res.status(mapFabricErrorStatus(message)).json({ error: message });
            }
        });

        app.get('/api/certificates', authMiddleware, async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            try {
                if (requester.role === 'student') {
                    res.status(403).json({ error: 'Students must use /api/students/:studentId/certificates.' });
                    return;
                }
                if (requester.role === 'teacher') {
                    res.status(403).json({ error: 'Teachers must use /api/teacher/certificates.' });
                    return;
                }

                const studentId = asTrimmedString(req.query.studentId);
                const certificates = filterCertificatesForRequester(await getAllCertificatesFromLedger(contract), requester);
                if (studentId) {
                    res.json(certificates.filter((cert) => cert.studentId === studentId));
                    return;
                }
                res.json(certificates);
            } catch (error) {
                const message = extractErrorMessage(error);
                res.status(mapFabricErrorStatus(message)).json({ error: message });
            }
        });

        app.get('/api/students/:studentId/certificates', authMiddleware, async (req, res) => {
            const studentId = asTrimmedString(req.params.studentId);
            if (!studentId) {
                res.status(400).json({ error: 'studentId is required.' });
                return;
            }

            const requester = (req as AuthenticatedRequest).user!;
            if (requester.role === 'teacher') {
                res.status(403).json({ error: 'Teachers must use /api/teacher/certificates.' });
                return;
            }
            if (requester.role === 'student') {
                if (!requester.studentId) {
                    res.status(403).json({ error: 'Access denied: student token has no studentId.' });
                    return;
                }
                if (requester.studentId !== studentId) {
                    res.status(403).json({ error: 'Access denied: students can only access their own certificates.' });
                    return;
                }
            }

            const authenticatedRequest = req as AuthenticatedRequest;
            if (authenticatedRequest.gatewayToken) {
                try {
                    const response = await gatewayJsonRequest(authenticatedRequest, `/api/v1/certificates/student/${encodeURIComponent(studentId)}`);
                    const payload = await response.json();
                    if (response.ok) {
                        const certificates = Array.isArray((payload as Record<string, unknown>).certificates)
                            ? (payload as Record<string, unknown>).certificates
                            : [];
                        res.json(certificates);
                        return;
                    }
                    res.status(response.status).json(payload);
                    return;
                } catch {
                    // fall through to legacy local path
                }
            }

            try {
                const certificates = filterCertificatesForRequester(await getAllCertificatesFromLedger(contract), requester);
                res.json(certificates.filter((cert) => cert.studentId === studentId));
            } catch (error) {
                const message = extractErrorMessage(error);
                res.status(mapFabricErrorStatus(message)).json({ error: message });
            }
        });

        app.post('/api/certificates/verify', authMiddleware, async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const id = asTrimmedString(req.body?.id);
            const hash = asTrimmedString(req.body?.hash);
            if (!id || !hash) {
                res.status(400).json({ error: 'Both id and hash are required.' });
                return;
            }

            const authenticatedRequest = req as AuthenticatedRequest;
            if (authenticatedRequest.gatewayToken) {
                try {
                    const response = await gatewayJsonRequest(authenticatedRequest, '/api/v1/verify/hash', {
                        method: 'POST',
                        body: JSON.stringify({ credentialId: id, hash }),
                    });
                    const payload = (await response.json()) as GatewayPublicVerifyResponse | { error?: { message?: string } | string };
                    if (response.ok) {
                        const verificationResult = mapGatewayVerificationResult((payload as GatewayPublicVerifyResponse).result);
                        const certificate = safeLedgerCertificateFromGateway(payload as GatewayPublicVerifyResponse);
                        const reasonMap: Record<VerificationResult, string> = {
                            valid: 'Credential hash matches the anchored proof.',
                            invalid: 'Credential verification failed.',
                            invalid_hash: 'Hash mismatch detected.',
                            revoked: 'Credential has been revoked.',
                            not_found: 'Credential proof was not found.',
                            pending_anchor: 'Credential exists off-chain but anchor is still pending.',
                            error: 'Credential verification failed.',
                        };
                        const verification = insertVerificationEvent(db, {
                            certificateId: id,
                            requestedHash: hash,
                            result: verificationResult,
                            reason: reasonMap[verificationResult],
                            verifierUserId: requester.id,
                            certificate,
                        });
                        insertAuditLog(db, {
                            actorUserId: requester.id,
                            action: 'certificate.verify',
                            entityType: 'certificate',
                            entityId: id,
                            details: { result: verification.result, verificationId: verification.id, mode: 'gateway_public_verify' },
                        });
                        res.json({
                            isValid: asBoolean((payload as GatewayPublicVerifyResponse).verified),
                            verificationId: verification.id,
                            reason: reasonMap[verificationResult],
                            result: verificationResult,
                            certificate,
                        });
                        return;
                    }
                    const message = (
                        typeof (payload as { error?: unknown }).error === 'string'
                            ? (payload as { error?: string }).error
                            : asOptionalTrimmedString((payload as { error?: { message?: string } }).error?.message)
                    ) || 'Failed to verify certificate.';
                    const verification = insertVerificationEvent(db, {
                        certificateId: id,
                        requestedHash: hash,
                        result: 'error',
                        reason: message,
                        verifierUserId: requester.id,
                        certificate: null,
                    });
                    insertAuditLog(db, {
                        actorUserId: requester.id,
                        action: 'certificate.verify',
                        entityType: 'certificate',
                        entityId: id,
                        details: { result: 'error', verificationId: verification.id, error: message, mode: 'gateway_public_verify' },
                    });
                    res.status(response.status).json({
                        isValid: false,
                        error: message,
                        verificationId: verification.id,
                        reason: message,
                    });
                    return;
                } catch {
                    // fall through to legacy local verify if gateway is unavailable
                }
            }

            let certificate: LedgerCertificate | null = null;
            try {
                const certBytes = await contract.evaluateTransaction('ReadCertificate', id);
                certificate = JSON.parse(Buffer.from(certBytes).toString()) as LedgerCertificate;
            } catch (_error) {
                certificate = null;
            }

            if (requester.role === 'student') {
                if (!certificate || certificate.studentId !== requester.studentId) {
                    res.status(403).json({ error: 'Access denied: students can only verify their own certificates.' });
                    return;
                }
            }
            if ((requester.role === 'teacher' || requester.role === 'school_admin') && certificate && requester.institutionName && certificate.university !== requester.institutionName) {
                res.status(403).json({ error: 'Access denied: this certificate belongs to another institution.' });
                return;
            }
            if (requester.role === 'teacher') {
                const issuance = getIssuanceEventByCertificateId(db, id);
                if (!issuance || issuance.issuerUserId !== requester.id) {
                    res.status(403).json({ error: 'Access denied: teachers can only verify certificates issued from their own assigned enrollments.' });
                    return;
                }
            }

            try {
                const resultBytes = await contract.evaluateTransaction('VerifyCertificate', id, hash);
                const isValid = Buffer.from(resultBytes).toString() === 'true';
                const reason = isValid ? 'Certificate hash matches the ledger.' : 'Hash mismatch detected.';
                const verification = insertVerificationEvent(db, {
                    certificateId: id,
                    requestedHash: hash,
                    result: isValid ? 'valid' : 'invalid',
                    reason,
                    verifierUserId: requester.id,
                    certificate,
                });
                insertAuditLog(db, {
                    actorUserId: requester.id,
                    action: 'certificate.verify',
                    entityType: 'certificate',
                    entityId: id,
                    details: { result: verification.result, verificationId: verification.id },
                });
                res.json({
                    isValid,
                    verificationId: verification.id,
                    reason,
                    certificate,
                });
            } catch (error) {
                const message = extractErrorMessage(error);
                const result: VerificationResult = isConnectionError(message) ? 'error' : 'invalid';
                const verification = insertVerificationEvent(db, {
                    certificateId: id,
                    requestedHash: hash,
                    result,
                    reason: message,
                    verifierUserId: requester.id,
                    certificate,
                });
                insertAuditLog(db, {
                    actorUserId: requester.id,
                    action: 'certificate.verify',
                    entityType: 'certificate',
                    entityId: id,
                    details: { result, verificationId: verification.id, error: message },
                });
                res.status(mapFabricErrorStatus(message)).json({
                    isValid: false,
                    error: message,
                    verificationId: verification.id,
                    reason: message,
                    certificate,
                });
            }
        });

        app.get('/api/verifications', authMiddleware, requireRoles('certificate_verifier', 'ministry_admin', 'super_admin'), async (req, res) => {
            const result = asTrimmedString(req.query.result) as VerificationResult;
            const validResult = ['valid', 'invalid', 'invalid_hash', 'revoked', 'not_found', 'pending_anchor', 'error'].includes(result) ? result : undefined;
            const search = asTrimmedString(req.query.search);
            const items = listVerificationEvents(db, { result: validResult ?? null, search, limit: 200 });
            res.json(items);
        });

        app.post('/api/fraud-cases', authMiddleware, requireRoles(...FRAUD_MANAGER_ROLES), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const verificationEventId = asOptionalTrimmedString(req.body?.verificationEventId);
            const certificateId = asTrimmedString(req.body?.certificateId);
            const reason = asTrimmedString(req.body?.reason);
            const notes = asTrimmedString(req.body?.notes);
            if (!verificationEventId && !certificateId) {
                res.status(400).json({ error: 'verificationEventId or certificateId is required.' });
                return;
            }
            if (!reason) {
                res.status(400).json({ error: 'reason is required.' });
                return;
            }

            const verification = verificationEventId ? getVerificationEventById(db, verificationEventId) : null;
            const resolvedCertificateId = verification?.certificateId || certificateId;
            const issuance = getIssuanceEventByCertificateId(db, resolvedCertificateId);
            const duplicate = db.prepare(`
                SELECT id FROM fraud_cases
                WHERE certificateId = ? AND status IN ('open', 'investigating')
                LIMIT 1
            `).get(resolvedCertificateId) as { id?: string } | undefined;
            if (duplicate?.id) {
                res.status(409).json({ error: 'An open fraud case already exists for this certificate.' });
                return;
            }

            const id = createId('fraud');
            const timestamp = nowIso();
            db.prepare(`
                INSERT INTO fraud_cases (
                    id, verificationEventId, certificateId, certificateHash, status, reason, notes, resolution,
                    reporterUserId, assigneeUserId, issuerUserId, institutionId, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id,
                verification?.id ?? verificationEventId,
                resolvedCertificateId,
                verification?.requestedHash ?? issuance?.hash ?? null,
                'open',
                reason,
                notes,
                '',
                requester.id,
                null,
                issuance?.issuerUserId ?? null,
                issuance?.institutionId ?? null,
                timestamp,
                timestamp,
            );
            const fraudCase = getFraudCaseById(db, id)!;
            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'fraud-case.create',
                entityType: 'fraud_case',
                entityId: id,
                details: { certificateId: resolvedCertificateId, verificationEventId: verification?.id ?? null },
            });
            res.status(201).json(fraudCase);
        });

        app.get('/api/fraud-cases', authMiddleware, requireRoles(...FRAUD_MANAGER_ROLES), async (req, res) => {
            const status = normalizeFraudStatus(req.query.status);
            const search = asTrimmedString(req.query.search);
            res.json(listFraudCases(db, { status, search, limit: 200 }));
        });

        app.patch('/api/fraud-cases/:id', authMiddleware, requireRoles(...FRAUD_MANAGER_ROLES), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const fraudCase = getFraudCaseById(db, asTrimmedString(req.params.id));
            if (!fraudCase) {
                res.status(404).json({ error: 'Fraud case not found.' });
                return;
            }

            const status = normalizeFraudStatus(req.body?.status) || fraudCase.status;
            const notes = asTrimmedString(req.body?.notes) || fraudCase.notes;
            const resolution = asTrimmedString(req.body?.resolution) || fraudCase.resolution;
            const assigneeUserId = asOptionalTrimmedString(req.body?.assigneeUserId) ?? fraudCase.assigneeUserId ?? requester.id;
            const suspendIssuer = asBoolean(req.body?.suspendIssuer);
            const suspendInstitution = asBoolean(req.body?.suspendInstitution);
            const updatedAt = nowIso();

            db.prepare(`
                UPDATE fraud_cases
                SET status = ?, notes = ?, resolution = ?, assigneeUserId = ?, updatedAt = ?
                WHERE id = ?
            `).run(status, notes, resolution, assigneeUserId, updatedAt, fraudCase.id);

            if (suspendIssuer && fraudCase.issuerUserId) {
                db.prepare('UPDATE users SET status = ?, updatedAt = ? WHERE id = ?').run('suspended', updatedAt, fraudCase.issuerUserId);
                insertAuditLog(db, {
                    actorUserId: requester.id,
                    action: 'user.suspend',
                    entityType: 'user',
                    entityId: fraudCase.issuerUserId,
                    details: { fraudCaseId: fraudCase.id },
                });
            }
            if (suspendInstitution && fraudCase.institutionId) {
                db.prepare('UPDATE institutions SET status = ?, updatedAt = ? WHERE id = ?').run('suspended', updatedAt, fraudCase.institutionId);
                insertAuditLog(db, {
                    actorUserId: requester.id,
                    action: 'institution.suspend',
                    entityType: 'institution',
                    entityId: fraudCase.institutionId,
                    details: { fraudCaseId: fraudCase.id },
                });
            }

            insertAuditLog(db, {
                actorUserId: requester.id,
                action: 'fraud-case.update',
                entityType: 'fraud_case',
                entityId: fraudCase.id,
                details: { status, suspendIssuer, suspendInstitution },
            });
            res.json(getFraudCaseById(db, fraudCase.id));
        });

        app.get(['/api/audits', '/api/v1/audit'], authMiddleware, requireRoles('school_admin', 'ministry_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const action = asTrimmedString(req.query.action);
            const entityType = asTrimmedString(req.query.entityType);
            const search = asTrimmedString(req.query.search);
            const filters: { action?: string; entityType?: string; search?: string; limit?: number } = { limit: 200 };
            if (action) filters.action = action;
            if (entityType) filters.entityType = entityType;
            if (search) filters.search = search;
            const institutionIdQuery = asOptionalTrimmedString(req.query.institutionId);
            const scopedInstitutionId = requester.role === 'school_admin'
                ? requester.institutionId
                : institutionIdQuery;
            const items = scopedInstitutionId
                ? listInstitutionAuditLogs(db, scopedInstitutionId, filters)
                : listAuditLogs(db, filters);
            res.json(items);
        });

        app.get(['/api/network/status', '/api/v1/network/status'], authMiddleware, requireRoles('school_admin', 'certificate_verifier', 'ministry_admin', 'super_admin'), async (_req, res) => {
            res.json(await collectNetworkStatus(contract));
        });

        app.get(['/api/reports/summary', '/api/v1/reports/summary'], authMiddleware, requireRoles('school_admin', 'ministry_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const { from, to } = normalizeDateRange(req.query);
            const institutionId = requester.role === 'school_admin'
                ? requester.institutionId
                : asOptionalTrimmedString(req.query.institutionId);
            res.json(buildReportSummary(db, from, to, institutionId));
        });

        app.get(['/api/reports/export', '/api/v1/reports/export'], authMiddleware, requireRoles('school_admin', 'ministry_admin', 'super_admin'), async (req, res) => {
            const requester = (req as AuthenticatedRequest).user!;
            const type = normalizeReportType(req.query.type);
            const format = normalizeReportFormat(req.query.format);
            const { from, to } = normalizeDateRange(req.query);
            const institutionId = requester.role === 'school_admin'
                ? requester.institutionId
                : asOptionalTrimmedString(req.query.institutionId);
            const dataset = queryReportDataset(db, type, from, to, institutionId);
            const filename = reportFilename(type, format);

            if (format === 'csv') {
                const csv = datasetToCsv(dataset);
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                res.send(csv);
                return;
            }

            const pdfBuffer = await datasetToPdfBuffer(dataset);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(pdfBuffer);
        });

        app.listen(port, host, () => {
            console.log(`Blockchain Node bridge running at http://${host}:${port}`);
            console.log(`Operational SQLite DB ready at ${operationsDbPath}`);
        });
    } catch (error) {
        console.error('Failed to run application:', error);
    }
}

async function newGrpcConnection(): Promise<grpc.Client> {
    const tlsRootCert = await fs.readFile(tlsCertPath);
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(peerEndpoint, tlsCredentials, {
        'grpc.ssl_target_name_override': peerHostAlias,
    });
}

async function newIdentity(): Promise<Identity> {
    const credentials = await fs.readFile(certPath);
    return { mspId, credentials };
}

async function newSigner(): Promise<Signer> {
    const privateKeyPem = await fs.readFile(keyPath);
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return signers.newPrivateKeySigner(privateKey);
}

main().catch(console.error);
